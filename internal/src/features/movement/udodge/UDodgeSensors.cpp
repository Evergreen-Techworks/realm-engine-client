#include "pch-il2cpp.h"
#include "UDodgeSensors.h"

#include "AoeTracking.h"
#include "GameState.h"
#include "MemRead.h"
#include "ProjectileTracking.h"
#include "RuntimeOffsets.h"
#include "DbgFileLog.h"
#include "DangerPlanner.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/TestTAB.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
#include <windows.h>

namespace UDodge { namespace Sensors {
namespace {

constexpr float kThreatCullTiles = 16.f;
// Enemy body exclusion radius (tiles). EnemyTracker::Entry carries NO per-enemy
// size/radius/hitbox field (only id/objType/pos/hp/vel/flags/ptr), so there is no
// real body size to read — this is a single baked default applied to every mob.
// Raised 0.5 → 0.8 (plan: stop clipping bigger mobs): the true no-go is
// radius + kUPlayerHalf (~1.01 tiles), which now clears typical mob bodies so the
// solver and the grid pathfinder stop routing the player onto a mob's edge. The
// SAME value feeds every EnemyBlocker.radius, so the immediate solver's
// EnemyBlocked and the worker pathfinder's enemy-blocked cells stay consistent
// (both read EnemyBlocker.radius from this one source).
constexpr float kEnemyRadius     = 0.8f;
constexpr float kAoeCullPad      = 16.f;

// Per-tick memo for the hazard lookup: the core probes CanOccupy at hundreds of
// points per frame, so each distinct tile is queried at most once per tick.
// Fixed-size open-addressing hash table — no per-frame heap allocation.
// Single game-update-thread consumer; cleared at the top of BuildMap/ReanchorMap.
constexpr uint32_t kMemoSlots    = 512;      // power of 2
constexpr uint32_t kMemoMask     = kMemoSlots - 1;
constexpr uint32_t kMemoEmpty    = 0xFFFFFFFFu;

struct MemoEntry { uint32_t key; uint8_t value; };
MemoEntry s_hazardMemo[kMemoSlots];

void MemoClear()
{
    for (uint32_t i = 0; i < kMemoSlots; ++i)
        s_hazardMemo[i].key = kMemoEmpty;
}

bool MemoFind(uint32_t key, uint8_t& outValue)
{
    uint32_t idx = key & kMemoMask;
    for (uint32_t probe = 0; probe < kMemoSlots; ++probe) {
        const MemoEntry& e = s_hazardMemo[idx];
        if (e.key == key) { outValue = e.value; return true; }
        if (e.key == kMemoEmpty) return false;
        idx = (idx + 1) & kMemoMask;
    }
    return false;
}

void MemoInsert(uint32_t key, uint8_t value)
{
    uint32_t idx = key & kMemoMask;
    for (uint32_t probe = 0; probe < kMemoSlots; ++probe) {
        MemoEntry& e = s_hazardMemo[idx];
        if (e.key == kMemoEmpty || e.key == key) {
            e.key = key; e.value = value;
            return;
        }
        idx = (idx + 1) & kMemoMask;
    }
}

uint32_t TileKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}

bool IsFinite(float v) { return std::isfinite(v); }
bool IsFinitePoint(float x, float y) { return IsFinite(x) && IsFinite(y); }

float DistSq(float ax, float ay, float bx, float by)
{
    const float dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

// SEH-guarded prediction. (0,0) is GetPositionAtTime's failure sentinel — no
// real in-dungeon projectile sits at the world origin, so reject it.
bool TryPredict(const WorldProjectile& p, float tMs, float& outX, float& outY)
{
    float x = 0.f, y = 0.f;
    __try { ProjectileTracking::ComputePosAt(p, tMs, x, y); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    if (x == 0.f && y == 0.f) return false;
    if (!IsFinitePoint(x, y)) return false;
    outX = x; outY = y;
    return true;
}

// Anchor a cached projectile path to its live position (falls back to elapsed
// time if the live anchor is implausible — guards against bad PosX/PosY offsets).
int CachedAnchorIndex(const WorldProjectile& p, float elapsedMs)
{
    const int count = std::clamp(p.pathSampleCount, 0, kWorldProjectilePathSampleCap);
    if (count <= 1) return 0;
    if (!IsFinitePoint(p.x, p.y)) return -1;

    int best = 0;
    float bestDistSq = 3.402823466e+38f;
    for (int i = 0; i < count; ++i) {
        const float x = p.pathX[i], y = p.pathY[i];
        if (!IsFinitePoint(x, y)) continue;
        const float d = DistSq(x, y, p.x, p.y);
        if (d < bestDistSq) { bestDistSq = d; best = i; }
    }
    constexpr float kMaxLiveAnchorDistSq = 25.f;
    if (bestDistSq <= kMaxLiveAnchorDistSq) return best;

    if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return -1;
    float bestDelta = 3.402823466e+38f;
    for (int i = 0; i < count; ++i) {
        const float tcand = p.pathSampleTimesMs[i];
        if (!IsFinite(tcand)) continue;
        const float delta = std::fabs(tcand - elapsedMs);
        if (delta < bestDelta) { bestDelta = delta; best = i; }
    }
    return best;
}

// Shared scratch buffers for the copy APIs (they need vectors, but the
// allocation amortizes to zero across frames). BuildMap/ReanchorMap never
// run in the same frame and both run on the game-update thread only, so
// sharing is safe.
std::vector<WorldProjectile> s_projs;
std::vector<WorldAoe>        s_aoes;

// ── Instantaneous danger map (plan 45) ──────────────────────────────────────
// Lane tracing helpers. Times here are LOCAL variables only — they trace the
// curve shape and are discarded; nothing time-valued is stored in the lane.

// Lane from the projectile's cached path, rebased onto its live position
// (adapted from AddCachedPath). Returns false (caller falls back to a fresh
// ComputePosAt trace).
bool LaneFromCachedPath(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
{
    if (!p.hasCachedPath || p.pathSampleCount < 2) return false;
    if (IsFinite(p.lifetime) && p.lifetime > 0.f && elapsedMs >= p.lifetime) return false;

    const int count = std::min(p.pathSampleCount, kWorldProjectilePathSampleCap);
    const int anchor = CachedAnchorIndex(p, elapsedMs);
    if (anchor < 0 || anchor >= count) return false;
    const float ax = p.pathX[anchor], ay = p.pathY[anchor];
    if (!IsFinitePoint(ax, ay)) return false;
    // Time base: the cached sample times are ms-since-spawn; rebase onto the live
    // anchor so pointTimesMs is ms-from-NOW (points[0] = live = t 0).
    const float tAnchor = IsFinite(p.pathSampleTimesMs[anchor]) ? p.pathSampleTimesMs[anchor] : 0.f;

    lane.pointCount = 0;
    lane.pointTimesMs[lane.pointCount] = 0.f;
    lane.points[lane.pointCount++] = { p.x, p.y };   // live position = anchor
    float pathLen = 0.f;
    for (int i = anchor + 1; i < count && lane.pointCount < kMaxLanePoints; ++i) {
        if (!IsFinitePoint(p.pathX[i], p.pathY[i])) continue;
        const float sMs = p.pathSampleTimesMs[i];
        if (!IsFinite(sMs)) break;
        if (IsFinite(p.lifetime) && p.lifetime > 0.f && sMs > p.lifetime) break;
        const Vec2 pt = { p.x + (p.pathX[i] - ax), p.y + (p.pathY[i] - ay) };
        pathLen += Len(Sub(pt, lane.points[lane.pointCount - 1]));
        lane.pointTimesMs[lane.pointCount] = std::max(0.f, sMs - tAnchor);
        lane.points[lane.pointCount++] = pt;
        if (pathLen >= laneCap) break;
    }
    return lane.pointCount >= 2;
}

// Lane from a fresh positionAt trace anchored on the live position (adapted
// from AddFreshPath / the dense fallback). Coarse elapsed only — the live
// position is the anchor; clock calibration is deliberately unused here.
bool LaneFromFreshTrace(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
{
    float ax = 0.f, ay = 0.f;
    if (!TryPredict(p, elapsedMs, ax, ay)) return false;
    const float offX = p.x - ax;
    const float offY = p.y - ay;

    lane.pointCount = 0;
    lane.pointTimesMs[lane.pointCount] = 0.f;
    lane.points[lane.pointCount++] = { p.x, p.y };   // live position = anchor
    float pathLen = 0.f;
    for (int k = 1; lane.pointCount < kMaxLanePoints; ++k) {
        const float tMs = elapsedMs + static_cast<float>(k) * kTraceStepMs;
        if (p.lifetime > 0.f && tMs > p.lifetime) break;
        float x = 0.f, y = 0.f;
        if (!TryPredict(p, tMs, x, y)) break;
        const Vec2 pt = { x + offX, y + offY };
        pathLen += Len(Sub(pt, lane.points[lane.pointCount - 1]));
        // Time from NOW: k uniform kTraceStepMs steps ahead of the live anchor.
        lane.pointTimesMs[lane.pointCount] = static_cast<float>(k) * kTraceStepMs;
        lane.points[lane.pointCount++] = pt;
        if (pathLen >= laneCap) break;
    }
    return lane.pointCount >= 2;
}

// Straight-line fallback: when both trajectory builders fail, extrapolate the
// bullet forward along its live heading so the lane is never a single far point
// at the bullet head (which starves the relevance gate). A straight ray is the
// correct present-tense danger for a shot whose curve model is unavailable.
// Steps spatially by kTraceStepMs-equivalent increments up to laneCap tiles.
bool LaneFromStraightExtrapolation(LaneThreat& lane, const WorldProjectile& p, float laneCap)
{
    if (!IsFinitePoint(p.x, p.y)) return false;
    if (!IsFinite(p.angle)) return false;

    const float dx = std::cos(p.angle);
    const float dy = std::sin(p.angle);
    if (!IsFinitePoint(dx, dy)) return false;

    // tiles/ms = speed(raw)/10000 × speedMul; fall back to a nominal walk-speed
    // step if speed is unread/garbage so the lane still spans a useful distance.
    const float speedMul = (IsFinite(p.speedMul) && p.speedMul > 0.f) ? p.speedMul : 1.f;
    float tilesPerMs = (IsFinite(p.speed) && p.speed > 0.f) ? (p.speed / 10000.f) * speedMul : 0.f;
    float stepDist = tilesPerMs * kTraceStepMs;
    if (!IsFinite(stepDist) || stepDist <= 1e-3f) stepDist = 0.5f;   // ~0.5 tile/step fallback

    lane.pointCount = 0;
    lane.pointTimesMs[lane.pointCount] = 0.f;
    lane.points[lane.pointCount++] = { p.x, p.y };   // live position = anchor
    float pathLen = 0.f;
    while (lane.pointCount < kMaxLanePoints) {
        pathLen += stepDist;
        // stepDist == tilesPerMs × kTraceStepMs when speed is known, so each
        // spatial step is one kTraceStepMs of travel time (proxy when unknown).
        lane.pointTimesMs[lane.pointCount] = static_cast<float>(lane.pointCount) * kTraceStepMs;
        lane.points[lane.pointCount++] = { p.x + dx * pathLen, p.y + dy * pathLen };
        if (pathLen >= laneCap) break;
    }
    return lane.pointCount >= 2;
}

// Trace one lane: cached path preferred, fresh trace fallback, then a straight
// live-heading extrapolation. Only when even that fails does the lane collapse
// to a single-point threat (the live disc still blocks).
void TraceLane(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
{
    if (LaneFromCachedPath(lane, p, elapsedMs, laneCap)) return;
    if (LaneFromFreshTrace(lane, p, elapsedMs, laneCap)) return;
    if (LaneFromStraightExtrapolation(lane, p, laneCap)) return;
    lane.pointCount = 1;
    lane.points[0] = { p.x, p.y };
    lane.pointTimesMs[0] = 0.f;   // trajectory unknown → temporal test treats it as static (conservative)
}

// Zone pass — present-tense classification only: every not-yet-expired zone
// within the distance cull becomes a ZoneThreat, active iff it has landed.
// Shared by BuildMap (full rebuild) and ReanchorMap (mid-tick refresh).
void RebuildZones(DangerMap& out, float playerX, float playerY, const Settings& /*settings*/, uint64_t nowMs)
{
    out.zoneCount = 0;
    AoeTracking::EnsureInstalled();
    s_aoes.clear();
    AoeTracking::CopyActiveForDraw(s_aoes);
    for (const WorldAoe& a : s_aoes) {
        if (!a.valid || !a.isDamaging) continue;
        if (a.isEnemyChecked && !a.isEnemy) continue;
        if (!IsFinitePoint(a.destX, a.destY)) continue;

        const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
        const float lifeMs = IsFinite(a.lifetime) && a.lifetime > 0.f ? a.lifetime : 2000.f;
        const float landAtMs = (IsFinite(a.arcMs) && a.arcMs > 0.f) ? a.arcMs : lifeMs;
        const bool hasLanded = elapsedMs >= landAtMs;
        if (elapsedMs >= lifeMs + 25.f) continue;                  // fully expired
        if (hasLanded && lifeMs - elapsedMs <= 25.f) continue;     // effectively expired

        const float radius = (IsFinite(a.radius) && a.radius > 0.f) ? std::clamp(a.radius, 0.2f, 12.f) : 1.5f;
        const float cull = kAoeCullPad + radius;
        if (DistSq(a.destX, a.destY, playerX, playerY) > cull * cull) continue;
        if (out.zoneCount >= kMaxAoes) { out.limited = true; break; }

        ZoneThreat& z = out.zones[out.zoneCount++];
        z.pos = { a.destX, a.destY };
        z.radius = radius;
        z.active = hasLanded;
    }
}

// Enemy blockers + the user's boss lock, populated from the LIVE EnemyTracker
// snapshot. Shared by BuildMap (full rebuild) and ReanchorMap (per-frame refresh)
// so enemy bodies — a HARD no-go for both the immediate solver and the grid
// pathfinder — are RE-ANCHORED to their CURRENT positions every frame, not only
// once per server tick. A moving add can travel a long way between the ~5 Hz
// ticks; keeping this frame-fresh is what lets the per-frame step re-validation
// (UDodge::Tick) refuse to walk onto where an add has since moved. The locked
// boss position is refreshed live too, so the orbit goal tracks it mid-tick.
void PopulateEnemies(DangerMap& out, float playerX, float playerY)
{
    out.enemyCount = 0;
    out.hasLock = false;
    out.lockId = 0;
    out.lockPos = {};

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    EnemyTracker::Tick();
    const int32_t userLockId = DangerPlanner::GetEnemyLock();   // 0 = no lock
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        if (DistSq(e.x, e.y, playerX, playerY) <= cullSq) {
            if (out.enemyCount >= kMaxEnemies) { out.limited = true; }
            else {
                EnemyBlocker& b = out.enemies[out.enemyCount++];
                b.pos = { e.x, e.y };
                b.radius = kEnemyRadius;   // single baked source — no per-enemy size field exists
            }
        }
        // Lock the enemy the USER locked on (Shift+Click), only while it is ALIVE.
        // Not range-culled, so we keep orbit range to a far locked boss. Dead
        // (hp<=0) / despawned (absent) / unlocked (userLockId==0) ⇒ never matched
        // ⇒ hasLock stays false ⇒ pure assist.
        if (userLockId != 0 && e.id == userLockId && e.hp > 0 && IsFinitePoint(e.x, e.y)) {
            out.hasLock = true; out.lockId = e.id; out.lockPos = { e.x, e.y };
        }
    }
}

} // namespace

void BuildMap(DangerMap& out, float playerX, float playerY, const Settings& settings)
{
    out.laneCount = 0;
    out.zoneCount = 0;
    out.enemyCount = 0;
    out.projectileSourceUnavailable = false;
    out.limited = false;
    out.hasLock = false;
    out.lockId = 0;
    out.lockPos = {};
    MemoClear();
    // tickId/tickValid deliberately untouched — the caller owns the stamp.

    if (!ProjectileTracking::IsInstalled()) {
        out.projectileSourceUnavailable = true;
        return;
    }

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    const float laneCap = std::clamp(settings.laneTiles, 2.f, 16.f);
    const uint64_t nowMs = GetTickCount64();
    const int32_t localId = ProjectileTracking::GetLocalPlayerObjectId();

    // Enemies → hard-no-go blockers + the user's enemy lock (live snapshot).
    PopulateEnemies(out, playerX, playerY);

    // Projectiles → danger lanes: live position (anchor) + remaining travel
    // path as pure geometry. Same filter chain as Build.
    s_projs.clear();
    ProjectileTracking::CopyActiveForDraw(s_projs);
    {
        static int s_bmN = 0;
        if ((s_bmN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] BuildMap rawProjs=" << s_projs.size()
                << " localId=" << localId << " player=(" << playerX << "," << playerY
                << ") cullTiles=" << kThreatCullTiles);
    }
    for (const WorldProjectile& p : s_projs) {
        if (!p.valid) continue;
        // A shot that can hit the player is never our own outgoing shot — guard
        // the localId self-filter so a mis-attributed enemy shot is never eaten.
        if (!p.canHitPlayer && localId != 0 && p.attackerObjId == localId) continue;
        if (!p.canHitPlayer && localId != 0 && static_cast<int32_t>(p.ownerObjId) == localId) continue;
        if (!p.canHitPlayer && p.attackerObjId == 0 && static_cast<int32_t>(p.ownerObjId) == 0) continue;
        if (!IsFinitePoint(p.x, p.y)) continue;
        if (DistSq(p.x, p.y, playerX, playerY) > cullSq) continue;
        if (out.laneCount >= kMaxProjectiles) { out.limited = true; break; }

        LaneThreat& lane = out.lanes[out.laneCount];
        lane = LaneThreat{};
        lane.bulletId = static_cast<int32_t>(p.bulletId);
        lane.attackerObjId = p.attackerObjId;
        lane.ownerObjId = p.ownerObjId;
        lane.hitHalf = (IsFinite(p.runtimeChebyshevHalf) && p.runtimeChebyshevHalf > 1e-4f)
                           ? p.runtimeChebyshevHalf
                           : ((IsFinite(p.projHalfSize) && p.projHalfSize > 1e-4f) ? p.projHalfSize : 0.5f);

        // Coarse elapsed only — the calibrated clock is deliberately unused
        // here: the live position is the anchor.
        const float elapsedMs = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
        TraceLane(lane, p, elapsedMs, laneCap);
        if (lane.pointCount >= 1) ++out.laneCount;
    }

    // AoE zones → present-tense discs (active = landed & persisting; pending
    // = telegraphed soft cost).
    RebuildZones(out, playerX, playerY, settings, nowMs);
    {
        static int s_bmDoneN = 0;
        if ((s_bmDoneN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] BuildMap DONE lanes=" << out.laneCount
                << " zones=" << out.zoneCount << " enemies=" << out.enemyCount);
    }
}

bool ReadWorldTick(uint32_t& outTickId)
{
    void* wm = GameState::GetWorldMgr();
    if (!wm) return false;
    uint32_t tick = 0;
    if (!Mem::TryRead(wm, RuntimeOffsets::WM_TickId, tick)) return false;
    outTickId = tick;
    return true;
}

bool ReanchorMap(DangerMap& map, float playerX, float playerY, const Settings& settings)
{
    if (!ProjectileTracking::IsInstalled()) return false;
    MemoClear();   // per-frame hazard memo reset (same contract as Build)

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    const uint64_t nowMs = GetTickCount64();
    const int32_t localId = ProjectileTracking::GetLocalPlayerObjectId();

    // Live projectile set, same filter chain as BuildMap. Any mismatch with
    // the map's lane set (spawn/retire) is a structural change — return false
    // and the caller runs a full BuildMap instead (a partially re-anchored map
    // is fine: it is rebuilt wholesale on that path).
    s_projs.clear();
    ProjectileTracking::CopyActiveForDraw(s_projs);
    bool laneMatched[kMaxProjectiles]{};
    int  liveCount = 0;
    for (const WorldProjectile& p : s_projs) {
        if (!p.valid) continue;
        // A shot that can hit the player is never our own outgoing shot — guard
        // the localId self-filter so a mis-attributed enemy shot is never eaten.
        if (!p.canHitPlayer && localId != 0 && p.attackerObjId == localId) continue;
        if (!p.canHitPlayer && localId != 0 && static_cast<int32_t>(p.ownerObjId) == localId) continue;
        if (!p.canHitPlayer && p.attackerObjId == 0 && static_cast<int32_t>(p.ownerObjId) == 0) continue;
        if (!IsFinitePoint(p.x, p.y)) continue;
        if (DistSq(p.x, p.y, playerX, playerY) > cullSq) continue;
        if (++liveCount > map.laneCount) return false;   // spawned mid-tick

        // Match on (bulletId, attackerObjId, ownerObjId) — bulletId alone is
        // not globally unique.
        int laneIdx = -1;
        for (int i = 0; i < map.laneCount; ++i) {
            const LaneThreat& lane = map.lanes[i];
            if (lane.bulletId == static_cast<int32_t>(p.bulletId) &&
                lane.attackerObjId == p.attackerObjId &&
                lane.ownerObjId == p.ownerObjId) { laneIdx = i; break; }
        }
        if (laneIdx < 0 || laneMatched[laneIdx]) return false;
        laneMatched[laneIdx] = true;

        // Re-anchor: rebase the polyline so the nearest lane point becomes the
        // projectile's LIVE position (mid-tick frames ride the game's own
        // interpolation — nothing is extrapolated by our clock).
        LaneThreat& lane = map.lanes[laneIdx];
        int   nearest = 0;
        float bestDistSq = 3.402823466e+38f;
        for (int i = 0; i < lane.pointCount; ++i) {
            const float d = DistSq(lane.points[i].x, lane.points[i].y, p.x, p.y);
            if (d < bestDistSq) { bestDistSq = d; nearest = i; }
        }
        const Vec2 live  = { p.x, p.y };
        const Vec2 shift = Sub(live, lane.points[nearest]);
        // Rebase the time axis too: the new live anchor is t 0, and the surviving
        // forward points keep their remaining travel time (times are monotonic,
        // outCount ≤ i so the in-place shift never clobbers an unread entry).
        const float tBase = lane.pointTimesMs[nearest];
        lane.points[0] = live;
        lane.pointTimesMs[0] = 0.f;
        int outCount = 1;
        for (int i = nearest + 1; i < lane.pointCount; ++i) {
            lane.pointTimesMs[outCount] = std::max(0.f, lane.pointTimesMs[i] - tBase);
            lane.points[outCount] = Add(lane.points[i], shift);
            ++outCount;
        }
        lane.pointCount = outCount;   // nearest == last ⇒ single live point
    }
    if (liveCount != map.laneCount) return false;        // a lane's shot retired

    // Zones: rebuilt wholesale (cheap; classification is present-tense).
    RebuildZones(map, playerX, playerY, settings, nowMs);
    // Enemies + lock: RE-ANCHORED every frame from the live EnemyTracker snapshot
    // (previously left stale until the next server-tick BuildMap). Enemy bodies are
    // a HARD no-go, so a moving add's CURRENT position must be reflected each frame
    // — otherwise the immediate solve / step re-validation would clear a spot the
    // add has already walked onto. Cheap: EnemyTracker::Tick() is self-throttled.
    PopulateEnemies(map, playerX, playerY);
    return true;
}

bool IsHazardAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return false;
    const int tx = static_cast<int>(std::floor(worldX));
    const int ty = static_cast<int>(std::floor(worldY));
    const uint32_t key = TileKey(tx, ty);
    uint8_t cached = 0;
    if (MemoFind(key, cached)) return cached != 0;
    const bool hz = WorldTAB::IsTileDamagingLive(tx, ty);
    MemoInsert(key, hz ? 1 : 0);
    return hz;
}

bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    if (!IsFinitePoint(worldX, worldY)) return false;   // unknown → treat as blocked
    if (TestTAB::IsWalkPositionBlocked(worldX, worldY)) return false;
    if (safeWalk && IsHazardAt(worldX, worldY)) return false;
    return true;
}

} } // namespace UDodge::Sensors
