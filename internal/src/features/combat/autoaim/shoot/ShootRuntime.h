#pragma once
#include <cstdint>

// ShootRuntime — the ONE place that CALLS the game's shoot methods (as opposed to
// AimHooks, which HOOKS them). Shoot analogue of DodgeRuntime in
// features/movement/dodge/MovementRuntime.h. Resolve-once + cache; every call is
// SEH-guarded and returns false on any failure. Game/render thread only.
namespace ShootRuntime {

bool EnsureResolved();
bool IsResolved();
bool IsFiringResolved();
bool IsManualAngleResolved();

bool TryComputeShootAngle(void* player, uint8_t slot, float& outAngle, bool& outCanShoot);

// The player avatar's ShootWithAngle(angle). Virtual — re-dispatched through the
// live object's vtable, cached per class, exactly like DodgeRuntime::CallMoveTo.
bool CallShootWithAngle(void* player, float angle);

void Reset();   // realm transition / teardown

} // namespace ShootRuntime
