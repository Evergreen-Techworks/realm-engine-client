#pragma once

#include <vector>

struct WorldProjectile;

namespace ProjectileStore {

    using HazardSpawnCb = void (*)(const WorldProjectile& proj, void* user);

    // Aggregate prediction-residual stats (updated while calibration is on).
    struct PredictionDiag {
        bool  enabled = false;
        int   calibrated = 0;        // projectiles calibrated in the last pass
        float emaAbsTauMs = 0.f;     // typical clock error being corrected
        float maxAbsTauMs = 0.f;     // worst clock error seen (slow decay)
        float emaCrossTiles = 0.f;   // typical unexplained model error
        float maxCrossTiles = 0.f;   // worst unexplained model error (slow decay)
    };

    // Prediction-accuracy toggle: per-projectile clock calibration (τ fit from
    // live position) + residual stats. OFF = legacy tick-based elapsed only.
    void SetPredictionAccuracy(bool enabled);
    bool GetPredictionAccuracy();
    PredictionDiag GetPredictionDiag();

    // High-resolution monotonic clock (ms). Shared time base for spawnQpcMs.
    double QpcNowMs();

    void Initialize();
    void Shutdown();

    WorldProjectile StoreProjectile(bool enemyShot, const WorldProjectile& projectile);

    bool RetireProjectile(const WorldProjectile& projectile);

    void SnapshotToWorld(std::vector<WorldProjectile>& out);
    void CopyActiveForDraw(std::vector<WorldProjectile>& out);
    void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out);
    int CountValidForDiagnostics();

    void RegisterHazardSpawnCallback(HazardSpawnCb cb, void* user);
    void ClearHazardSpawnCallback();
    void NotifyHazardSpawn(const WorldProjectile& projectile);
}
