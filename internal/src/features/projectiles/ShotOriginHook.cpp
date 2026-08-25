#include "pch-il2cpp.h"

#include "features/projectiles/ShotOriginHook.h"

#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "MemRead.h"
#include "DbgFileLog.h"
#include "game/symbols/GameClasses.h"

#include <windows.h>
#include <atomic>
#include <cstring>

namespace {

// ── The target ───────────────────────────────────────────────────────────────
// KJMONHENJEN is the world-entity base class (Projectile / HBEAKBIHANL derives
// from it and does NOT override this method, so a projectile's position write
// lands here). BDEBGEHBPCJ(float,float) -> bool is the position setter.
//
// UNIQUENESS TRAP: LKFFPGONEOB carries a method with the SAME obfuscated name
// AND the same signature at a different address in this build. Binding by bare
// name would be a coin flip that corrupts unrelated objects, so resolution
// below walks KJMONHENJEN's OWN method table and demands exactly one match.
static const char* kEntityClass   = "KJMONHENJEN";
static const char* kSetPosMethod  = "BDEBGEHBPCJ";
static constexpr int kSetPosArgc  = 2;

// Dump-time RVA of KJMONHENJEN::BDEBGEHBPCJ (il2cpp-functions.h). WITNESS ONLY
// — never a gate: RVAs shift on every game patch, while the class+signature
// match above stays valid. A mismatch here means the generated headers are from
// a different build than the running game; the log says so out loud.
static constexpr uintptr_t kSetPosRvaAtDump = 0x013E56A0;

using SetPositionFn = bool(__fastcall*)(void* self, float x, float y, void* method);

static SetPositionFn g_orig      = nullptr;
static void*         g_target    = nullptr;
static bool          g_installed = false;
static bool          g_refused   = false;   // permanent: ambiguous / wrong signature

static std::atomic<uint32_t> g_arms{ 0 };
static std::atomic<uint32_t> g_rewrites{ 0 };
static std::atomic<uint32_t> g_drops{ 0 };

// ── One-shot override slot ───────────────────────────────────────────────────
// thread_local: armed by the spawn detour and consumed by the position setter,
// both on the game thread. A slot that is not consumed by the very next setter
// call is DROPPED, so an override can never leak onto a later projectile.
struct Pending {
    void*   proj  = nullptr;
    int32_t owner = 0;
    float   x     = 0.f;
    float   y     = 0.f;
};
static thread_local Pending t_pending;

// ── Witnesses (transition-only / rate-limited — never per-frame) ─────────────
//
//   GREP THE TRACE LOG FOR:  [ShotOriginHook]
//
// The whole reason the original bug survived is that "[KillAura] ARMED" and
// "killaura actually moved the bullet" were indistinguishable. These three
// lines separate them: INSTALLED/REFUSED says whether the mechanism exists at
// all, REWRITTEN says a real local bullet was moved (with owner + absolute
// origin), and DROPPED says the override was armed but the projectile's setter
// never came — armed, not moved.
static ULONGLONG g_lastRewriteLogMs = 0;
static int       g_lastOutcome      = -1;   // -1 none yet, 0 dropped, 1 rewritten

static void WitnessOutcome(int outcome, void* proj, int32_t owner, float ax, float ay)
{
    const ULONGLONG now = GetTickCount64();
    const bool changed  = (outcome != g_lastOutcome);
    // Transition always logs; a steady stream of rewrites heartbeats at 5 s so a
    // live session shows the mechanism still firing without per-shot disk I/O.
    if (!changed && (now - g_lastRewriteLogMs) < 5000ULL) return;
    g_lastOutcome      = outcome;
    g_lastRewriteLogMs = now;

    if (outcome == 1) {
        DBG_FILE_LOG("[ShotOriginHook] local bullet origin REWRITTEN proj=" << proj
            << " owner=" << owner
            << " -> abs=(" << ax << "," << ay << ")"
            << " arms=" << g_arms.load(std::memory_order_relaxed)
            << " rewrites=" << g_rewrites.load(std::memory_order_relaxed)
            << " drops=" << g_drops.load(std::memory_order_relaxed));
    } else {
        DBG_FILE_LOG("[ShotOriginHook] armed override DROPPED — the first position "
            "setter after the spawn funnel was a DIFFERENT object, so this shot was "
            "NOT moved (killaura aimed but the bullet left the muzzle)"
            << " arms=" << g_arms.load(std::memory_order_relaxed)
            << " rewrites=" << g_rewrites.load(std::memory_order_relaxed)
            << " drops=" << g_drops.load(std::memory_order_relaxed));
    }
}

// ── Detour ───────────────────────────────────────────────────────────────────
// HOT: every world object's position write goes through here. The fast path is
// one thread_local load and a branch — no locks, no IL2CPP calls, no logging.
bool __fastcall SetPositionDetour(void* self, float x, float y, void* method)
{
    void* const want = t_pending.proj;
    if (want) {
        const int32_t owner = t_pending.owner;
        const float   ax    = t_pending.x;
        const float   ay    = t_pending.y;
        t_pending.proj = nullptr;   // one-shot: consumed OR dropped, never carried
        if (want == self) {
            x = ax;
            y = ay;
            g_rewrites.fetch_add(1, std::memory_order_relaxed);
            WitnessOutcome(1, self, owner, ax, ay);
        } else {
            g_drops.fetch_add(1, std::memory_order_relaxed);
            WitnessOutcome(0, self, owner, ax, ay);
        }
    }
    return g_orig(self, x, y, method);
}

// ── Resolution (fail-closed) ─────────────────────────────────────────────────
// Walks KJMONHENJEN's OWN method table instead of asking for a method by name,
// because the point is to PROVE uniqueness: exactly one method declared on this
// class, named BDEBGEHBPCJ, taking two floats and returning bool. Anything else
// (zero matches, two matches, an inherited declaration) refuses the install.
static const MethodInfo* ResolveSetPosition(const char** outWhy, int* outCandidates)
{
    *outWhy        = "unknown";
    *outCandidates = 0;

    Il2CppClass* klass = GameClasses::Resolve(kEntityClass, kEntityClass);
    if (!klass) {
        *outWhy = "entity base class KJMONHENJEN unresolved (BeeByte name stale?)";
        return nullptr;
    }

    const MethodInfo* found = nullptr;
    int candidates = 0;
    int sameName   = 0;

    Resolver::Protection::safe_call([&]() {
        void* iter = nullptr;
        while (const MethodInfo* mi = il2cpp_class_get_methods(klass, &iter)) {
            const char* name = il2cpp_method_get_name(mi);
            if (!name || strcmp(name, kSetPosMethod) != 0) continue;
            ++sameName;
            if (mi->klass != klass) continue;                       // not declared here
            if (mi->parameters_count != kSetPosArgc) continue;
            if (!mi->parameters || !mi->parameters[0] || !mi->parameters[1]) continue;
            if (mi->parameters[0]->type != IL2CPP_TYPE_R4) continue;
            if (mi->parameters[1]->type != IL2CPP_TYPE_R4) continue;
            if (!mi->return_type || mi->return_type->type != IL2CPP_TYPE_BOOLEAN) continue;
            if (!mi->methodPointer) continue;
            ++candidates;
            found = mi;
        }
    });

    *outCandidates = candidates;
    if (candidates == 1) {
        *outWhy = "ok";
        return found;
    }
    *outWhy = (candidates == 0)
        ? (sameName == 0 ? "no method named BDEBGEHBPCJ on KJMONHENJEN"
                         : "BDEBGEHBPCJ found but signature is not (float,float)->bool")
        : "AMBIGUOUS — more than one matching BDEBGEHBPCJ on KJMONHENJEN";
    return nullptr;
}

} // namespace

namespace ShotOriginHook {

bool Install()
{
    if (g_installed) return true;
    if (g_refused)   return false;   // permanent, already logged once

    const char* why = "unknown";
    int candidates  = 0;
    const MethodInfo* mi = ResolveSetPosition(&why, &candidates);
    if (!mi) {
        if (candidates > 1) {
            // Ambiguity is NOT retryable — retrying resolves the same ambiguity
            // and hooking either candidate corrupts unrelated objects.
            g_refused = true;
            DBG_FILE_LOG("[ShotOriginHook] REFUSED to install — " << why
                << " (candidates=" << candidates << "). Killaura will NOT move the "
                "local bullet, so no ENEMYHIT and no damage.");
        } else {
            // Class/method not there YET (loads lazily) — stay retryable, but do
            // not spam: one line every 240 attempts, same idiom as the other
            // lazily-installed hooks.
            static int s_n = 0;
            if ((s_n++ % 240) == 0)
                DBG_FILE_LOG("[ShotOriginHook] not installed — " << why
                    << " (attempt=" << s_n << "). Killaura cannot move the local bullet yet.");
        }
        return false;
    }

    g_target = reinterpret_cast<void*>(mi->methodPointer);
    g_orig   = reinterpret_cast<SetPositionFn>(g_target);

    if (!Il2CppHook::EnsureRuntime("ShotOriginHook")) return false;
    if (!Il2CppHook::InstallMinHook(g_target,
            reinterpret_cast<void*>(&SetPositionDetour),
            reinterpret_cast<void**>(&g_orig),
            "ShotOriginHook.SetPos")) {
        g_target = nullptr;
        g_orig   = nullptr;
        return false;
    }

    g_installed = true;

    // Witness the bind itself, including the dump-RVA cross-check. This is the
    // line that proves WHICH BDEBGEHBPCJ we bound (LKFFPGONEOB's twin sits at
    // 0x010CFF50; ours must be 0x013E56A0 for the header build).
    const HMODULE ga = GetModuleHandleA("GameAssembly.dll");
    const uintptr_t rva = ga ? (reinterpret_cast<uintptr_t>(g_target) - reinterpret_cast<uintptr_t>(ga))
                             : 0;
    DBG_FILE_LOG("[ShotOriginHook] INSTALLED KJMONHENJEN::BDEBGEHBPCJ(float,float)->bool"
        << " candidates=" << candidates
        << " rva=0x" << std::hex << rva << " (dump 0x" << kSetPosRvaAtDump << std::dec << ", "
        << (rva == kSetPosRvaAtDump ? "match" : "DIFFERS — generated headers are from another game build")
        << ") — killaura local-bullet origin rewrite ACTIVE");
    return true;
}

void Uninstall()
{
    if (!g_installed) return;
    Il2CppHook::UninstallMinHook(g_target, "ShotOriginHook.SetPos");
    g_orig         = nullptr;
    g_installed    = false;
    t_pending.proj = nullptr;
}

bool IsInstalled() { return g_installed; }

void ArmOneShot(void* projectile, int32_t ownerObjId, float absX, float absY)
{
    if (!g_installed) return;                 // fail-closed: no hook, no override
    if (!Mem::AddrOk(projectile)) return;
    t_pending.proj  = projectile;
    t_pending.owner = ownerObjId;
    t_pending.x     = absX;
    t_pending.y     = absY;
    g_arms.fetch_add(1, std::memory_order_relaxed);
}

Stats GetStats()
{
    Stats s;
    s.installed = g_installed;
    s.refused   = g_refused;
    s.arms      = g_arms.load(std::memory_order_relaxed);
    s.rewrites  = g_rewrites.load(std::memory_order_relaxed);
    s.drops     = g_drops.load(std::memory_order_relaxed);
    return s;
}

} // namespace ShotOriginHook
