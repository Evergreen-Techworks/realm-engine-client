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
#include "features/movement/sensors/TileSensor.h"
#include "gui/tabs/WorldTAB.h"

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
// A bomb still in the air becomes HARD danger once it is within this long before
// detonation — enough time (~4 ticks) to walk clear of the blast radius. Larger =
// avoid earlier (safer, more disruptive); smaller = cut it closer.
constexpr float kAoeArmWindowMs  = 900.f;

// Per-tick memo for the hazard lookup: the core probes CanOccupy at hundreds of
// points per frame, so each distinct tile is queried at most once per tick.
// OUR OWN instance of the shared open-addressed table (Movement::TileSensor) —
// no per-frame heap allocation. Single game-update-thread consumer; cleared at
// the top of BuildMap/ReanchorMap.
Movement::TileSensor::HazardMemo s_hazardMemo;

using Movement::TileSensor::IsFinite;
using Movement::TileSensor::IsFinitePoint;
using Movement::TileSensor::DistSq;

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
bool LaneFromStraightExtrapolation(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
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

    // Cap the lane by the bullet's REMAINING travel: a bullet 15 ms from expiring
    // moves ~0 tiles, so extrapolating the full laneCap paints phantom danger where
    // it will never be. effCap = min(laneCap, tilesPerMs × remainingLifetime).
    float effCap = laneCap;
    if (IsFinite(p.lifetime) && p.lifetime > 0.f && IsFinite(elapsedMs) && tilesPerMs > 0.f) {
        const float remMs = p.lifetime - elapsedMs;
        if (!(remMs > 0.f)) return false;                        // already dead — no lane at all
        const float remTiles = tilesPerMs * remMs;
        if (IsFinite(remTiles) && remTiles > 0.f) effCap = std::min(laneCap, remTiles);
    }

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
        if (pathLen >= effCap) break;
    }
    return lane.pointCount >= 2;
}

// Anti-ghost clamp: a lane point must never sit far from the live bullet (points[0])
// — a single garbage predicted sample (bad positionAt / bad cache entry) would make
// the lane span the whole map and paint danger where there is no shot. The pathLen
// cap only checks AFTER appending, so one huge jump slips through; truncate the lane
// at the first point beyond a sane bound of the anchor.
bool ClampLaneToAnchor(LaneThreat& lane, float laneCap)
{
    if (lane.pointCount < 2) return false;
    const float maxD = laneCap + 4.f;      // legit points stay within laneCap of the anchor
    const float maxD2 = maxD * maxD;
    const Vec2 a = lane.points[0];
    for (int i = 1; i < lane.pointCount; ++i) {
        const float dx = lane.points[i].x - a.x, dy = lane.points[i].y - a.y;
        if (!std::isfinite(dx) || !std::isfinite(dy) || dx * dx + dy * dy > maxD2) {
            lane.pointCount = i;           // drop the garbage tail (keep the good near portion)
            return true;                   // a ghost point was caught
        }
    }
    return false;
}

// Trace one lane: cached path preferred, fresh trace fallback, then a straight
// live-heading extrapolation. Only when even that fails does the lane collapse
// to a single-point threat (the live disc still blocks).
void TraceLane(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
{
    const char* src = nullptr;
    bool clamped = false;
    if (LaneFromCachedPath(lane, p, elapsedMs, laneCap))            { clamped = ClampLaneToAnchor(lane, laneCap); src = "cache"; }
    else if (LaneFromFreshTrace(lane, p, elapsedMs, laneCap))       { clamped = ClampLaneToAnchor(lane, laneCap); src = "fresh"; }
    else if (LaneFromStraightExtrapolation(lane, p, elapsedMs, laneCap)) { clamped = ClampLaneToAnchor(lane, laneCap); src = "straight"; }
    if (src) {
        if (clamped) {
            static int s_ghostN = 0;
            if ((s_ghostN++ % 8) == 0)
                DBG_FILE_LOG("[UDodge] GHOST lane clamped src=" << src
                    << " bulletId=" << p.bulletId << " owner=" << p.ownerObjId
                    << " pos=(" << p.x << "," << p.y << ")"
                    << " elapsed=" << elapsedMs << " life=" << p.lifetime
                    << " wavy=" << (int)p.wavy << " param=" << (int)p.parametric
                    << " boomer=" << (int)p.boomerang << " turn=" << (int)p.isTurning
                    << " turnDel=" << (int)p.isTurningDelayed << " circDel=" << (int)p.isCircleTurnDelayed
                    << " accel=" << (int)p.isAccelerating);
        }
        return;
    }
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

        // HARD-avoid a bomb that has landed OR is about to land within the arm
        // window — you must be OUT of the blast radius by detonation, so the
        // dodge needs to treat the landing zone as danger NOW (not soft cost) while
        // there's still time to move clear. (zdodge treats enemy AOE as a hard
        // 9999-damage threat; udodge previously only avoided it AFTER it landed —
        // too late to escape the blast. That is why bombs were killing us.)
        const float landingMs = landAtMs - elapsedMs;             // >0 = still in the air
        const bool armingSoon = !hasLanded && landingMs <= kAoeArmWindowMs;

        ZoneThreat& z = out.zones[out.zoneCount++];
        z.pos = { a.destX, a.destY };
        z.radius = radius;
        z.active = hasLanded || armingSoon;
    }

    // TRANSITION-ONLY witness on "does AoE data reach the dodge at all?". The
    // AoE path has three places it can die silently — the game hooks never
    // install, the hooks install but record nothing, or zones are built but
    // never marked active — and until now NONE of them said anything in a
    // Release build, so "no AoE dodging" was indistinguishable between them.
    // Keyed on (zoneCount, activeCount) so a steady state is two int compares.
    //
    //   GREP THE TRACE LOG FOR:  [UDodge] zones:
    {
        int activeCount = 0;
        for (int i = 0; i < out.zoneCount; ++i) if (out.zones[i].active) ++activeCount;
        static int s_lastZoneCount = -1;
        static int s_lastActive    = -1;
        if (out.zoneCount != s_lastZoneCount || activeCount != s_lastActive) {
            s_lastZoneCount = out.zoneCount;
            s_lastActive    = activeCount;
            DBG_FILE_LOG("[UDodge] zones: " << out.zoneCount << " tracked, "
                << activeCount << " ACTIVE (hard-avoid)"
                << (out.zoneCount == 0 ? "  <-- no AoE reaching the dodge (check [AoeTracking] hooks:)" : ""));
        }
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

    // NEAREST-N, not FIRST-N. The snapshot is in arbitrary order, so filling the
    // array first-come and dropping the overflow kept an ARBITRARY subset: a
    // distant enemy that happened to appear earlier held a slot while a breakable
    // wall one tile ahead was dropped. Dropped blockers are invisible to
    // EnemyBlockedLocal (UDodgePathfinder.cpp) — that is how A* ended up routing
    // straight through walls. Evicting the farthest kept blocker instead
    // guarantees the retained set is the N NEAREST, which are the ones that
    // actually gate both the immediate solver and the near-field route.
    // `farthest*` is only meaningful once the array is full.
    int   farthestIdx    = -1;
    float farthestDistSq = -1.f;
    const auto refreshFarthest = [&]() {
        farthestIdx = 0;
        farthestDistSq = -1.f;
        for (int i = 0; i < out.enemyCount; ++i) {
            const float di = DistSq(out.enemies[i].pos.x, out.enemies[i].pos.y, playerX, playerY);
            if (di > farthestDistSq) { farthestDistSq = di; farthestIdx = i; }
        }
    };

    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        const float dSq = DistSq(e.x, e.y, playerX, playerY);
        if (dSq <= cullSq) {
            if (out.enemyCount < kMaxEnemies) {
                EnemyBlocker& b = out.enemies[out.enemyCount++];
                b.pos = { e.x, e.y };
                b.radius = kEnemyRadius;   // single baked source — no per-enemy size field exists
                if (out.enemyCount == kMaxEnemies) refreshFarthest();   // just filled
            } else {
                // Full: the snapshot exceeded capacity (still reported via
                // `limited`), but keep the NEARER of the two rather than the
                // one that merely arrived first.
                out.limited = true;
                if (dSq < farthestDistSq) {
                    EnemyBlocker& b = out.enemies[farthestIdx];
                    b.pos = { e.x, e.y };
                    b.radius = kEnemyRadius;
                    refreshFarthest();
                }
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
    s_hazardMemo.Clear();
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

    // Prune shots the game deleted early (wall/enemy/player hit) BEFORE reading the
    // tracked list, so their lanes vanish immediately instead of lingering to their
    // full lifetime. Throttled (~10 Hz) — reading the live pool is IL2CPP work — and
    // safe (never prunes on a failed read). Game-thread only (BuildMap runs there).
    {
        static ULONGLONG s_lastReconcileMs = 0;
        const ULONGLONG nowRec = GetTickCount64();
        if (nowRec - s_lastReconcileMs >= 100ULL) {
            s_lastReconcileMs = nowRec;
            ProjectileTracking::ReconcileWithLivePool();
        }
    }

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

        // WALL-HIT RETIREMENT (reliable, hook-free): a shot whose CENTER is inside a
        // wall tile has hit that wall — the game deletes it there — so retire it (the
        // lane vanishes immediately, and AutoNexus stops seeing it too) and skip.
        // Safe: a shot flying through open space or a 1-tile gap is never centered in
        // a wall tile, so this can NEVER drop a live shot. The age guard avoids a shot
        // that spawned right next to a wall being culled on its very first frames.
        {
            const float ageMs = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
            if (ageMs > 80.f &&
                WorldTAB::IsTileBlocked(static_cast<int>(std::floor(p.x)),
                                        static_cast<int>(std::floor(p.y)))) {
                ProjectileTracking::RetireProjectile(p);
                continue;
            }
        }

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
    s_hazardMemo.Clear();   // per-frame hazard memo reset (same contract as Build)

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

        // CURVED / non-linear shots (wavy, parametric, boomerang, turning,
        // accelerating) must NOT be re-anchored by a rigid nearest-point shift:
        // matching the "nearest point" on an oscillating/curving polyline can lock
        // onto the WRONG crest and translate the whole lane off the real bullet —
        // painting danger where there is no shot (and hiding real danger). Re-TRACE
        // them from the accurate cached positionAt path, anchored at the live time.
        // Straight shots keep the cheap exact rigid shift below.
        const bool curved = p.wavy || p.parametric || p.boomerang || p.isTurning ||
                            p.isTurningDelayed || p.isCircleTurnDelayed || p.isAccelerating;
        if (curved) {
            const float elapsedMs = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
            const float laneCap = std::clamp(settings.laneTiles, 2.f, 16.f);
            TraceLane(lane, p, elapsedMs, laneCap);   // identity + hitHalf preserved (TraceLane only sets the polyline)
        } else {
            // Re-anchor: rebase the polyline so the nearest lane point becomes the
            // projectile's LIVE position (exact for a straight line).
            int   nearest = 0;
            float bestDistSq = 3.402823466e+38f;
            for (int i = 0; i < lane.pointCount; ++i) {
                const float d = DistSq(lane.points[i].x, lane.points[i].y, p.x, p.y);
                if (d < bestDistSq) { bestDistSq = d; nearest = i; }
            }
            const Vec2 live  = { p.x, p.y };
            const Vec2 shift = Sub(live, lane.points[nearest]);
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
    return Movement::TileSensor::IsHazardAt(s_hazardMemo, worldX, worldY);
}

bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    return Movement::TileSensor::CanOccupy(s_hazardMemo, worldX, worldY, safeWalk);
}

} } // namespace UDodge::Sensors
