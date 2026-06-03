#pragma once

struct WorldProjectile;

enum class ProjectileCollisionFallback
{
    SpawnHook,
    WorldManager,
};

namespace ProjectileRuntimeReader {

    void* EffectivePropsFromProjectile(void* projectilePtr, void* fallbackProps);
    bool TryReadRuntimeChebyshevHalf(void* projectilePtr, float& outHalf);
    bool ApplyProperties(WorldProjectile& dst, void* projectilePtr, void* projProps,
                         ProjectileCollisionFallback collisionFallback);
}
