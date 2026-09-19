#pragma once

struct WorldProjectile;

namespace ProjectileTrajectory {

    float NormalizeLifetimeMs(float rawFromProps);
    float NormalizeAccelDelayMs(float rawFromProps);

    bool GetPositionAtTime(const WorldProjectile& proj, float tMs, float& outX, float& outY);

    bool CachePath(WorldProjectile& proj);

    // "ok" | "fail" | "untried" — cached state of the game's positionAt method.
    // Pure read: never triggers resolution, safe off the game thread.
    const char* PositionAtWitness();
}
