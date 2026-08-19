#include "pch-il2cpp.h"
#include "MovementRuntime.h"

#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "DbgFileLog.h"
#include "features/control/FeatureState.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <windows.h>

namespace {

using MoveToFn = bool(__fastcall*)(void* __this, float x, float y, void* methodInfo);
using CalcMoveSpeedFn = float(__fastcall*)(void* __this, void* methodInfo);
using GetDeltaTimeFn = float(__cdecl*)(void* method);

MoveToFn s_fnMoveTo = nullptr;
const MethodInfo* s_miMoveTo = nullptr;
CalcMoveSpeedFn s_fnCalcMoveSpeed = nullptr;
GetDeltaTimeFn s_fnGetDeltaTime = nullptr;
bool s_moveResolved = false;
bool s_cmsResolved = false;
bool s_dtResolved = false;
float s_lastDeltaTime = 0.016f;

void ResolveMoveTo()
{
    if (s_moveResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("FKALGHJIADI", "DGLCONCOIBO", 2);
    if (!mi) return;
    s_fnMoveTo = reinterpret_cast<MoveToFn>(mi->methodPointer);
    s_miMoveTo = mi;
    s_moveResolved = true;
}

// DGLCONCOIBO (MoveTo) is virtual — the live player can be a FKALGHJIADI
// subclass whose override differs from the impl we bound at resolve time.
// Re-dispatch through the object's own vtable, caching per live class so the
// il2cpp lookup runs once per class, not per frame. Falls back to the bound
// FKALGHJIADI impl if anything about the lookup is off.
MoveToFn ResolveMoveToForObject(void* player)
{
    static void*    s_cachedKlass = nullptr;
    static MoveToFn s_cachedFn    = nullptr;

    if (!s_miMoveTo) return s_fnMoveTo;
    void* klass = nullptr;
    __try { klass = *reinterpret_cast<void**>(player); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return s_fnMoveTo; }
    if (!klass) return s_fnMoveTo;
    if (klass == s_cachedKlass && s_cachedFn) return s_cachedFn;

    MoveToFn fn = s_fnMoveTo;
    __try {
        const MethodInfo* mi = il2cpp_object_get_virtual_method(
            reinterpret_cast<Il2CppObject*>(player), s_miMoveTo);
        if (mi && mi->methodPointer)
            fn = reinterpret_cast<MoveToFn>(mi->methodPointer);
    } __except (EXCEPTION_EXECUTE_HANDLER) { fn = s_fnMoveTo; }

    s_cachedKlass = klass;
    s_cachedFn    = fn;
    return fn;
}

// Raw CalcMoveSpeed (FKALGHJIADI::GCFKGLKAPND) call, SEH-guarded. Returns
// <= 0 on failure so the caller can distinguish "unresolved" from a value.
float CallCalcMoveSpeedRaw(void* player)
{
    if (!s_fnCalcMoveSpeed || !player) return 0.f;
    float v = 0.f;
    __try { v = s_fnCalcMoveSpeed(player, nullptr); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return 0.f; }
    if (!std::isfinite(v) || v <= 0.f) return 0.f;
    return v;
}

void ResolveCalcMoveSpeed()
{
    if (s_cmsResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("FKALGHJIADI", "GCFKGLKAPND", 0);
    if (!mi) return;
    s_fnCalcMoveSpeed = reinterpret_cast<CalcMoveSpeedFn>(mi->methodPointer);
    s_cmsResolved = true;
}

void ResolveDeltaTime()
{
    if (s_dtResolved) return;
    const MethodInfo* mi = Il2CppHook::ResolveMethodCached("Time", "get_deltaTime", 0,
                                                            false, "UnityEngine");
    if (!mi) return;
    s_fnGetDeltaTime = reinterpret_cast<GetDeltaTimeFn>(mi->methodPointer);
    s_dtResolved = true;
}

} // namespace

namespace DodgeRuntime {

bool EnsureResolved()
{
    ResolveMoveTo();
    ResolveCalcMoveSpeed();
    ResolveDeltaTime();
    return s_fnMoveTo != nullptr;
}

float GetDeltaTime()
{
    if (!s_fnGetDeltaTime) return s_lastDeltaTime;
    float dt = s_lastDeltaTime;
    __try {
        dt = s_fnGetDeltaTime(nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        dt = s_lastDeltaTime;
    }
    if (dt <= 0.f || dt > 0.5f) dt = s_lastDeltaTime;
    s_lastDeltaTime = dt;
    return dt;
}

float GetMoveSpeedMul(void* player)
{
    if (!s_fnCalcMoveSpeed || !player) return 1.f;
    float result = 1.f;
    __try {
        result = s_fnCalcMoveSpeed(player, nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        result = 1.f;
    }
    if (!std::isfinite(result) || result <= 0.f) result = 1.f;
    return result;
}

bool CallMoveTo(void* player, float x, float y)
{
    if (!s_fnMoveTo || !player) return false;
    MoveToFn fn = ResolveMoveToForObject(player);
    if (!fn) return false;
    bool ok = false;
    __try {
        ok = fn(player, x, y, nullptr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        ok = false;
    }
    return ok;
}

float GetTilesPerSec(void* player)
{
    // Server-authoritative SPD stat, pushed each NEWTICK from the client
    // (FeatureState::clientSpeed). This is name/offset independent — the old
    // in-DLL read at player+0x478 broke on the 2026-08 layout shift, and the
    // game's CalcMoveSpeed (GCFKGLKAPND) returns a ~1.0 MULTIPLIER, not tiles/s.
    const int32_t clientSpd = FeatureState::GetClientSpeed();
    if (clientSpd >= 0) {
        // Flash speed curve, capped at SPD 75 (rings/pets past 75 don't add
        // server-authorized movement, so extrapolating rubber-bands).
        const float spd = std::clamp(static_cast<float>(clientSpd), 0.f, 75.f);
        float tps = 4.0f + 5.6f * (spd / 75.0f);

        // Refine with the game's own live multiplier (Speedy / Slowed / tile
        // speed), which the flat curve can't see. ~1.0 in the common case.
        ResolveCalcMoveSpeed();
        const float mul = CallCalcMoveSpeedRaw(player);
        if (mul > 0.2f && mul < 5.f) tps *= mul;

        static bool s_logged = false;
        if (!s_logged) {
            s_logged = true;
            char buf[160];
            snprintf(buf, sizeof(buf),
                     "[DodgeRuntime] clientSpd=%d mul=%.3f -> tilesPerSec=%.3f",
                     clientSpd, mul, tps);
            DbgFileLogWrite(buf);
        }
        if (tps < 0.5f || tps > 40.f) return 0.f;
        return tps;
    }
    // clientSpeed not yet pushed (auto-aim plugin off or pre-first-NEWTICK).
    return 0.f;   // caller applies its own SPD-50 fallback
}

void Reset()
{
    s_moveResolved = false;
    s_cmsResolved = false;
    s_dtResolved = false;
    s_fnMoveTo = nullptr;
    s_fnCalcMoveSpeed = nullptr;
    s_fnGetDeltaTime = nullptr;
    s_lastDeltaTime = 0.016f;
}

} // namespace DodgeRuntime
