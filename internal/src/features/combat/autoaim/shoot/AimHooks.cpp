#include "pch-il2cpp.h"

#include "features/combat/autoaim/shoot/AimHooks.h"
#include "features/combat/autoaim/core/WeaponProfile.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include "core/runtime/MemRead.h"
#include "platform/hooks/Il2CppHook.h"
#include "DbgFileLog.h"

#include <Windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

// ── IL2CPP method names ───────────────────────────────────────────────────────
static const char* kPlayerClass   = "LKHPPBEGNOM";
static const char* kShootClass    = "FKALGHJIADI";
static const char* kCSAMethod     = "ELCBJAFBLJG"; // ComputeShootAngle
static const char* kSWAMethod     = "EHGHCACPAGH"; // ShootWithAngle
static const char* kSSPMethod     = "PMIANFBMMNN"; // SendShotPacket

// ── Weapon-specific proj IDs ──────────────────────────────────────────────────
static constexpr int32_t kProjIdCultStaff    = 0xB0EB; // Staff of Unholy Sacrifice
static constexpr int32_t kProjIdColossusSlash = 0xB106; // Sword of the Colossus

// ── Shared aim state (written each tick by AutoAim coordinator) ───────────────
static std::atomic<bool>  s_hasTarget{ false };
static std::atomic<float> s_targetX{ 0.f };
static std::atomic<float> s_targetY{ 0.f };
static std::atomic<bool>  s_reverseCultStaff{ true };
static std::atomic<bool>  s_offsetColossus{ false };
static std::atomic<bool>  s_enabled{ false };

// ── KillAura override slot (see the precedence note in AimHooks.h) ────────────
// Deliberately independent of s_enabled: killaura drives the angle whether or
// not AutoAim's master toggle is on.
static std::atomic<bool>    s_kaActive{ false };
static std::atomic<float>   s_kaX{ 0.f };
static std::atomic<float>   s_kaY{ 0.f };
static std::atomic<int32_t> s_kaTargetId{ 0 };

// ── Hook function-pointer types ───────────────────────────────────────────────
using ComputeShootAngleFn = void(__fastcall*)(void*, uint8_t, float*, bool*, bool, void*);
using ShootWithAngleFn    = void(__fastcall*)(void*, float, void*);
using SendShotPacketFn    = void(__fastcall*)(void*, void*, int32_t, void*);

static ComputeShootAngleFn g_csaOrig = nullptr;
static ShootWithAngleFn    g_swaOrig = nullptr;
static SendShotPacketFn    g_sspOrig = nullptr;
static void* g_csaTarget = nullptr;
static void* g_swaTarget = nullptr;
static void* g_sspTarget = nullptr;
static bool  s_installed = false;

static float ApplyWeaponTweaks(float angle)
{
    const int32_t pid = WeaponCalibrator::GetProfile().projId;
    if (s_reverseCultStaff.load(std::memory_order_relaxed) && pid == kProjIdCultStaff)
        angle += 3.14159265f;
    if (s_offsetColossus.load(std::memory_order_relaxed) && pid == kProjIdColossusSlash)
        angle += 0.f; // TODO: extract exact offset from Multitool DLL
    return angle;
}

// Resolves the aim-source precedence documented in AimHooks.h. False when
// nothing is driving the angle.
static bool CurrentAim(float& tx, float& ty)
{
    if (s_kaActive.load(std::memory_order_relaxed)) {
        tx = s_kaX.load(std::memory_order_relaxed);
        ty = s_kaY.load(std::memory_order_relaxed);
        return true;
    }
    if (s_enabled.load(std::memory_order_relaxed) &&
        s_hasTarget.load(std::memory_order_relaxed)) {
        tx = s_targetX.load(std::memory_order_relaxed);
        ty = s_targetY.load(std::memory_order_relaxed);
        return true;
    }
    return false;
}

static bool ShouldRedirect(void* player)
{
    float tx = 0.f, ty = 0.f;
    if (!CurrentAim(tx, ty)) return false;
    if (!Mem::AddrOk(player)) return false;
    void* local = GameState::GetLocalPtr();
    return local && player == local;
}

// The ONE redirect formula, shared by all three detours: aim from the player's
// REAL position at whichever source currently owns the angle. False when the
// source went away between ShouldRedirect and here (benign race — the shot is
// then left alone rather than fired at a stale point).
static bool RedirectAngle(float px, float py, float& outAngle)
{
    float tx = 0.f, ty = 0.f;
    if (!CurrentAim(tx, ty)) return false;
    outAngle = ApplyWeaponTweaks(atan2f(ty - py, tx - px));
    return true;
}

// ── Aim-source witness ────────────────────────────────────────────────────────
//
//   GREP THE TRACE LOG FOR:  [AimHooks] aim source
//
// Transition-only. The setters below are called at tick rate (KillAura::Tick
// refreshes at up to ~125 Hz), so this logs ONLY when the source actually
// changes — which is exactly the question the log has to answer: is the angle
// currently being driven by killaura, by AutoAim's own target, or by neither?
// std::atomic exchange rather than a plain static: SetTarget is reachable from
// the IPC thread via AutoAim::SetEnabled, and a lost race here would cost at
// most one duplicate line.
static std::atomic<int> s_lastLoggedSrc{ -1 };

static void NoteAimSource()
{
    const bool ka  = s_kaActive.load(std::memory_order_relaxed);
    const bool aim = s_enabled.load(std::memory_order_relaxed) &&
                     s_hasTarget.load(std::memory_order_relaxed);
    const int src = ka ? 2 : (aim ? 1 : 0);
    if (s_lastLoggedSrc.exchange(src, std::memory_order_relaxed) == src) return;

    if (src == 2) {
        DBG_FILE_LOG("[AimHooks] aim source -> KILLAURA (shot angle points at killaura's pick, targetId="
                     << s_kaTargetId.load(std::memory_order_relaxed) << ")");
    } else if (src == 1) {
        DBG_FILE_LOG("[AimHooks] aim source -> AUTOAIM (shot angle points at AutoAim's own target)");
    } else {
        DBG_FILE_LOG("[AimHooks] aim source -> NONE (no redirect; the game's own shot angle stands)");
    }
}

// ── Detour implementations ────────────────────────────────────────────────────
void __fastcall ComputeShootAngleDetour(
    void* player, uint8_t slot, float* outAngle, bool* outCanShoot, bool boolArg, void* method)
{
    g_csaOrig(player, slot, outAngle, outCanShoot, boolArg, method);
    if (!ShouldRedirect(player) || !outAngle) return;

    float px = 0.f, py = 0.f;
    __try {
        uint8_t* lp = reinterpret_cast<uint8_t*>(player);
        px = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        py = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) { return; }

    float newAngle = 0.f;
    if (RedirectAngle(px, py, newAngle))
        *outAngle = newAngle;
}

void __fastcall ShootWithAngleDetour(void* player, float angle, void* method)
{
    if (ShouldRedirect(player)) {
        float px = 0.f, py = 0.f;
        bool ok = false;
        __try {
            uint8_t* lp = reinterpret_cast<uint8_t*>(player);
            px = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            py = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            ok = true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        float newAngle = 0.f;
        if (ok && RedirectAngle(px, py, newAngle))
            angle = newAngle;
    }
    g_swaOrig(player, angle, method);
}

// This detour does NOT touch `shotData`, by design.
//
// It used to write `shotData + RuntimeOffsets::Shot_Angle (0x1C)`. Plan 108
// (docs/plans/108-shot-angle-field-identification.md) proved the 2nd parameter's
// declared type is NKMHEINLOCD — a UniqueDataContainer whose total object size
// is 0x18 — so that write landed 4 bytes PAST the end of a managed object, on
// the next GC allocation's header, silently (Mem::TryWrite is SEH-guarded, so
// it corrupted instead of faulting). The `Mem::AddrOk(shotData + 0x24)` probe
// that "guarded" it only range-checked a pointer and always passed.
//
// It was also redundant. The redirect is carried entirely by the two clean
// paths above — ComputeShootAngleDetour's `*outAngle` out-parameter and
// ShootWithAngleDetour's by-value angle argument — and the game builds the shot
// (and its packet) from that angle. `Mem::AddrOk(shotData) && projCount > 0`
// survives only as an argument-plausibility gate on the facing write below.
//
// All that remains is Player_FacingAngle, which is table-resolved and correct
// (RuntimeOffsets.cpp), and cosmetic: it turns the sprite to match the shot.
void __fastcall SendShotPacketDetour(void* player, void* shotData, int32_t projCount, void* method)
{
    if (ShouldRedirect(player) && Mem::AddrOk(shotData) && projCount > 0)
    {
        float px = 0.f, py = 0.f;
        bool ok = false;
        __try {
            uint8_t* lp = reinterpret_cast<uint8_t*>(player);
            px = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            py = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            ok = true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        float newAngle = 0.f;
        if (ok && RedirectAngle(px, py, newAngle))
            Mem::TryWrite<float>(player, RuntimeOffsets::Player_FacingAngle, newAngle);
    }
    g_sspOrig(player, shotData, projCount, method);
}

} // namespace

namespace AimHooks {

bool Install()
{
    if (s_installed) return true;

    // kPlayerClass / kShootClass are BeeByte-obfuscated tokens matched exactly
    // (loose=false → Resolver::GetClass, identical to the prior local resolver).
    g_csaTarget = Il2CppHook::ResolveMethod(kPlayerClass, kCSAMethod, 4, /*loose*/false);
    g_swaTarget = Il2CppHook::ResolveMethod(kShootClass,  kSWAMethod, 1, /*loose*/false);
    g_sspTarget = Il2CppHook::ResolveMethod(kShootClass,  kSSPMethod, 2, /*loose*/false);
    if (!g_csaTarget || !g_swaTarget || !g_sspTarget) return false;

    if (!Il2CppHook::EnsureRuntime("AutoAim")) return false;

    if (!Il2CppHook::InstallMinHook(g_csaTarget, reinterpret_cast<void*>(&ComputeShootAngleDetour),
                                    reinterpret_cast<void**>(&g_csaOrig), "AutoAim.CSA")) return false;
    if (!Il2CppHook::InstallMinHook(g_swaTarget, reinterpret_cast<void*>(&ShootWithAngleDetour),
                                    reinterpret_cast<void**>(&g_swaOrig), "AutoAim.SWA")) return false;
    if (!Il2CppHook::InstallMinHook(g_sspTarget, reinterpret_cast<void*>(&SendShotPacketDetour),
                                    reinterpret_cast<void**>(&g_sspOrig), "AutoAim.SSP")) return false;

    s_installed = true;
    // One-shot (Install self-guards on s_installed): says out loud what this
    // module does, so a trace log is never ambiguous about the mechanism.
    DBG_FILE_LOG("[AimHooks] installed — shot redirect is ANGLE-ONLY: the bullet leaves the"
                 " player's real position, only its direction changes (CSA out-param + SWA"
                 " by value). No shot-packet field is written.");
    return true;
}

void Uninstall()
{
    if (!s_installed) return;
    s_enabled.store(false, std::memory_order_release);
    s_kaActive.store(false, std::memory_order_release);
    NoteAimSource();
    Il2CppHook::UninstallMinHook(g_csaTarget, "AutoAim.CSA");
    Il2CppHook::UninstallMinHook(g_swaTarget, "AutoAim.SWA");
    Il2CppHook::UninstallMinHook(g_sspTarget, "AutoAim.SSP");
    g_csaOrig = nullptr; g_swaOrig = nullptr; g_sspOrig = nullptr;
    s_installed = false;
}

bool IsInstalled() { return s_installed; }

void SetTarget(bool hasTarget, float x, float y)
{
    s_hasTarget.store(hasTarget, std::memory_order_relaxed);
    s_targetX.store(x, std::memory_order_relaxed);
    s_targetY.store(y, std::memory_order_relaxed);
    s_enabled.store(true, std::memory_order_relaxed);
    NoteAimSource();
}

void SetKillAuraOverride(bool active, float x, float y, int32_t enemyId)
{
    s_kaX.store(x, std::memory_order_relaxed);
    s_kaY.store(y, std::memory_order_relaxed);
    s_kaTargetId.store(active ? enemyId : 0, std::memory_order_relaxed);
    // Store the coordinates BEFORE arming so the detours can never read a live
    // flag against a stale point.
    s_kaActive.store(active, std::memory_order_relaxed);
    NoteAimSource();
}

void SetReverseCultStaff(bool v)   { s_reverseCultStaff.store(v, std::memory_order_relaxed); }
void SetOffsetColossusSword(bool v) { s_offsetColossus.store(v, std::memory_order_relaxed); }

} // namespace AimHooks
