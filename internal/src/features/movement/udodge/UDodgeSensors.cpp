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
#include "gui/tabs/TestTAB.h"
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

// ── AoE arm window ──────────────────────────────────────────────────────────
// How long BEFORE a telegraphed blast lands it becomes HARD danger. This used to
// be a flat 900 ms "enough time (~4 ticks) to walk clear", but the time actually
// needed is the WALK-OUT time — (radius + kUPlayerHalf) / speed — and radius runs
// over the [0.2, 12] clamp below. Escaping the centre of a 12-tile blast at
// 5 tiles/s needs ~2.45 s; a 3.5-tile one needs ~0.75 s. 900 was right only near
// the default radius at a typical speed: it under-warned on big bombs and, now
// that an ACTIVE zone is an untraversable block for the pathfinder and a swept
// veto in the solver (not a soft cost), it over-blocked on small ones.
//
//   armWindow = clamp((radius + kUPlayerHalf) / speed + kAoeArmReactionMs, lo, hi)
//
// speed is the player's REAL tiles/ms — the same TestTAB::ReadDodgePlayerStats
// source the solver's in.speed comes from, so the window and the motion it is
// budgeting for agree.
//
// Reaction pad: 2 server ticks — one of input/ack latency plus one for the route
// to be replanned around the newly-armed disc. It also calibrates the formula to
// the value it replaces: at the 3.5-tile default radius and a typical ~7.7
// tiles/s (SPD 50), (3.5 + 0.21)/0.0077 + 400 ≈ 880 ms ≈ the old 900.
constexpr float kAoeArmReactionMs   = 2.f * kServerTickSec * 1000.f;   // 400 ms
// Floor: below ~1.5 server ticks the bot cannot act on the warning at all, so a
// shorter window is just a zone that flickers active for one frame before it lands.
constexpr float kAoeArmWindowMinMs  = 1.5f * kServerTickSec * 1000.f;  // 300 ms
// Ceiling: an armed disc HARD-BLOCKS routing, so this bounds how long one bomb may
// wall off its radius before it even lands. 8 server ticks covers a ~7.8-tile blast
// at SPD-50 speed outright (and more for a faster character, since the walk-out term
// scales with speed); a rarer 12-tile blast gets a truncated — not absent — warning
// rather than fencing off half the room for 2.5 s.
constexpr float kAoeArmWindowMaxMs  = 8.f * kServerTickSec * 1000.f;   // 1600 ms
// Speed unreadable (pre-first-NEWTICK, between worlds): fall back to the flat value
// this formula replaced rather than guessing a speed.
constexpr float kAoeArmWindowFallbackMs = 900.f;

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

// Does this shot follow a NON-LINEAR path? Wavy / parametric / boomerang /
// turning / accelerating shots can revisit the same neighbourhood on different
// legs of their flight, which is what makes a spatial "nearest cached sample"
// anchor unsafe for them. ONE predicate, shared by CachedAnchorIndex below and by
// ReanchorMap's re-trace branch, so the two can never disagree about what
// "curved" means.
bool IsCurvedShot(const WorldProjectile& p)
{
    return p.wavy || p.parametric || p.boomerang || p.isTurning ||
           p.isTurningDelayed || p.isCircleTurnDelayed || p.isAccelerating;
}

// Anchor index (which cached sample is the bullet's live position) — the sample
// the whole lane is rebased onto, so picking the wrong one time-shifts the ENTIRE
// polyline.
//
// FINDING H: this used to be spatial-nearest FIRST for every shot type, with the
// elapsed-time clock engaging only when the nearest sample was more than 5 tiles
// away (kMaxLiveAnchorDistSq). ReanchorMap already refuses a rigid nearest-point
// shift for curved shots for exactly the right reason — "matching the nearest
// point on an oscillating/curving polyline can lock onto the WRONG crest" — and
// then re-traces through TraceLane → LaneFromCachedPath → here, which promptly
// did the same nearest-point match one level down. A boomerang or tight-turning
// shot whose outbound and return legs pass within 5 tiles of each other anchors
// on the WRONG LEG and the whole lane is time-shifted: phantom danger painted on
// one leg, real danger missing from the other. The re-trace was defeating itself.
//
// So for a curved shot the ELAPSED CLOCK LEADS: the bullet's phase along its own
// path is what identifies the sample, and the clock is unambiguous where geometry
// is not. Spatial nearest is kept as a SANITY CHECK on that answer (a bad
// spawnTick / a stale cache would otherwise place the anchor nowhere near the
// live bullet) and remains the primary for straight shots, where the polyline
// never doubles back and nearest-point is exact and cheaper. The reversal is safe
// because the elapsed clock was ALREADY trusted enough to be the fallback here.
int CachedAnchorIndex(const WorldProjectile& p, float elapsedMs)
{
    const int count = std::clamp(p.pathSampleCount, 0, kWorldProjectilePathSampleCap);
    if (count <= 1) return 0;
    if (!IsFinitePoint(p.x, p.y)) return -1;

    // Sample whose cached timestamp is closest to the shot's age. -1 when the
    // clock is unusable (pre-first-tick, or no finite sample time).
    const auto byElapsed = [&]() -> int {
        if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return -1;
        int   bi = -1;
        float bestDelta = 3.402823466e+38f;
        for (int i = 0; i < count; ++i) {
            const float tcand = p.pathSampleTimesMs[i];
            if (!IsFinite(tcand)) continue;
            const float delta = std::fabs(tcand - elapsedMs);
            if (delta < bestDelta) { bestDelta = delta; bi = i; }
        }
        return bi;
    };

    // Sample nearest the live position; reports its distance² so the caller can
    // judge whether to believe it.
    const auto byNearest = [&](float& outDistSq) -> int {
        int   bi = -1;
        float bestDistSq = 3.402823466e+38f;
        for (int i = 0; i < count; ++i) {
            const float x = p.pathX[i], y = p.pathY[i];
            if (!IsFinitePoint(x, y)) continue;
            const float d = DistSq(x, y, p.x, p.y);
            if (d < bestDistSq) { bestDistSq = d; bi = i; }
        }
        outDistSq = bestDistSq;
        return bi;
    };

    // 5 tiles (25 tiles²). Same number in both directions: as the ceiling on how
    // far a believable anchor may sit from the live bullet, and as the sanity
    // bound on the clock's answer.
    constexpr float kMaxLiveAnchorDistSq = 25.f;

    if (IsCurvedShot(p)) {
        const int ti = byElapsed();
        if (ti >= 0) {
            // Sanity: the clock's sample must still land near the live bullet. If it
            // does not, the spawn clock or the cache is wrong, not the geometry —
            // fall through to the spatial answer rather than trusting a bad clock.
            const float dx = p.pathX[ti] - p.x, dy = p.pathY[ti] - p.y;
            if (IsFinitePoint(p.pathX[ti], p.pathY[ti]) &&
                dx * dx + dy * dy <= kMaxLiveAnchorDistSq)
                return ti;
        }
        float distSq = 3.402823466e+38f;
        const int ni = byNearest(distSq);
        return (ni >= 0 && distSq <= kMaxLiveAnchorDistSq) ? ni : -1;
    }

    // Straight shot: the polyline never doubles back, so nearest-point is exact
    // (and cheaper). Unchanged from before this finding, including the legacy
    // last-resort: when the clock is usable but no sample carries a finite time,
    // the far spatial answer is still handed back rather than losing the lane.
    float bestDistSq = 3.402823466e+38f;
    const int best = byNearest(bestDistSq);
    if (best >= 0 && bestDistSq <= kMaxLiveAnchorDistSq) return best;
    if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return -1;
    const int ti = byElapsed();
    return ti >= 0 ? ti : best;
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

// Should the trace stop here? The lane must reach BOTH the user's paint length
// (laneCap tiles — so the slider is never silently ignored) AND kLaneCoverMs of
// TIME (so the temporal lookahead is never blind inside its own horizon). The old
// rule was distance ONLY, which made time coverage a function of bullet speed and
// under-stated danger for fast shots — see kLaneCoverMs in UDodgeTypes.h.
inline bool LaneTraceDone(float pathLen, float laneCap, float tMs)
{
    return pathLen >= laneCap && tMs >= kLaneCoverMs;
}

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
    lane.tailAtShotEnd = false;
    float pathLen = 0.f;
    int   lastIdx = anchor;
    for (int i = anchor + 1; i < count && lane.pointCount < kMaxLanePoints; ++i) {
        if (!IsFinitePoint(p.pathX[i], p.pathY[i])) continue;
        const float sMs = p.pathSampleTimesMs[i];
        if (!IsFinite(sMs)) break;
        if (IsFinite(p.lifetime) && p.lifetime > 0.f && sMs > p.lifetime) {
            lane.tailAtShotEnd = true;   // stopped because the SHOT ends, not the trace
            break;
        }
        const Vec2 pt = { p.x + (p.pathX[i] - ax), p.y + (p.pathY[i] - ay) };
        pathLen += Len(Sub(pt, lane.points[lane.pointCount - 1]));
        lane.pointTimesMs[lane.pointCount] = std::max(0.f, sMs - tAnchor);
        lane.points[lane.pointCount++] = pt;
        lastIdx = i;
        if (LaneTraceDone(pathLen, laneCap, lane.pointTimesMs[lane.pointCount - 1])) break;
    }
    // Did the trace reach the shot's DEATH? CachePath pins its final sample exactly
    // on the lifetime whenever the shot dies inside the cached span, so consuming
    // that sample means we traced the shot out. A cache cut short by a failed
    // positionAt read — or by its own time budget — ends earlier, and that tail is
    // genuinely unknown.
    if (lastIdx == count - 1 && IsFinite(p.lifetime) && p.lifetime > 0.f &&
        IsFinite(p.pathSampleTimesMs[count - 1]) &&
        p.pathSampleTimesMs[count - 1] >= p.lifetime - 1.f)
        lane.tailAtShotEnd = true;
    if (lane.pointCount < 2) return false;
    // TIME COVERAGE. The cache spans a bounded window from SPAWN now
    // (kWorldProjectilePathCoverMs), so a long-lived shot eventually outruns it and
    // what is left of the cache ahead of the live anchor stops short of the
    // temporal horizon. Core::Temporal would honestly degrade that to the
    // present-tense floor — but a FRESH positionAt trace can still cover the full
    // kLaneCoverMs, so refuse here and let TraceLane fall through to it instead of
    // accepting a truncated lane. Only shots older than (cover − kLaneCoverMs) ever
    // reach this, and only until they die.
    if (!lane.tailAtShotEnd && lane.pointCount < kMaxLanePoints &&
        lane.pointTimesMs[lane.pointCount - 1] < kLaneCoverMs)
        return false;
    return true;
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
    lane.tailAtShotEnd = false;
    float pathLen = 0.f;
    // FINDING I: the loop used to run at most kMaxLanePoints−1 steps of
    // kTraceStepMs — 690 ms with the old 24-point budget, SHORTER than the 800 ms
    // temporal horizon no matter how slow the bullet was, so every fresh-traced
    // lane froze 110 ms early. kMaxLanePoints is now sized so (points−1) × step
    // reaches kLaneCoverMs (static_assert in UDodgeTypes.h), and the break below is
    // by time+distance rather than distance alone.
    for (int k = 1; lane.pointCount < kMaxLanePoints; ++k) {
        const float relMs = static_cast<float>(k) * kTraceStepMs;   // time from NOW
        const float tMs = elapsedMs + relMs;
        if (p.lifetime > 0.f && tMs > p.lifetime) {
            lane.tailAtShotEnd = true;   // stopped because the SHOT ends, not the trace
            break;
        }
        float x = 0.f, y = 0.f;
        if (!TryPredict(p, tMs, x, y)) break;   // prediction died → tail genuinely unknown
        const Vec2 pt = { x + offX, y + offY };
        pathLen += Len(Sub(pt, lane.points[lane.pointCount - 1]));
        // Time from NOW: k uniform kTraceStepMs steps ahead of the live anchor.
        lane.pointTimesMs[lane.pointCount] = relMs;
        lane.points[lane.pointCount++] = pt;
        if (LaneTraceDone(pathLen, laneCap, relMs)) break;
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

    // HARD cap by the bullet's REMAINING travel: a bullet 15 ms from expiring moves
    // ~0 tiles, so extrapolating further paints phantom danger where it will never
    // be. This is a lifetime fact, so it outranks the time/distance coverage rule
    // below (and reaching it means the tail IS the shot's end, not a lost trace).
    float remTilesCap = kHugeClearance;
    if (IsFinite(p.lifetime) && p.lifetime > 0.f && IsFinite(elapsedMs) && tilesPerMs > 0.f) {
        const float remMs = p.lifetime - elapsedMs;
        if (!(remMs > 0.f)) return false;                        // already dead — no lane at all
        const float remTiles = tilesPerMs * remMs;
        if (IsFinite(remTiles) && remTiles > 0.f) remTilesCap = remTiles;
    }

    lane.pointCount = 0;
    lane.pointTimesMs[lane.pointCount] = 0.f;
    lane.points[lane.pointCount++] = { p.x, p.y };   // live position = anchor
    lane.tailAtShotEnd = false;
    float pathLen = 0.f;
    while (lane.pointCount < kMaxLanePoints) {
        pathLen += stepDist;
        // stepDist == tilesPerMs × kTraceStepMs when speed is known, so each
        // spatial step is one kTraceStepMs of travel time (proxy when unknown).
        const float relMs = static_cast<float>(lane.pointCount) * kTraceStepMs;
        lane.pointTimesMs[lane.pointCount] = relMs;
        lane.points[lane.pointCount++] = { p.x + dx * pathLen, p.y + dy * pathLen };
        if (pathLen >= remTilesCap) { lane.tailAtShotEnd = true; break; }
        if (LaneTraceDone(pathLen, laneCap, relMs)) break;
    }
    return lane.pointCount >= 2;
}

// Sane SPAN bound (tiles from the live anchor) for a legitimate lane point. The
// trace is TIME-capped now, so the old "laneCap + 4" bound would chop off exactly
// the tail the temporal horizon needs on any bullet faster than laneCap/kLaneCoverMs.
// Bound by how far this bullet can actually travel in kLaneCoverMs instead —
// speed comes from the same field LaneFromStraightExtrapolation uses. A sanity
// ceiling covers an unreadable/absurd speed: a real ghost sample lands hundreds of
// tiles out (or non-finite), so it is still caught either way.
constexpr float kLaneSpanCeilTiles = 32.f;   // 2× the kThreatCullTiles projectile cull

float LaneSpanBound(const WorldProjectile& p, float laneCap)
{
    const float speedMul = (IsFinite(p.speedMul) && p.speedMul > 0.f) ? p.speedMul : 1.f;
    float travel = kLaneSpanCeilTiles;   // speed unknown → trust only the ceiling
    if (IsFinite(p.speed) && p.speed > 0.f) {
        travel = (p.speed / 10000.f) * speedMul * kLaneCoverMs;
        if (!IsFinite(travel) || travel < 0.f) travel = kLaneSpanCeilTiles;
    }
    return std::clamp(std::max(laneCap, travel), laneCap, kLaneSpanCeilTiles);
}

// Anti-ghost clamp: a lane point must never sit far from the live bullet (points[0])
// — a single garbage predicted sample (bad positionAt / bad cache entry) would make
// the lane span the whole map and paint danger where there is no shot. The pathLen
// cap only checks AFTER appending, so one huge jump slips through; truncate the lane
// at the first point beyond a sane bound of the anchor.
bool ClampLaneToAnchor(LaneThreat& lane, float spanBound)
{
    if (lane.pointCount < 2) return false;
    const float maxD = spanBound + 4.f;    // legit points stay within spanBound of the anchor
    const float maxD2 = maxD * maxD;
    const Vec2 a = lane.points[0];
    for (int i = 1; i < lane.pointCount; ++i) {
        const float dx = lane.points[i].x - a.x, dy = lane.points[i].y - a.y;
        if (!std::isfinite(dx) || !std::isfinite(dy) || dx * dx + dy * dy > maxD2) {
            lane.pointCount = i;           // drop the garbage tail (keep the good near portion)
            lane.tailAtShotEnd = false;    // whatever the tail meant, it is gone — treat as unknown
            return true;                   // a ghost point was caught
        }
    }
    return false;
}

// Resolve the PAINT span: how many leading polyline points the present-tense
// tests (and the overlay) treat as dangerous right now. This is the user's
// "Danger lane length (tiles)" slider, and it reproduces the OLD truncation
// semantics exactly — the point that CROSSES laneCap is included, like the old
// append-then-break loop did. Everything past instantCount exists purely so the
// temporal lookahead has samples out to its horizon.
void SetInstantSpan(LaneThreat& lane, float laneCap)
{
    if (lane.pointCount <= 0) { lane.instantCount = 0; return; }
    lane.instantCount = 1;
    // A legitimate paint point is at most laneCap of ARC from the anchor, so it is
    // always within laneCap straight-line distance too. Enforcing that here keeps
    // the instantaneous field's anti-ghost exposure exactly what it was before the
    // trace was lengthened: ClampLaneToAnchor's span bound had to widen (it now
    // bounds a full kLaneCoverMs of travel), and without this a surviving garbage
    // sample could be painted as a map-crossing wall of danger RIGHT NOW.
    const float maxAnchorD = laneCap + 4.f;
    float len = 0.f;
    for (int i = 1; i < lane.pointCount; ++i) {
        if (Len(Sub(lane.points[i], lane.points[0])) > maxAnchorD) break;
        len += Len(Sub(lane.points[i], lane.points[i - 1]));
        lane.instantCount = i + 1;
        if (len >= laneCap) break;
    }
}

// Trace one lane: cached path preferred, fresh trace fallback, then a straight
// live-heading extrapolation. Only when even that fails does the lane collapse
// to a single-point threat (the live disc still blocks).
void TraceLane(LaneThreat& lane, const WorldProjectile& p, float elapsedMs, float laneCap)
{
    const char* src = nullptr;
    bool clamped = false;
    const float span = LaneSpanBound(p, laneCap);
    if (LaneFromCachedPath(lane, p, elapsedMs, laneCap))            { clamped = ClampLaneToAnchor(lane, span); src = "cache"; }
    else if (LaneFromFreshTrace(lane, p, elapsedMs, laneCap))       { clamped = ClampLaneToAnchor(lane, span); src = "fresh"; }
    else if (LaneFromStraightExtrapolation(lane, p, elapsedMs, laneCap)) { clamped = ClampLaneToAnchor(lane, span); src = "straight"; }
    if (src) SetInstantSpan(lane, laneCap);
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
    lane.instantCount = 1;
    lane.tailAtShotEnd = false;   // no trajectory at all — the tail is unknown from t=0, and the
                                  // unknown-tail floor then reduces to "static disc at the live
                                  // position", which is exactly the old conservative treatment.
    lane.points[0] = { p.x, p.y };
    lane.pointTimesMs[0] = 0.f;   // trajectory unknown → temporal test treats it as static (conservative)
}

// The per-SOURCE arming rule (is this zone live from capture, or does it have a
// flight / telegraph phase to wait out?) is a property of the CAPTURE PATH, not
// of this consumer, so it lives with the producer: AoeTracking::ArmedOnCapture /
// LandDelayMs (AoeTracking.cpp carries the full per-source rationale). autonexus
// and pjdodge read the SAME functions - never re-derive a landing time from
// `arcMs` here, it is travel time ALREADY SPENT for kAoeSrcExpl.

// Per-zone arm window (ms before landing at which a telegraphed zone becomes hard
// danger). See the kAoeArmWindow* block above for the formula and its bounds.
// One divide per zone. `speedTilesPerMs` <= 0 means "player speed unreadable".
float ZoneArmWindowMs(float radius, float speedTilesPerMs)
{
    if (!IsFinite(speedTilesPerMs) || speedTilesPerMs <= 1e-5f)
        return kAoeArmWindowFallbackMs;
    const float walkOutMs = (radius + kUPlayerHalf) / speedTilesPerMs;
    if (!IsFinite(walkOutMs)) return kAoeArmWindowFallbackMs;
    return std::clamp(walkOutMs + kAoeArmReactionMs,
                      kAoeArmWindowMinMs, kAoeArmWindowMaxMs);
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

    // Player speed for the arm window, resolved AT MOST ONCE per rebuild and only
    // when a zone actually needs it (the common case is no zones at all, and
    // ReadDodgePlayerStats calls into the game to get the live move multiplier).
    // Same source and same tiles/ms conversion as the solver's in.speed.
    float speedTilesPerMs = -1.f;
    const auto playerSpeedTilesPerMs = [&]() -> float {
        if (speedTilesPerMs < 0.f) {
            int32_t hp = 0, maxHp = 0;
            float   spd = 0.f, tilesPerSec = 0.f;
            TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);
            speedTilesPerMs = (IsFinite(tilesPerSec) && tilesPerSec > 0.f)
                ? tilesPerSec / 1000.f : 0.f;
        }
        return speedTilesPerMs;
    };

    for (const WorldAoe& a : s_aoes) {
        if (!a.valid || !a.isDamaging) continue;
        if (a.isEnemyChecked && !a.isEnemy) continue;
        if (!IsFinitePoint(a.destX, a.destY)) continue;

        const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
        const float lifeMs = AoeTracking::LifetimeMs(a);
        // Armed-on-capture sources are live from elapsed=0; telegraphed ones land
        // at the end of their flight. Shared per-source rule - see AoeTracking.
        const float landAtMs = AoeTracking::LandDelayMs(a);
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
        const bool armingSoon = !hasLanded
            && landingMs <= ZoneArmWindowMs(radius, playerSpeedTilesPerMs());

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
        const bool curved = IsCurvedShot(p);   // ONE definition, shared with CachedAnchorIndex
        const float laneCap = std::clamp(settings.laneTiles, 2.f, 16.f);
        if (curved) {
            const float elapsedMs = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
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
            // The polyline lost its leading points, so the PAINT span has to be
            // re-measured from the new anchor (it is a distance along the polyline,
            // not a point count). tailAtShotEnd survives untouched: a rigid shift
            // keeps the same LAST point, so what that point meant is unchanged.
            // Coverage from NOW does shrink by the elapsed intra-tick time — that is
            // what kLaneCoverPadMs pads for; past the pad the unknown-tail floor in
            // Core::Temporal takes over rather than the freeze silently under-counting.
            SetInstantSpan(lane, laneCap);
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
