#pragma once

struct WorldProjectile;

namespace ProjectileTrajectory {

    float NormalizeLifetimeMs(float rawFromProps);
    float NormalizeAccelDelayMs(float rawFromProps);

    bool GetPositionAtTime(const WorldProjectile& proj, float tMs, float& outX, float& outY);

    bool CachePath(WorldProjectile& proj);
}
