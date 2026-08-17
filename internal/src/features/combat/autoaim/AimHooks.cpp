#include "pch-il2cpp.h"

#include "AimHooks.h"
#include "WeaponProfile.h"
#include "GameState.h"
#include "RuntimeOffsets.h"
#include "Il2CppResolver.h"
#include "core/runtime/MemRead.h"
#include "platform/hooks/Il2CppHook.h"
#include "minhook/MinHook.h"

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

// shotData+0x1C is the angle field in the SHOOT packet struct
static constexpr uint32_t kOffShotAngle = 0x1C;

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

static bool ShouldRedirect(void* player)
{
    if (!s_enabled.load(std::memory_order_relaxed)) return false;
    if (!s_hasTarget.load(std::memory_order_relaxed)) return false;
    if (!Mem::AddrOk(player)) return false;
    void* local = GameState::GetLocalPtr();
    return local && player == local;
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

    *outAngle = ApplyWeaponTweaks(atan2f(
        s_targetY.load(std::memory_order_relaxed) - py,
        s_targetX.load(std::memory_order_relaxed) - px));
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
        if (ok) {
            angle = ApplyWeaponTweaks(atan2f(
                s_targetY.load(std::memory_order_relaxed) - py,
                s_targetX.load(std::memory_order_relaxed) - px));
        }
    }
    g_swaOrig(player, angle, method);
}

void __fastcall SendShotPacketDetour(void* player, void* shotData, int32_t projCount, void* method)
{
    if (ShouldRedirect(player) && Mem::AddrOk(shotData) &&
        Mem::AddrOk(reinterpret_cast<const uint8_t*>(shotData) + 0x24) && projCount > 0)
    {
        float px = 0.f, py = 0.f;
        bool ok = false;
        __try {
            uint8_t* lp = reinterpret_cast<uint8_t*>(player);
            px = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosX);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            py = *reinterpret_cast<float*>(lp + RuntimeOffsets::PosY);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
            ok = true;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
        if (ok) {
            const float newAngle = ApplyWeaponTweaks(atan2f(
                s_targetY.load(std::memory_order_relaxed) - py,
                s_targetX.load(std::memory_order_relaxed) - px));
            Mem::TryWrite<float>(shotData, kOffShotAngle, newAngle);
            __try {
                *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(player) +
                    RuntimeOffsets::Player_FacingAngle) = newAngle;
            } __except (EXCEPTION_EXECUTE_HANDLER) {}
        }
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

    static bool s_mhInit = false;
    if (!s_mhInit) {
        MH_STATUS st = MH_Initialize();
        if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;
        s_mhInit = true;
    }

    if (!Il2CppHook::InstallMinHook(g_csaTarget, reinterpret_cast<void*>(&ComputeShootAngleDetour),
                                    reinterpret_cast<void**>(&g_csaOrig), "AutoAim.CSA")) return false;
    if (!Il2CppHook::InstallMinHook(g_swaTarget, reinterpret_cast<void*>(&ShootWithAngleDetour),
                                    reinterpret_cast<void**>(&g_swaOrig), "AutoAim.SWA")) return false;
    if (!Il2CppHook::InstallMinHook(g_sspTarget, reinterpret_cast<void*>(&SendShotPacketDetour),
                                    reinterpret_cast<void**>(&g_sspOrig), "AutoAim.SSP")) return false;

    s_installed = true;
    return true;
}

void Uninstall()
{
    if (!s_installed) return;
    s_enabled.store(false, std::memory_order_release);
    if (g_csaTarget) { MH_DisableHook(g_csaTarget); MH_RemoveHook(g_csaTarget); }
    if (g_swaTarget) { MH_DisableHook(g_swaTarget); MH_RemoveHook(g_swaTarget); }
    if (g_sspTarget) { MH_DisableHook(g_sspTarget); MH_RemoveHook(g_sspTarget); }
    g_csaOrig = nullptr; g_swaOrig = nullptr; g_sspOrig = nullptr;
    g_csaTarget = g_swaTarget = g_sspTarget = nullptr;
    s_installed = false;
}

bool IsInstalled() { return s_installed; }

void SetTarget(bool hasTarget, float x, float y)
{
    s_hasTarget.store(hasTarget, std::memory_order_relaxed);
    s_targetX.store(x, std::memory_order_relaxed);
    s_targetY.store(y, std::memory_order_relaxed);
    s_enabled.store(true, std::memory_order_relaxed);
}

void SetReverseCultStaff(bool v)   { s_reverseCultStaff.store(v, std::memory_order_relaxed); }
void SetOffsetColossusSword(bool v) { s_offsetColossus.store(v, std::memory_order_relaxed); }

} // namespace AimHooks
