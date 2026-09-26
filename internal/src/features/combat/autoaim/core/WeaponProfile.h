#pragma once

#include <cstdint>

// Calibrated weapon profile derived from the last fired projectile.
// Populated by WeaponCalibrator::OnProjectileSpawn and refreshed each tick
// to pick up current player speed/lifetime multipliers.
struct WeaponProfile {
    float   speedRaw    = 0.f;   // raw int as float (divide by 10000 for tiles/ms)
    float   lifetimeMs  = 0.f;   // post-multiplier lifetime
    float   rangeTiles  = 15.f;  // effective range (placeholder until resolved)
    float   avgSpeedTps = 10.f;  // average speed tiles/sec, used for QuadraticIntercept
    int32_t projId      = 0;     // projProps objectType id (for weapon-specific tweaks)
    bool    isResolved  = false; // true once calibrated from real projProps data
};

namespace WeaponCalibrator {
struct Provenance {uint64_t sequence=0,ms=0,generation=0;int32_t source=0,projId=0;float rawSpeed=0,rawLife=0,range=0,speedMul=1,lifeMul=1,rangeMul=1;};
// False means unavailable/contended; never block movement for diagnostics.
bool CopyProvenance(Provenance& out);


// Call when the local player fires a non-ability shot.
// localPlayer must be supplied so calibration can run immediately while projProps
// is still valid (the managed object may be GC'd before the next render tick).
void OnProjectileSpawn(void* projProps, void* localPlayer);

// Call once per frame with the current local player pointer.
// Re-reads player speed/lifetime/range multipliers for the cached projProps.
void Tick(void* localPlayer);

const WeaponProfile& GetProfile();

// Reset on realm transition so stale range data doesn't carry forward.
void Reset();

} // namespace WeaponCalibrator
