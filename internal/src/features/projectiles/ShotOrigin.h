#pragma once
#include <cstdint>

// ShotOrigin — the ONE place that decides where the LOCAL projectile for our own
// shot spawns. Called from ProjectileTracking's SpawnProjectileDetour, on the
// game thread, inside the hot path: no allocation, no IL2CPP calls, no locks
// beyond the shooter-position lookup the caller already performs.
//
// Coordinates are SHOOTER-RELATIVE tile offsets (the same space the game's
// spawn method takes; vanilla length ~0.3).
namespace ShotOrigin {

enum class Source : uint8_t {
    Vanilla  = 0,  // no override — pass the game's own startX/startY through
    Muzzle   = 1,  // manual muzzle-offset slider
    Magnet   = 2,  // MagnetAim visual offset
    // DEAD. Resolve() never returns this, and killaura no longer moves the local
    // bullet at all (the ShotOriginHook that did is deleted — see the
    // measured-result block at the top of KillAura.cpp). The enumerator is kept
    // only so the two readout switches over Source stay exhaustive; nothing
    // produces it.
    KillAura = 3,
};

struct Request {
    bool  isLocalShot   = false;
    float angle         = 0.f;   // the fired angle, radians
    float startX        = 0.f;   // the game's own relative offset
    float startY        = 0.f;
    bool  haveShooter   = false; // shooter world position resolved?
    float shooterX      = 0.f;
    float shooterY      = 0.f;
    float muzzleTiles   = 0.3f;  // ProjectileTracking::GetLocalPlayerMuzzleOffsetTiles()
};

// Fills outX/outY with the relative offset to use. ALWAYS succeeds: on any
// failure it returns Source::Vanilla with outX/outY == req.startX/startY, so a
// broken override can never corrupt a shot.
Source Resolve(const Request& req, float& outX, float& outY);

// The Source the last Resolve() returned. Read-only diagnostic (Combat tab).
Source LastSource();

} // namespace ShotOrigin
