#pragma once
#include <cstdint>

// ShootRuntime — the ONE place that CALLS the game's shoot methods (as opposed to
// AimHooks, which HOOKS them). Shoot analogue of DodgeRuntime in
// features/movement/dodge/MovementRuntime.h. Resolve-once + cache; every call is
// SEH-guarded and returns false on any failure. Game/render thread only.
namespace ShootRuntime {

// Resolve ComputeShootAngle + ShootWithAngle. Safe to call every tick until it
// succeeds; caches on first success. Returns true once both are bound.
bool EnsureResolved();
bool IsResolved();

// The player's ComputeShootAngle(slot, &outAngle, &outCanShoot, false).
// outCanShoot is the GAME'S OWN rate-limit / MP / silence gate. Returns false if
// the method is unbound or the call faulted (outputs then untouched).
// (The obfuscated class/method tokens live only in ShootRuntime.cpp.)
bool TryComputeShootAngle(void* player, uint8_t slot, float& outAngle, bool& outCanShoot);

// The player avatar's ShootWithAngle(angle). Virtual — re-dispatched through the
// live object's vtable, cached per class, exactly like DodgeRuntime::CallMoveTo.
bool CallShootWithAngle(void* player, float angle);

void Reset();   // realm transition / teardown

} // namespace ShootRuntime
