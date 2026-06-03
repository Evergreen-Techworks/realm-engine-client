#pragma once

#include <vector>

struct WorldProjectile;

namespace ProjectileStore {

    using HazardSpawnCb = void (*)(const WorldProjectile& proj, void* user);

    void Initialize();
    void Shutdown();

    WorldProjectile StoreProjectile(bool enemyShot, const WorldProjectile& projectile);

    void SnapshotToWorld(std::vector<WorldProjectile>& out);
    void CopyActiveForDraw(std::vector<WorldProjectile>& out);
    void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out);
    int CountValidForDiagnostics();

    void RegisterHazardSpawnCallback(HazardSpawnCb cb, void* user);
    void ClearHazardSpawnCallback();
    void NotifyHazardSpawn(const WorldProjectile& projectile);
}
