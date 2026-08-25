#pragma once

#include <cstdint>
#include <vector>

struct WorldProjectile;

// Enemy projectile ring buffer + SpawnProjectile detour (DIA4A-equivalent offsets).
// Populates World tab snapshots and feeds DebugTAB path / hitbox overlays.
namespace ProjectileTracking {

    void Install();
    void Uninstall();
    bool IsInstalled();

    void SetLocalPlayerObjectId(int32_t objectId);
    int32_t GetLocalPlayerObjectId();

    // Cleared at the start of each WorldTAB entity scan; filled per entity for shooter-origin lookup.
    void OnWorldRefreshBegin();
    void OnWorldEntity(int32_t objectId, float x, float y);

    // Copy active (unexpired) shots into `out` (under lock). Used by WorldTAB::DoRefresh.
    void SnapshotToWorld(std::vector<WorldProjectile>& out);

    // Live copy for overlays: same as snapshot but refreshes x/y from projectile instances when readable.
    void CopyActiveForDraw(std::vector<WorldProjectile>& out);

    // Local player projectile paths only.
    void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out);

    bool RetireProjectile(const WorldProjectile& proj);

    // Prune tracked shots the game has already deleted early (hit a wall/enemy/
    // player) by cross-referencing the game's LIVE projectile pool, so their danger
    // lanes disappear immediately instead of lingering to their full lifetime. Safe:
    // never prunes when the pool read fails/returns empty. Call periodically.
    void ReconcileWithLivePool();

    // Game-authored world position at tMs after spawn. Compatibility wrapper around HBEAKBIHANL.GIBLKPDHLBG.
    void ComputePosAt(const WorldProjectile& proj, float tMs, float& outX, float& outY);

    // Compatibility wrapper for legacy callers. Leaves outX/outY unchanged if the game call fails.
    void ComputePosAtSafe(const WorldProjectile& proj, float tMs, float& outX, float& outY);

    // Optional UI scale (default 1) multiplied with native per-shot speed mult from IL2CPP field KDAJOMOFMJB.
    void  SetFlashSpeedMultiplier(float m);
    float GetFlashSpeedMultiplier();

    // Local-player shots: spawn offset along fire angle (tiles). Vanilla ~0.3 (Flash Player.doShoot).
    // Values > 0.3001 replace KOBMINBDOBD startX/Y with cos/sin * offset; at 0.3 no extra work per shot.
    void  SetLocalPlayerMuzzleOffsetTiles(float tiles);
    float GetLocalPlayerMuzzleOffsetTiles();

    // HBEAKBIHANL instance: reads KDAJOMOFMJB (offset from RuntimeOffsets::Hbeak_SpeedMul), × GetFlashSpeedMultiplier().
    float EffectiveSpeedMulFromProjectile(void* hbeakInstance);

    // ProjectileProperties.Lifetime is usually seconds in XML; values already in ms are typically >= ~250.
    float NormalizeProjectileLifetimeMs(float rawFromProps);

    // AccelDelay: values in (0, 2] are treated as seconds (e.g. 0.375 → 375 ms); larger values = ms.
    float NormalizeAccelDelayMs(float rawFromProps);

    int CountValidForDiagnostics();

    // ── Prediction accuracy ──────────────────────────────────────────────────
    // Per-projectile clock calibration: the game's own positionAt is exact, but
    // our elapsed-time input is coarse (10-16ms GetTickCount) and spawn-hook
    // latency biases it. When ON, each tick fits a small time correction τ from
    // the live position so future predictions sit on the true trajectory, and
    // records the residual (unexplained model error) for diagnostics. OFF =
    // legacy tick-based elapsed. Default ON.
    void SetPredictionAccuracy(bool enabled);
    bool GetPredictionAccuracy();

    // Aggregate residual snapshot for the overlay / diag bridge.
    struct PredictionDiag {
        bool  enabled = false;
        int   calibrated = 0;
        float emaAbsTauMs = 0.f;     // typical clock error being corrected (ms)
        float maxAbsTauMs = 0.f;     // worst clock error (ms, slow decay)
        float emaCrossTiles = 0.f;   // typical residual the model can't explain (tiles)
        float maxCrossTiles = 0.f;   // worst residual (tiles, slow decay)
    };
    PredictionDiag GetPredictionDiag();

    // HBEAKBIHANL.HHFDCMIIIHF (projRadius) — same float as Chebyshev T; offset from IL2CPP (BeeByte name).
    bool     TryReadProjRadiusFromInstance(void* hbeakInstance, float& outRadius);
    uint32_t GetHbeakProjRadiusOffset();

    // Hazard-spawn callback (DangerPlanner replan trigger).
    // Invoked from SpawnProjectileDetour after a NON-self-owned projectile has
    // been recorded into the ring. The callback fires on the game thread and
    // receives a copy of the WorldProjectile slot — do not dereference after
    // return.
    using HazardSpawnCb = void (*)(const WorldProjectile& proj, void* user);
    void RegisterHazardSpawnCallback(HazardSpawnCb cb, void* user);
    void ClearHazardSpawnCallback();
}
