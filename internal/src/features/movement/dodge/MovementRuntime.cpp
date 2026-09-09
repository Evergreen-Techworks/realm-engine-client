#include "pch-il2cpp.h"
#include "MovementRuntime.h"
#include "MovementSpeed.h"
#include "MovementFrameBudget.h"

#include "Il2CppResolver.h"
#include "Il2CppHook.h"
#include "DbgFileLog.h"
#include "features/control/FeatureState.h"
#include "game/objects/GameObjects.h"

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

// Per-update movement accounting. Game-update thread only, hence thread_local:
// the worker never actuates.
thread_local DodgeRuntime::MovementFrameBudget s_frameBudget;
thread_local bool  s_haveCommandedPos = false;
thread_local float s_commandedX = 0.f, s_commandedY = 0.f;

double MovementNowMs()
{
    static const LARGE_INTEGER freq = [] { LARGE_INTEGER f{}; QueryPerformanceFrequency(&f); return f; }();
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    if (freq.QuadPart <= 0) return 0.;
    return static_cast<double>(now.QuadPart) * 1000.0 / static_cast<double>(freq.QuadPart);
}

bool TryPlayerPos(void* player, float& x, float& y)
{
    if (!player) return false;
    return Game::Entity(player).TryPos(x, y);
}

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
// a negative sentinel on failure; zero remains a valid measured value.
float CallCalcMoveSpeedRaw(void* player)
{
    if (!s_fnCalcMoveSpeed || !player) return DodgeRuntime::kUnknownSpeed;
    float v = 0.f;
    __try { v = s_fnCalcMoveSpeed(player, nullptr); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return DodgeRuntime::kUnknownSpeed; }
    if (!std::isfinite(v) || v < 0.f) return DodgeRuntime::kUnknownSpeed;
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
    ResolveCalcMoveSpeed();
    return SpeedOrFallback(CallCalcMoveSpeedRaw(player), 1.f);
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

FrameMove BeginMovementFrame(void* player, float frameMs, float tilesPerMs)
{
    s_frameBudget.Begin(MovementNowMs(), frameMs);
    FrameMove out{};

    float x = 0.f, y = 0.f;
    const bool havePos = TryPlayerPos(player, x, y);
    const bool speedOk = std::isfinite(tilesPerMs) && tilesPerMs > 0.f;
    if (!havePos || !speedOk) {
        // Cannot measure, so cannot budget. Forget the stale anchor rather than
        // charging against it next update.
        s_haveCommandedPos = false;
        return out;   // budgeted = false → caller keeps its own clamp
    }

    if (s_haveCommandedPos) {
        const float moved = std::hypot(x - s_commandedX, y - s_commandedY);
        // A displacement larger than a couple of frames of travel is not travel
        // the player is "owed": it is a teleport, a portal, a map change, or the
        // gap left by ticks where the dodge did not run. Charging it would blank
        // the allowance on the first frame back for no safety benefit, so treat a
        // discontinuity as a fresh anchor and charge nothing.
        const float plausible = tilesPerMs * MovementFrameBudget::kMaxFrameMs * 2.f;
        if (std::isfinite(moved) && moved > 1e-4f && moved <= plausible)
            s_frameBudget.Charge(moved / tilesPerMs);
    }
    s_commandedX = x; s_commandedY = y; s_haveCommandedPos = true;

    out.budgeted = true;
    out.tiles = s_frameBudget.Available(MovementNowMs()) * tilesPerMs;
    if (!std::isfinite(out.tiles) || out.tiles < 0.f) out.tiles = 0.f;
    return out;
}

void EndMovementFrame(void* player)
{
    float x = 0.f, y = 0.f;
    if (TryPlayerPos(player, x, y)) { s_commandedX = x; s_commandedY = y; s_haveCommandedPos = true; }
    else s_haveCommandedPos = false;
    s_frameBudget.End();
}

float GetTilesPerSec(void* player)
{
    ResolveCalcMoveSpeed();
    const int32_t spd = FeatureState::GetClientSpeed();
    const float mul = CallCalcMoveSpeedRaw(player);
    // A readable multiplier still applies before the first SPD packet. Retain
    // the existing SPD-50 fallback only for the missing base stat, not the slow.
    const float speed = ResolveTilesPerSec(spd >= 0 ? spd : 50, SpeedOrFallback(mul, 1.f));
    return speed;
}

void Reset()
{
    s_frameBudget = MovementFrameBudget{};
    s_haveCommandedPos = false;
    s_moveResolved = false;
    s_cmsResolved = false;
    s_dtResolved = false;
    s_fnMoveTo = nullptr;
    s_fnCalcMoveSpeed = nullptr;
    s_fnGetDeltaTime = nullptr;
    s_lastDeltaTime = 0.016f;
}

} // namespace DodgeRuntime
