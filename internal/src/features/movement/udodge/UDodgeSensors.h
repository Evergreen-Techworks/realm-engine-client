#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Sensors {

// Short-lived ENEMYSHOOT recovery records from the proxy. Runtime projectiles
// remain authoritative and suppress matching provisional lanes.
void RecordPacketShot(const char* encoded);
void ClearPacketShots();

// Server AOE packets forwarded by the proxy ("originType,x,y,radius,damage").
// Queued here (IPC thread) and consumed on the game thread, where a blast centred
// on a living enemy of its own originType with no telegraph teaches the dodge to
// keep out of that enemy type's radius (UDodgeEnemyHazards.h).
void RecordAoePacket(const char* encoded);

// Host environment probes (match the Env fn-pointer signatures).
bool IsHazardAt(float worldX, float worldY);
bool CanOccupy(float worldX, float worldY, bool safeWalk);

// ── Instantaneous danger map (plan 45) ──────────────────────────────────────
// Reads the WorldManager server-tick counter (increments once per processed
// NEWTICK). Returns false when WorldMgr/offset is unavailable — caller falls
// back to rebuilding the map every frame (fail-safe = fresher, never staler).
bool ReadWorldTick(uint32_t& outTickId);

// Full layout rebuild from live game state (game-update thread only).
// Does NOT stamp tickId/tickValid — the caller owns the stamp.
void BuildMap(DangerMap& out, float playerX, float playerY, const Settings& settings);

// Mid-tick refresh: re-anchor every lane to its projectile's LIVE position,
// re-derive zones. Returns false when the live projectile set no longer
// matches the map's lane set (spawn/retire) — caller must BuildMap instead.
// Enemies/boss-lock intentionally NOT refreshed (layout is per-tick).
bool ReanchorMap(DangerMap& map, float playerX, float playerY, const Settings& settings);

} } // namespace UDodge::Sensors
