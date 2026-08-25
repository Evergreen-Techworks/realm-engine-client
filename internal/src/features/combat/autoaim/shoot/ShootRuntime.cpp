#include "pch-il2cpp.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"

#include "platform/hooks/Il2CppHook.h"
#include "DbgFileLog.h"

#include <cstdio>
#include <windows.h>

namespace {

// ── IL2CPP method names ───────────────────────────────────────────────────────
// These are the SAME tokens AimHooks.cpp:20-24 hooks. AimHooks HOOKS them,
// ShootRuntime CALLS them — those are the only two files allowed to name them.
static const char* kPlayerClass = "LKHPPBEGNOM";
static const char* kShootClass  = "FKALGHJIADI";
static const char* kCSAMethod   = "ELCBJAFBLJG"; // ComputeShootAngle
static const char* kSWAMethod   = "EHGHCACPAGH"; // ShootWithAngle

using ComputeShootAngleFn = void(__fastcall*)(void*, uint8_t, float*, bool*, bool, void*);
using ShootWithAngleFn    = void(__fastcall*)(void*, float, void*);

ComputeShootAngleFn s_fnCSA = nullptr;
ShootWithAngleFn    s_fnSWA = nullptr;
const MethodInfo*   s_miSWA = nullptr;
bool s_csaResolved = false;
bool s_swaResolved = false;

void ResolveCSA()
{
    if (s_csaResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached(kPlayerClass, kCSAMethod, 4, /*loose*/false);
    if (!mi) return;
    s_fnCSA = reinterpret_cast<ComputeShootAngleFn>(mi->methodPointer);
    s_csaResolved = true;
}

void ResolveSWA()
{
    if (s_swaResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached(kShootClass, kSWAMethod, 1, /*loose*/false);
    if (!mi) return;
    s_fnSWA = reinterpret_cast<ShootWithAngleFn>(mi->methodPointer);
    s_miSWA = mi;
    s_swaResolved = true;
}

// EHGHCACPAGH (ShootWithAngle) is virtual — the live player can be a
// FKALGHJIADI subclass whose override differs from the impl we bound at resolve
// time. Re-dispatch through the object's own vtable, caching per live class so
// the il2cpp lookup runs once per class, not per frame. Falls back to the bound
// FKALGHJIADI impl if anything about the lookup is off.
// (Mirrors DodgeRuntime's ResolveMoveToForObject, MovementRuntime.cpp:44-67.)
ShootWithAngleFn ResolveShootWithAngleForObject(void* player)
{
    static void*             s_cachedKlass = nullptr;
    static ShootWithAngleFn  s_cachedFn    = nullptr;

    if (!s_miSWA) return s_fnSWA;
    void* klass = nullptr;
    __try { klass = *reinterpret_cast<void**>(player); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return s_fnSWA; }
    if (!klass) return s_fnSWA;
    if (klass == s_cachedKlass && s_cachedFn) return s_cachedFn;

    ShootWithAngleFn fn = s_fnSWA;
    __try {
        const MethodInfo* mi = il2cpp_object_get_virtual_method(
            reinterpret_cast<Il2CppObject*>(player), s_miSWA);
        if (mi && mi->methodPointer)
            fn = reinterpret_cast<ShootWithAngleFn>(mi->methodPointer);
    } __except (EXCEPTION_EXECUTE_HANDLER) { fn = s_fnSWA; }

    s_cachedKlass = klass;
    s_cachedFn    = fn;
    return fn;
}

void LogBindingOnce()
{
    static bool s_logged = false;
    if (s_logged) return;
    s_logged = true;
    char buf[192];
    snprintf(buf, sizeof(buf),
             "[ShootRuntime] bound CSA=%p SWA=%p (called, not hooked; AimHooks detours both)",
             reinterpret_cast<void*>(s_fnCSA), reinterpret_cast<void*>(s_fnSWA));
    DbgFileLogWrite(buf);
}

} // namespace

namespace ShootRuntime {

bool EnsureResolved()
{
    ResolveCSA();
    ResolveSWA();
    if (s_fnCSA && s_fnSWA) { LogBindingOnce(); return true; }
    return false;
}

bool IsResolved() { return s_fnCSA != nullptr && s_fnSWA != nullptr; }

bool TryComputeShootAngle(void* player, uint8_t slot, float& outAngle, bool& outCanShoot)
{
    if (!s_fnCSA || !player) return false;

    // The 5th parameter (CPINCMGNBOO in the dump) is unidentified; false is the
    // fail-closed choice. If outCanShoot never goes true in-game with a weapon
    // equipped and no cooldown, try true and record the finding here.
    float angle    = 0.f;
    bool  canShoot = false;
    __try {
        s_fnCSA(player, slot, &angle, &canShoot, false, nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }

    outAngle    = angle;
    outCanShoot = canShoot;
    return true;
}

bool CallShootWithAngle(void* player, float angle)
{
    if (!s_fnSWA || !player) return false;
    ShootWithAngleFn fn = ResolveShootWithAngleForObject(player);
    if (!fn) return false;
    __try {
        fn(player, angle, nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
    return true;
}

void Reset()
{
    s_csaResolved = false;
    s_swaResolved = false;
    s_fnCSA = nullptr;
    s_fnSWA = nullptr;
    s_miSWA = nullptr;
}

} // namespace ShootRuntime
