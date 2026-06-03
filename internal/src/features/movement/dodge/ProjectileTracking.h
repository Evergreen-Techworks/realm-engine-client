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

    // HBEAKBIHANL instance: reads KDAJOMOFMJB via il2cpp_field_get_offset, × GetFlashSpeedMultiplier().
    float EffectiveSpeedMulFromProjectile(void* hbeakInstance);

    // ProjectileProperties.Lifetime is usually seconds in XML; values already in ms are typically >= ~250.
    float NormalizeProjectileLifetimeMs(float rawFromProps);

    // AccelDelay: values in (0, 2] are treated as seconds (e.g. 0.375 → 375 ms); larger values = ms.
    float NormalizeAccelDelayMs(float rawFromProps);

    int CountValidForDiagnostics();

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
