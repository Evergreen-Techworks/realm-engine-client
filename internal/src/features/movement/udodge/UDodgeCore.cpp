#include "pch-il2cpp.h"
#include "UDodgeCore.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

// UDodge core (plan 64) — pruned to the pure spatial safety primitives the
// per-tick solver uses. The 35-candidate reactive scoring machinery (probe-and-
// rank selection with tick-locked hysteresis) was retired with the reactive
// engine; the solver in UDodgeSolver now chooses among reachable points using
// PointSafety/PointSafe below.
namespace UDodge { namespace Core {
namespace {

// ── EXACT PRUNING for the all-lanes clearance loops (2026-09-12) ────────────
// PointSafety / SegmentSafety take a min over EVERY lane × every painted segment.
// The solver calls them for ~131 candidates per solve and the solve runs on the
// game thread, so with a few hundred shots on screen this loop was the solve:
// measured offline on the production solver, Solver::Solve cost 3.6 ms at 50
// lanes and 13 ms at 512 (callgrind: MinChebOnSegment + LaneDistCheb + SegSegCheb
// ≈ 65% of all instructions).
//
// A segment can only lower the running minimum if its bounding box is closer
// than that minimum, and the Chebyshev distance to a segment's axis-aligned box is
// a true LOWER BOUND on the Chebyshev distance to the segment (the segment lies
// inside its box). So a segment whose box gap already exceeds the running minimum
// is skipped. This never changes a result: kPruneSlackTiles is orders of magnitude
// larger than the float rounding in MinChebOnSegment, so a skipped segment's exact
// distance is strictly greater than the minimum it could not beat. The host suite
// (udodge_prune_tests) checks bit-identical results against the unpruned code.
constexpr float kPruneSlackTiles = 0.01f;

// Chebyshev distance from the origin to the axis-aligned box spanned by two points
// given RELATIVE to the query point. Lower bound on MinChebOnSegment(x0,y0,x1,y1).
inline float ChebBoxGap(float x0, float y0, float x1, float y1)
{
    const float gx = std::max({ 0.f, std::min(x0, x1), -std::max(x0, x1) });
    const float gy = std::max({ 0.f, std::min(y0, y1), -std::max(y0, y1) });
    return std::max(gx, gy);
}

// Chebyshev gap between the axis-aligned boxes of segments a→b and p→q. Lower
// bound on SegSegCheb(a, b, p, q) (a proper crossing forces boxes to overlap, so
// the zero-distance case is never pruned).
inline float ChebBoxGapSeg(Vec2 a, Vec2 b, Vec2 p, Vec2 q)
{
    const float abMinX = std::min(a.x, b.x), abMaxX = std::max(a.x, b.x);
    const float abMinY = std::min(a.y, b.y), abMaxY = std::max(a.y, b.y);
    const float pqMinX = std::min(p.x, q.x), pqMaxX = std::max(p.x, q.x);
    const float pqMinY = std::min(p.y, q.y), pqMaxY = std::max(p.y, q.y);
    const float gx = std::max({ 0.f, pqMinX - abMaxX, abMinX - pqMaxX });
    const float gy = std::max({ 0.f, pqMinY - abMaxY, abMinY - pqMaxY });
    return std::max(gx, gy);
}

// Min over the lane polyline of Chebyshev distance from p. A lane is dangerous
// NOW over its whole length — the spatial hit geometry every safety test below
// measures against.
//
// `cutoff`: the caller only cares about distances <= cutoff. The result is EXACT
// whenever the true minimum is <= cutoff; otherwise it is some value > cutoff
// (possibly kHugeClearance). The default keeps the plain exact behaviour.
float LaneDistCheb(const LaneThreat& L, Vec2 p, float cutoff = kHugeClearance)
{
    const int n = L.instantCount;   // PAINT span (laneTiles), not the full traced polyline
    if (n <= 0) return kHugeClearance;
    if (n == 1) return Cheb(L.points[0].x - p.x, L.points[0].y - p.y);
    float best = kHugeClearance;
    for (int j = 0; j + 1 < n; ++j) {
        const Vec2 a = L.points[j];
        const Vec2 b = L.points[j + 1];
        const float x0 = a.x - p.x, y0 = a.y - p.y;
        const float x1 = b.x - p.x, y1 = b.y - p.y;
        if (ChebBoxGap(x0, y0, x1, y1) > std::min(best, cutoff) + kPruneSlackTiles) continue;
        best = std::min(best, MinChebOnSegment(x0, y0, x1, y1));
    }
    return best;
}

// Do segments p1→p2 and p3→p4 PROPERLY intersect (strictly opposite sides)?
// Used by SegSegCheb to force a 0 clearance when the swept path crosses a lane —
// the convex endpoint-distance min below misses the interior-crossing case.
// Collinear-overlap (distance 0 without a proper crossing) is instead caught by
// the endpoint→segment checks (an endpoint lies on the other segment).
bool SegmentsIntersect(Vec2 p1, Vec2 p2, Vec2 p3, Vec2 p4)
{
    const auto cross = [](Vec2 o, Vec2 a, Vec2 b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    const float d1 = cross(p3, p4, p1);
    const float d2 = cross(p3, p4, p2);
    const float d3 = cross(p1, p2, p3);
    const float d4 = cross(p1, p2, p4);
    return ((d1 > 0.f && d2 < 0.f) || (d1 < 0.f && d2 > 0.f)) &&
           ((d3 > 0.f && d4 < 0.f) || (d3 < 0.f && d4 > 0.f));
}

// Min Chebyshev distance between segment a→b and segment p→q. The distance is a
// convex function over the (s,t) parameter box, so — absent a crossing — its
// minimum is attained on the box boundary, i.e. at one segment's endpoint to the
// other segment (the four MinChebOnSegment calls cover all four edges). A proper
// crossing is the only strictly-interior minimum (distance 0), handled explicitly.
float SegSegCheb(Vec2 a, Vec2 b, Vec2 p, Vec2 q)
{
    if (SegmentsIntersect(a, b, p, q)) return 0.f;
    float d = MinChebOnSegment(p.x - a.x, p.y - a.y, q.x - a.x, q.y - a.y);   // a → seg pq
    d = std::min(d, MinChebOnSegment(p.x - b.x, p.y - b.y, q.x - b.x, q.y - b.y)); // b → seg pq
    d = std::min(d, MinChebOnSegment(a.x - p.x, a.y - p.y, b.x - p.x, b.y - p.y)); // p → seg ab
    d = std::min(d, MinChebOnSegment(a.x - q.x, a.y - q.y, b.x - q.x, b.y - q.y)); // q → seg ab
    return d;
}

// Min Euclidean distance from point c to segment a→b (active-zone geometry uses
// Euclidean, matching PointSafety's zone term).
float PointSegDistEuclid(Vec2 c, Vec2 a, Vec2 b)
{
    const Vec2  ab = Sub(b, a);
    const float l2 = LenSq(ab);
    float t = 0.f;
    if (l2 > 1e-12f) t = std::clamp(Dot(Sub(c, a), ab) / l2, 0.f, 1.f);
    return Len(Sub(c, Add(a, Mul(ab, t))));
}

// Min EUCLIDEAN distance between segment a→b and segment p→q. Same convexity
// argument as SegSegCheb, with the Euclidean metric: absent a proper crossing the
// minimum sits at one segment's endpoint against the other segment. BEAMS ONLY —
// the game's laser job (JNHOCNOANFC::Execute, RVA 0x16468B0) is a Euclidean
// point-to-segment test, so a Chebyshev answer over-covers a beam diagonally by up
// to sqrt(2) and disagrees with SpacetimeCore, which already measures beams this
// way (SegmentSeparation). Ordinary shots keep SegSegCheb: their job IS per-axis.
float SegSegEuclid(Vec2 a, Vec2 b, Vec2 p, Vec2 q)
{
    if (SegmentsIntersect(a, b, p, q)) return 0.f;
    float d = PointSegDistEuclid(a, p, q);
    d = std::min(d, PointSegDistEuclid(b, p, q));
    d = std::min(d, PointSegDistEuclid(p, a, b));
    d = std::min(d, PointSegDistEuclid(q, a, b));
    return d;
}

float PositionUncertainty(const MapInput& in)
{
    return std::clamp(in.settings.positionUncertainty, 0.f, 0.35f);
}

// Projectile tests: point player (default) or the legacy padded half.
float LanePlayerHalf(const MapInput& in)
{
    return ProjectilePlayerHalf(in.settings) + PositionUncertainty(in);
}

// Zones describe damage discs against the player's physical footprint; they are
// not governed by the projectile threshold model and keep the full pad.
float ZonePlayerHalf(const MapInput& in)
{
    return kUPlayerHalf + PositionUncertainty(in);
}

// ── ONE CONTACT RULE (Tactician S3.4, contact-model-study.md) ───────────────
// Under tactician every spatial projectile test below measures against
// Contact::PlanHalf — the game's own proven box (T clamped, times the LIVE
// collisionRadiusMultiplier this map was built under) plus one fixed 0.10-tile
// cross-track comfort — and the player is a point, because the binary says it is.
// Under classic every formula is exactly what it was: T x the udodgeHitScale
// belief, plus whatever player half the caller folds in.
bool Tactician(const MapInput& in)
{
    return in.map && in.map->planner == Contact::Policy::Tactician;
}

// The shot's own half for a SPATIAL test (no player term).
//
// BEAMS (Slice 4a): the laser job applies NO multiplier of any kind — not the
// player's live collisionRadiusMultiplier and not the udodgeHitScale belief that
// mirrors it (Contact::TruthHalfBeam). Both policies therefore measure a beam
// against T itself; scaling it by the owner's 0.65 made every laser 35 % narrower
// than the one that actually hits.
float ShotHalf(const MapInput& in, const LaneThreat& L, float hitScale)
{
    if (L.beam) {
        return Tactician(in) ? Contact::PlanHalfBeam(L.hitHalf)
                             : std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf);
    }
    if (Tactician(in)) return Contact::PlanHalf(L.hitHalf, in.map->targetScale);
    return std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf) * hitScale;
}

// The player term folded into projectile tests: none under tactician (the game's
// player IS a point, and the comfort already lives in the box).
float LaneHalfFor(const MapInput& in)
{
    return Tactician(in) ? 0.f : LanePlayerHalf(in);
}

} // namespace

float ProjectilePlayerHalf(const Settings& settings)
{
    return settings.pointPlayer ? 0.f : kUPlayerHalf;
}

// "Could the player stand at `pos` right now?" — on standable ground, outside
// every danger lane (Chebyshev > hitHalf × hitScale) and outside every ACTIVE
// zone. Pending zones do NOT block (cost-only). Enemy bodies NOT checked.
// NOTE: omits the player half-extent — see PointSafety for the server-accurate
// test the solver uses. Kept for callers / overlay that want raw bullet geometry.
bool PointClear(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    if (!CanOccupyAt(in, pos))
        return false;   // wall, or hazard endpoint when safeWalk is on
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        const float half = ShotHalf(in, L, hitScale);
        if (LaneDistCheb(L, pos) <= half) return false;
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        // Pending (not-yet-landed) zones do NOT block — they are cost-only.
        if (z.active && Len(Sub(z.pos, pos)) <= z.radius) return false;
    }
    return true;
}

float PointClearance(const MapInput& in, Vec2 pos)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.instantCount <= 0) continue;
        const float half = ShotHalf(in, L, hitScale);
        best = std::min(best, LaneDistCheb(L, pos) - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        // Pending zones are cost-only (soft) — only active discs subtract clearance.
        if (z.active) best = std::min(best, Len(Sub(z.pos, pos)) - z.radius);
    }
    return best;
}

// Server-accurate clearance (plan 64): PointClearance with the player half-extent
// folded into every subtracted lane half and active-zone radius — the divergence
// fix. The game hit test is |dx|,|dy| < bulletHalf·scale + kPlayerHalf, so a point
// is truly outside a shot only when Cheb − (half + kUPlayerHalf) > 0.
// Hard floor for the TEMPORAL admission path: is `pos` clear of every ACTIVE AoE
// disc? Core::Temporal models BULLET LANES ONLY — it has no zone storage at all,
// so Temporal::PathClear returns true for a cell dead-centre in a live blast when
// no bullet happens to cross it. That is fine for bullets (they move, so threading
// them is legitimate and intended) but wrong for an AoE disc, which is static area
// denial — there is nothing to thread. Without this floor the reflex loop admits
// standing inside a bomb, the clearance clamp erases the negative zone penetration
// from the score, and the weave reward then makes standing there the WINNER.
// (Regression introduced with the temporal admission path; AoE dodging silently
// stopped while bullet dodging kept working, because only lanes were modelled.)
//
// ENDPOINT-ONLY, deliberately: a swept test would also veto every candidate that
// LEAVES a disc the player is already standing in — starving admission exactly
// when escape matters most. Mirrors the active-zone half of PointSafety below;
// pending (not yet armed) zones stay soft/cost-only, same as there.
bool ZoneClear(const MapInput& in, Vec2 pos)
{
    if (!in.map) return true;
    const float playerHalf = ZonePlayerHalf(in);
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;
        if (Len(Sub(z.pos, pos)) - (z.radius + playerHalf) < 0.f) return false;
    }
    return true;
}

// SWEPT zone floor for a temporal-admission MOVE. Same job as ZoneClear, but for
// the straight player move `from`→`to` rather than a single point: a solver step
// is up to ~1.9 tiles, which comfortably crosses a 1-tile blast disc with BOTH
// endpoints clear. Endpoint-only there is a real hole — Temporal::PathClear cannot
// see it either (Ctx is lane-only), so nothing else would catch it.
//
// The endpoint-only rationale above is preserved, not discarded — it is exactly
// right for ONE case and now applies only to that case: when `from` is ALREADY
// inside an active disc, every move out of it necessarily sweeps the disc, so a
// swept test would veto every candidate precisely when escape matters most.
// There we keep the endpoint rule, which still refuses a step that ENDS inside a
// disc while admitting the ones that leave. Everywhere else the sweep applies.
//
// Cost: the same shape as SegmentSafety's zone term (zoneCount <= kMaxAoes, one
// point-segment distance each) and typically zero work — zoneCount is 0 in most
// rooms, and the loop does not run at all then.
bool ZonePathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!in.map) return true;
    const float playerHalf = ZonePlayerHalf(in);
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;                          // pending zones stay cost-only
        const float radius = z.radius + playerHalf;
        // Relax only the disc we are escaping. Being inside one blast must not
        // allow the escape segment to cross a different blast with clear ends.
        if (Len(Sub(from, z.pos)) < radius) {
            if (Len(Sub(to, z.pos)) < radius) return false;
        } else if (PointSegDistEuclid(z.pos, from, to) < radius) {
            return false;
        }
    }
    return true;
}

bool ZoneEscapePathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!in.map) return true;
    const Vec2 step = Sub(to, from);
    const float playerHalf = ZonePlayerHalf(in);
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;
        const float radius = z.radius + playerHalf;
        const Vec2 start = Sub(from, z.pos);
        if (Len(start) < radius) {
            // Squared distance along a straight step has derivative
            // 2*(dot(start,step) + t*dot(step,step)). Nonnegative at t=0
            // means the whole step moves outward, even if escape takes ticks.
            if (Dot(start, step) < 0.f) return false;
        } else if (PointSegDistEuclid(z.pos, from, to) < radius) {
            return false;
        }
    }
    return true;
}

float PointSafety(const MapInput& in, Vec2 pos)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    const float laneHalf = LaneHalfFor(in);
    const float zoneHalf = ZonePlayerHalf(in);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.instantCount <= 0) continue;
        const float half = ShotHalf(in, L, hitScale) + laneHalf;
        // Exact pruning: a lane can only lower `best` if its distance is below
        // best + half; the slack keeps the float subtraction below on the same
        // side of `best` as the unpruned loop (see kPruneSlackTiles).
        best = std::min(best, LaneDistCheb(L, pos, best + half + kPruneSlackTiles) - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        // Pending zones are cost-only (soft) — only active discs subtract clearance.
        if (z.active) best = std::min(best, Len(Sub(z.pos, pos)) - (z.radius + zoneHalf));
    }
    return best;
}

bool PointSafe(const MapInput& in, Vec2 pos, float pad)
{
    if (!in.map) return false;
    if (!CanOccupyAt(in, pos))
        return false;   // wall, or hazard endpoint when safeWalk is on
    return PointSafety(in, pos) >= pad;
}

// Server-accurate SWEPT-segment clearance (plan 78, Fix B): PointSafety extended
// from a point to the straight player move A→B. The reflex acceptance requires
// this in addition to the endpoint PointSafety, so a thin lane crossing between
// the player and the chosen step cannot clip the player mid-move. Pending zones
// are cost-only (excluded); walls/hazard are the caller's occupancy concern.
float SegmentSafety(const MapInput& in, Vec2 a, Vec2 b)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    const float laneHalf = LaneHalfFor(in);
    const float zoneHalf = ZonePlayerHalf(in);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        const int n = L.instantCount;   // PAINT span, same as LaneDistCheb
        if (n <= 0) continue;
        const float half = ShotHalf(in, L, hitScale) + laneHalf;
        float dCheb;
        if (n == 1) {
            // Point lane: min Cheb from the single bullet point to the swept segment.
            dCheb = MinChebOnSegment(L.points[0].x - a.x, L.points[0].y - a.y,
                                     L.points[0].x - b.x, L.points[0].y - b.y);
        } else {
            // Exact pruning (see kPruneSlackTiles): skip a lane segment whose box is
            // already farther than both this lane's running minimum and the distance
            // that could still lower `best`.
            const float cutoff = best + half + kPruneSlackTiles;
            dCheb = kHugeClearance;
            for (int j = 0; j + 1 < n; ++j) {
                if (ChebBoxGapSeg(a, b, L.points[j], L.points[j + 1]) >
                    std::min(dCheb, cutoff) + kPruneSlackTiles) continue;
                dCheb = std::min(dCheb, SegSegCheb(a, b, L.points[j], L.points[j + 1]));
            }
        }
        best = std::min(best, dCheb - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;   // pending zones are cost-only
        best = std::min(best, PointSegDistEuclid(z.pos, a, b) - (z.radius + zoneHalf));
    }
    return best;
}

bool EnemyBlocked(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& e = in.map->enemies[i];
        // PHYSICAL body only. kUEnemyKeepoutGap is deliberately NOT added here: it is
        // a resting-point PREFERENCE and is already applied as the standoff SCORE
        // (Solver::Evaluate -> enemyGap, "score only, never a filter"). Adding it to
        // this HARD filter too made the no-go radius (e.radius + kUPlayerHalf + 0.75)
        // exceed the candidate step distance, so while fighting or looting — i.e.
        // whenever the player is within a body-length of a mob, which is the whole
        // point of weapon range — EVERY candidate was vetoed. Solve then found no safe
        // candidate, the least-bad fallback could not beat a stand clearance of 1e9
        // (nothing was actually shooting), and it returned Surrounded and HELD:
        // observed as NO-MOVE kind=3 clr=1e+09 for 15 s at a time after a kill, on a
        // loot detour, or when a new quest goal arrived. The soft term still pushes
        // the player off mobs; it just no longer freezes them.
        if (Len(Sub(pos, e.pos)) < EnemyAvoidanceRadius(e, in.settings)) return true;
    }
    return false;
}

// SWEPT enemy-body test for a MOVE (finding J). Endpoint-only was a real hole:
// the solver's step reaches ~1.9 tiles while an enemy no-go circle is only
// ~1.01 tiles across (kEnemyRadius 0.8 + kUPlayerHalf), so a step could enter and
// leave a mob between its two tested endpoints and neither end would notice.
// Geometry mirrors SegmentSafety's active-zone term exactly — min Euclidean
// distance from the body centre to the segment, against radius + kUPlayerHalf.
//
// The escape hatch is the same one ZonePathClear needs, for the same reason: if
// `from` already sits inside a body (a mob walked onto us), EVERY move out of it
// sweeps that body, so a swept veto would refuse every candidate at the one
// moment escape matters most. There we keep the endpoint rule, which still
// refuses a step that ENDS inside a body while admitting the ones that leave.
bool EnemyPathBlocked(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!in.map) return false;
    if (EnemyBlocked(in, from)) return EnemyBlocked(in, to);   // escaping a body: endpoint rule
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& e = in.map->enemies[i];
        if (PointSegDistEuclid(e.pos, from, to) <
            EnemyAvoidanceRadius(e, in.settings)) return true;   // physical body only — see EnemyBlocked
    }
    return false;
}

bool EnemyEscapePathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!in.map) return true;
    const Vec2 step = Sub(to, from);
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& enemy = in.map->enemies[i];
        const float radius = EnemyAvoidanceRadius(enemy, in.settings);
        const Vec2 start = Sub(from, enemy.pos);
        if (Len(start) < radius) {
            if (Dot(start, step) < 0.f) return false;
        } else if (PointSegDistEuclid(enemy.pos, from, to) < radius) {
            return false;
        }
    }
    return true;
}

// Pending-zone penetration sum (finding G-2). Deliberately NOT folded into
// PointSafety / SegmentSafety / PointClear: those are the HARD safety floor and a
// telegraphed blast is not yet danger — folding it in would silently turn a soft
// preference into a block, which is the failure mode the "cost-only" contract
// exists to prevent. Cheap: zoneCount is 0 in most rooms and bounded by kMaxAoes.
float PendingZoneCost(const MapInput& in, Vec2 pos)
{
    if (!in.map) return 0.f;
    float sum = 0.f;
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (z.active) continue;                       // armed discs are the HARD case
        const float pen = (z.radius + kUPlayerHalf) - Len(Sub(pos, z.pos));
        if (pen > 0.f) sum += pen;
    }
    return sum;
}

// ── Shared arrival-time bullet-prediction model (plan 72) ────────────────────
// Merged verbatim from the two former copies (solver TempCtx/TemporalPathClear
// + pathfinder BuildTempCtx/BulletPosAt/ArrivalClear); the cull center/radius is
// parameterized (see the header + plan 72 divergence note). Pure plain-data.
namespace Temporal {

// Sample one lane's bullet position at each march time by interpolating its
// spacetime polyline (points + pointTimesMs). Monotone cursor over the polyline
// as t increases → O(points + samples). Beyond the traced horizon the position
// clamps to the last traced point — the CONSERVATIVE-FREEZE contract: a bullet
// whose trace runs out before the sample time is assumed frozen where prediction
// ends, never extrapolated forward (extrapolating a curved shot past its trace is
// how ghost lanes appear — see ClampLaneToAnchor, UDodgeSensors.cpp).
//
// That clamp is only safety-positive where the freeze point is a FACT — i.e. the
// lane was traced to the shot's death. It is NOT safety-positive where the trace
// merely ran out mid-flight: the frozen sample then reads as "a parked bullet in a
// known-safe place" and every cell the shot really sweeps afterwards reads CLEAR.
// That is exactly what the distance-capped lane trace used to produce (a 12-tile
// lane on a 25 tiles/s shot covered 480 ms of an 800 ms horizon), so the invariant
// this comment used to assert was false for precisely the fast shots it mattered
// for. Two things now hold it up: lanes are traced by TIME (kLaneCoverMs,
// UDodgeTypes.h) so the clamp normally never fires inside the horizon, and where a
// trace still falls short, Ctx::trust marks the prefix and the queries stop
// trusting the frozen tail (see UNKNOWN TAIL below).
// Sample a lane's spacetime polyline at `count` times starting at `firstMs`,
// spaced kUTemporalStepMs apart. Used for both the march grid (firstMs = 0) and
// the fast-lane half-step refinement (firstMs = ½·step).
static void SampleLaneTimes(const LaneThreat& L, float firstMs, int count, Vec2* outPos)
{
    const int cnt = L.pointCount;
    if (cnt <= 0) { for (int k = 0; k < count; ++k) outPos[k] = Vec2{}; return; }
    if (cnt == 1) { for (int k = 0; k < count; ++k) outPos[k] = L.points[0]; return; }

    int seg = 0;
    for (int k = 0; k < count; ++k) {
        const float t = firstMs + static_cast<float>(k) * kUTemporalStepMs;
        while (seg + 1 < cnt - 1 && t > L.pointTimesMs[seg + 1]) ++seg;
        const float t0 = L.pointTimesMs[seg];
        const float t1 = L.pointTimesMs[seg + 1];
        if (t <= t0)       outPos[k] = L.points[seg];
        else if (t >= t1)  outPos[k] = L.points[seg + 1];   // clamp at path end
        else {
            const float f = (t - t0) / std::max(t1 - t0, 1e-3f);
            outPos[k] = Add(L.points[seg], Mul(Sub(L.points[seg + 1], L.points[seg]), f));
        }
    }
}

void SampleLane(const LaneThreat& L, Vec2* outPos)
{
    SampleLaneTimes(L, 0.f, kSamples, outPos);
}

// ── EXACT BROAD PHASE for the lane queries (2026-09-18) ─────────────────────
// Measured on the dense boss scenarios with a ring search running: EdgeClear was
// 87-89 % of the pathfinder's time, every relaxed edge marched against all 38-39
// lanes in the cull radius, and 97 % of those lane visits were lanes nowhere near
// the edge. Ctx::reach lets a query drop such a lane with four compares.
//
// WHY A SKIP CAN NEVER CHANGE AN ANSWER. Every narrow-phase test below has the form
//     ChebyshevDistance(lane point, player point) <= half + arrPad
// (MinChebOnSegment over a relative segment, SegSegCheb against the traced path, or
// Cheb at one instant). Every lane point it can read is a stored sample or a convex
// combination of two stored samples, so it lies in the box of the samples; every
// player point lies on the queried segment, so it lies in the box of its two ends.
// If those boxes are further apart than half + arrPad on either axis, that axis
// alone keeps every such distance above half + arrPad: no test can fire.
//
// ROUNDING. The narrow phase works in float: an interpolated point can land a few
// ulp outside its box and the closed-form minimum adds a few more. The slack is an
// absolute kBroadSlackTiles (the same 0.01 tile the PointSafety pruning above uses)
// plus kBroadSlackRel of the largest coordinate involved, taken on the lane side at
// Build and on the player side per query. kBroadSlackRel is ~33 ulp; the narrow
// phase accumulates under 15, so the bound holds at any finite coordinate, not only
// at realm scale (2048 tiles, where 33 ulp is 0.008 tile).
//
// THE ONE TEST THAT IS NOT A DISTANCE. SegSegCheb (the traced-path floor, reached by
// beams, short traces and windows that run past the trusted end) returns 0 when its
// crossing test fires, and that test is SIGN arithmetic on cross products, not a
// distance. In exact arithmetic two segments that cross have overlapping boxes; in
// float the test can fire on four nearly collinear points of two segments that are
// well apart (measured: an edge on a beam's own line, 0.89 tile past its end, contact
// size 0.84, read as a crossing). That answer is a false contact, but it is the
// answer this code gives, and this broad phase changes no answer. So a lane out of
// reach is dropped outright only where the crossing test cannot be reached (not a
// beam, window inside the trusted prefix); where it can, the lane still goes through
// TracedPathClear with `distancesClear` set, which keeps the crossing test and skips only
// the distances the boxes have already settled.
//
// A skip only ever says "this distance cannot be within the contact size", so a wrong
// margin can only show up as a missed contact. udodge_temporal_broadphase_tests runs
// every query against the plain all-lanes code and requires identical answers.
constexpr float kBroadSlackTiles = 0.01f;
constexpr float kBroadSlackRel   = 4.0e-6f;

// The box nothing lies outside of: a lane or a query carrying it is never skipped.
static inline Ctx::Box EverywhereBox()
{
    const float inf = std::numeric_limits<float>::infinity();
    return { -inf, -inf, inf, inf };
}

// Box of every position the queries can read for lane `li`, grown by its contact
// size and the slack. Call once the lane's samples, half and arrPad are final.
static void SetReach(Ctx& c, int li)
{
    float minX = c.pos[li][0].x, maxX = minX;
    float minY = c.pos[li][0].y, maxY = minY;
    float sum = 0.f, big = 0.f;
    const auto take = [&](Vec2 p) {
        minX = std::min(minX, p.x); maxX = std::max(maxX, p.x);
        minY = std::min(minY, p.y); maxY = std::max(maxY, p.y);
        sum += p.x + p.y;                                   // NaN or infinity anywhere poisons it
        big = std::max(big, Cheb(p.x, p.y));
    };
    for (int k = 0; k < kSamples; ++k) take(c.pos[li][k]);
    if (c.sub[li])
        for (int k = 0; k < kUTemporalSteps; ++k) take(c.mid[li][k]);
    // The along-track stretch moves a sampled point by at most speed x alongMs,
    // so the box has to hold it too or the broad phase could drop a real contact.
    const float grow = c.half[li] + c.arrPad[li] + c.speed[li] * c.alongMs +
                       kBroadSlackTiles + kBroadSlackRel * big;
    if (!std::isfinite(sum) || !std::isfinite(grow)) {
        c.reach[li] = EverywhereBox();                      // never skipped: the narrow phase decides
        return;
    }
    c.reach[li] = { minX - grow, minY - grow, maxX + grow, maxY + grow };
}

// Box of a player path that stays on the segment a→b, grown by the player-side
// rounding slack. Non-finite input gives the infinite box, which skips nothing.
static inline Ctx::Box PlayerBox(Vec2 a, Vec2 b)
{
    if (!std::isfinite(a.x + a.y + b.x + b.y)) return EverywhereBox();
    const float slack = kBroadSlackRel * std::max(Cheb(a.x, a.y), Cheb(b.x, b.y));
    return { std::min(a.x, b.x) - slack, std::min(a.y, b.y) - slack,
             std::max(a.x, b.x) + slack, std::max(a.y, b.y) + slack };
}

// True when the player's box lies wholly outside the lane's reach. Written so that
// any NaN compares false, i.e. "not outside".
static inline bool OutOfReach(const Ctx::Box& lane, const Ctx::Box& player)
{
    return player.minX > lane.maxX || player.maxX < lane.minX ||
           player.minY > lane.maxY || player.maxY < lane.minY;
}

// Build the temporal context: predict every lane's future positions once, and
// cull lanes whose whole traced path stays > cullTiles from cullCenter over the
// horizon (far / receding shots contribute nothing to the search region).
void Build(const DangerMap& map, float hitScale, float positionUncertainty, Vec2 cullCenter,
           float cullTiles, Ctx& out, float playerHalf)
{
    out.count = 0;
    const float scale = std::clamp(hitScale, 0.25f, 2.5f);
    // ONE CONTACT RULE (S3.4). Under tactician the box is the game's own (the map's
    // live hitbox multiplier) plus cross-track comfort, the player is a point, and
    // the timing uncertainty becomes an along-track stretch in the queries instead
    // of an isotropic pad. hitScale / positionUncertainty / playerHalf are ignored.
    const bool tactician = map.planner == Contact::Policy::Tactician;
    out.alongMs = tactician ? Contact::kAlongPadMs : 0.f;
    for (int i = 0; i < map.laneCount && out.count < kMaxProjectiles; ++i) {
        const LaneThreat& L = map.lanes[i];
        if (L.pointCount <= 0) continue;
        // Cull against the SOURCE polyline, not isolated march samples. A fast
        // shot can cross the entire search region between two sampled endpoints.
        float minD = Len(Sub(L.points[0], cullCenter));
        float maxSpeed = 0.f;
        for (int j = 1; j < L.pointCount; ++j) {
            minD = std::min(minD, PointSegDistEuclid(cullCenter, L.points[j - 1], L.points[j]));
            const float dt = L.pointTimesMs[j] - L.pointTimesMs[j - 1];
            if (dt > 1e-3f)
                maxSpeed = std::max(maxSpeed, Len(Sub(L.points[j], L.points[j - 1])) / dt);
        }
        // BEAMS (Slice 4a): T unscaled under BOTH policies — the laser job carries no
        // multiplier slot at all, so neither hitScale nor the live collider value may
        // shrink it. The classic player/uncertainty pads stay, since they are that
        // policy's comfort, not a belief about the shot's size.
        const float hitHalf = L.beam
            ? (tactician ? Contact::PlanHalfBeam(L.hitHalf)
                         : std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf) + std::max(playerHalf, 0.f) +
                           std::clamp(positionUncertainty, 0.f, 0.35f))
            : (tactician
                ? Contact::PlanHalf(L.hitHalf, map.targetScale)
                : std::clamp(L.hitHalf, 0.05f, kUMaxProjectileHalf) * scale + std::max(playerHalf, 0.f) +
                  std::clamp(positionUncertainty, 0.f, 0.35f));
        const float timingPad = tactician
            ? 0.f
            : kUArrivalMargin + std::min(maxSpeed * kUPredErrMs, kUPredPadMaxTiles);
        // Euclidean broad phase encloses the complete Chebyshev hit square. The
        // along-track stretch reaches one alongMs of travel further each way.
        if (minD > cullTiles + 1.414214f * (hitHalf + timingPad + maxSpeed * out.alongMs)) continue;
        if (L.beam && L.pointCount >= 2) {
            const int idx = out.count++;
            out.beam[idx] = true;
            out.pos[idx][0] = L.points[0];
            for (int k = 1; k < kSamples; ++k) out.pos[idx][k] = L.points[L.pointCount - 1];
            out.half[idx] = hitHalf;
            // A beam never had the speed term; under tactician its comfort is
            // already inside PlanHalf, so there is nothing left to add.
            out.arrPad[idx] = tactician ? 0.f : kUArrivalMargin;
            out.speed[idx] = 0.f;
            out.sub[idx] = false;
            out.trust[idx] = kUTemporalSteps;
            out.expiresMs[idx] = L.remainingLifeMs >= 0.f ? L.remainingLifeMs + kUPredErrMs : 0.f;
            SetReach(out, idx);
            continue;
        }
        Vec2 samples[kSamples];
        SampleLane(L, samples);
        const int idx = out.count++;
        out.beam[idx] = false;
        for (int k = 0; k < kSamples; ++k) out.pos[idx][k] = samples[k];
        out.half[idx] = hitHalf;
        // FAST LANE? The swept-segment queries chord this lane between march
        // samples; if it travels far enough per step for that chord to diverge
        // from its real (possibly curving) path, sample the half-steps too so the
        // queries follow the path in two pieces instead of one. Only fast lanes
        // pay for this — one extra SampleLaneTimes here and one extra segment
        // test per step in the queries.
        out.sub[idx] = (maxSpeed * kUTemporalStepMs > kUTemporalMaxSweepTiles);
        // Use the fastest SOURCE segment: returning endpoints can hide both
        // fast motion and the timing error that motion needs to absorb.
        out.speed[idx]  = maxSpeed;
        out.arrPad[idx] = timingPad;
        if (out.sub[idx])
            SampleLaneTimes(L, kUTemporalStepMs * 0.5f, kUTemporalSteps, out.mid[idx]);
        // Bound the geometry lost when resampling the source trace. Even 50 ms
        // samples can alias an oscillation into a stationary point. Between the
        // union of source vertices and march knots, both paths are linear, so
        // their max Chebyshev difference occurs at a vertex. At march knots the
        // difference is zero by construction; testing source vertices suffices.
        // Fold the bound into query clearance once per lane, with no new arrays
        // or per-candidate work. This bounds the supplied trace, not unobserved
        // motion between the sensor's own samples.
        float curveError = 0.f;
        for (int j = 0; j < L.pointCount; ++j) {
            const float t = L.pointTimesMs[j];
            if (t < 0.f || t >= kHorizonMs) continue;
            const int k = static_cast<int>(t / kUTemporalStepMs);
            const float f = (t - k * kUTemporalStepMs) / kUTemporalStepMs;
            Vec2 approx;
            if (out.sub[idx]) {
                const Vec2 a = f <= 0.5f ? out.pos[idx][k] : out.mid[idx][k];
                const Vec2 b = f <= 0.5f ? out.mid[idx][k] : out.pos[idx][k + 1];
                approx = Add(a, Mul(Sub(b, a), f <= 0.5f ? 2.f * f : 2.f * f - 1.f));
            } else {
                approx = Add(out.pos[idx][k], Mul(Sub(out.pos[idx][k + 1], out.pos[idx][k]), f));
            }
            const Vec2 error = Sub(L.points[j], approx);
            curveError = std::max(curveError, Cheb(error.x, error.y));
        }
        out.arrPad[idx] += curveError;
        // TRUSTED PREFIX. A trace covering the known lifetime can use its final
        // point during the short expiry grace; queries ignore it after expiry.
        // Otherwise trust only the marched steps the trace actually reached;
        // the queries fall back to the
        // present-tense floor past that. Note this also catches COVERAGE DECAY: a
        // lane traced at the last server tick loses time-from-now on every mid-tick
        // re-anchor, which no per-trace flag would ever see.
        const float tracedMs = L.pointTimesMs[L.pointCount - 1];
        const float life = std::isfinite(L.remainingLifeMs) && L.remainingLifeMs >= 0.f
            ? L.remainingLifeMs : (L.tailAtShotEnd ? tracedMs : -1.f);
        // Keep the existing timing uncertainty as a short late-expiry grace.
        // Unknown trace ends are NOT evidence that the projectile has died.
        out.expiresMs[idx] = life >= 0.f ? life + kUPredErrMs : 0.f;
        if ((life >= 0.f && tracedMs >= life) || !(tracedMs < kHorizonMs)) {
            out.trust[idx] = kUTemporalSteps;
        } else {
            const int t = static_cast<int>(std::floor(tracedMs / kUTemporalStepMs));
            out.trust[idx] = std::clamp(t, 0, kUTemporalSteps);
        }
        SetReach(out, idx);   // after arrPad has taken the curve error
    }
}

// ── UNKNOWN TAIL floor (the honest freeze) ──────────────────────────────────
// For a lane whose trace stopped short while the shot was still alive, the samples
// past c.trust[li] are the clamp holding the last traced point still. Reading that
// as a parked bullet is the silent UNDER-count; extrapolating instead is how ghost
// lanes appear. The honest third option is to drop back to the PRESENT-TENSE model
// for that lane past its trusted end: the bullet is somewhere on the path we DID
// trace, so treat that whole traced prefix as dangerous — which is precisely what
// the instantaneous floor (PointSafety over the lane polyline) already asserts.
//
// CHOSEN over "hard-block the lane past tEnd" because it cannot starve admission:
// it only forbids positions on/near a polyline that PointSafety forbids anyway, so
// it never removes a candidate the conservative floor would have kept. It only
// stops the temporal layer LIFTING that floor on a lane it can no longer see.
//
// Cost is bounded and paid by truncated lanes only: (kUTemporalSteps − trust)
// query steps × trust traced segments ≤ 16 SegSegCheb per lane per query, and a
// fully-traced lane pays a single int compare.
//
// `distancesClear` (broad phase, see SetReach): the caller has shown that every DISTANCE
// between this lane and the segment a→b exceeds `half`. SegSegCheb is 0 when its
// crossing test fires and one of those distances otherwise, so only the crossing
// test is left to evaluate; it is sign arithmetic, the boxes say nothing about what
// it computes, and it is never skipped.
//
// METRIC (Slice 4a). A BEAM is measured in EUCLIDEAN distance because the game's
// laser job is (JNHOCNOANFC::Execute: pointToSegmentDist^2 <= T^2); everything else
// keeps Chebyshev because the box job is per-axis. The broad phase is unaffected:
// Euclidean distance is never smaller than Chebyshev, so a `distancesClear` proof
// that every Chebyshev distance exceeds `half` still proves it for Euclidean.
static bool TracedPathClear(const Ctx& c, int li, Vec2 a, Vec2 b, float half, bool distancesClear = false)
{
    const int n = c.trust[li];
    const bool beam = c.beam[li];
    if (n <= 0) {   // nothing traced at all (single-point lane): the live disc
        if (distancesClear) return true;   // a pure distance, already known to exceed half
        return MinChebOnSegment(c.pos[li][0].x - a.x, c.pos[li][0].y - a.y,
                                c.pos[li][0].x - b.x, c.pos[li][0].y - b.y) > half;
    }
    for (int j = 0; j < n; ++j) {
        if (distancesClear) {
            if (SegmentsIntersect(a, b, c.pos[li][j], c.pos[li][j + 1]) && 0.f <= half) return false;
            continue;
        }
        const float d = beam ? SegSegEuclid(a, b, c.pos[li][j], c.pos[li][j + 1])
                             : SegSegCheb(a, b, c.pos[li][j], c.pos[li][j + 1]);
        if (d <= half) return false;
    }
    return true;
}

// Bullet position at arbitrary time t (ms), interpolated within the fixed march
// grid. Clamped to [0, horizon]: beyond the horizon we hold the last sample —
// the same CONSERVATIVE-FREEZE contract as SampleLane (assume the pattern is
// frozen where prediction runs out; do NOT extrapolate). The horizon is now
// 800 ms (plan 95) so the freeze bites far later — a still-closing wall is judged
// over the full closing window instead of read "durable" while it is 600-800 ms
// out. Extending the horizon only adds samples where a bullet is seen: it can
// only INCREASE the danger this test reports for the HOLD, never decrease it.
Vec2 BulletPosAt(const Ctx& c, int li, float tMs)
{
    if (tMs <= 0.f)          return c.pos[li][0];
    if (tMs >= kHorizonMs)   return c.pos[li][kUTemporalSteps];
    const float g = tMs / kUTemporalStepMs;
    const int   k = static_cast<int>(g);
    const float f = g - static_cast<float>(k);
    return Add(c.pos[li][k], Mul(Sub(c.pos[li][k + 1], c.pos[li][k]), f));
}

// Same, but following a FAST lane's half-step samples (Ctx::mid) when it has
// them, so an arbitrary-time query does not chord across the real path. Falls
// back to BulletPosAt for slow lanes — identical result, identical cost.
static Vec2 BulletPosFine(const Ctx& c, int li, float tMs)
{
    if (!c.sub[li])          return BulletPosAt(c, li, tMs);
    if (tMs <= 0.f)          return c.pos[li][0];
    if (tMs >= kHorizonMs)   return c.pos[li][kUTemporalSteps];
    const float h = kUTemporalStepMs * 0.5f;
    const float g = tMs / h;
    int         j = static_cast<int>(g);                 // half-step index
    if (j >= 2 * kUTemporalSteps) j = 2 * kUTemporalSteps - 1;   // defensive; g < 2·steps above
    const float f = std::clamp(g - static_cast<float>(j), 0.f, 1.f);
    const int   k = j >> 1;
    const Vec2  a = (j & 1) ? c.mid[li][k] : c.pos[li][k];
    const Vec2  b = (j & 1) ? c.pos[li][k + 1] : c.mid[li][k];
    return Add(a, Mul(Sub(b, a), f));
}

// Bullet position INSIDE march step k, at fraction f of that step. Follows the
// half-step samples for a fast lane (two sub-segments) and the plain chord for a
// slow one — the hot path for a slow lane is the same single interpolation as
// before.
static inline Vec2 BulletInStep(const Ctx& c, int li, int k, float f)
{
    if (f <= 0.f) return c.pos[li][k];
    if (f >= 1.f) return c.pos[li][k + 1];
    if (c.sub[li]) {
        const Vec2 a = (f <= 0.5f) ? c.pos[li][k]   : c.mid[li][k];
        const Vec2 b = (f <= 0.5f) ? c.mid[li][k]   : c.pos[li][k + 1];
        const float g = (f <= 0.5f) ? (f * 2.f) : ((f - 0.5f) * 2.f);
        return Add(a, Mul(Sub(b, a), g));
    }
    const Vec2 a = c.pos[li][k];
    const Vec2 b = c.pos[li][k + 1];
    return Add(a, Mul(Sub(b, a), f));
}

// ALONG-TRACK TIMING PAD (Tactician S3.4). Zero under classic, and zero for a
// shot that is not moving. The shot may be up to Ctx::alongMs early or late along
// its own path, so its swept sub-segment is stretched by (velocity x alongMs) at
// BOTH ends — never sideways, which is what the old isotropic speed term did (it
// widened an 8 tiles/s lane by 0.28 tile in every direction, closing the very gaps
// the reflex threads; see contact-model-study.md section 3). The velocity comes
// from the sub-segment itself, so a curve is followed piece by piece.
static inline Vec2 AlongPad(const Ctx& c, Vec2 bPrev, Vec2 bCur, float dtMs)
{
    if (c.alongMs <= 0.f || !(dtMs > 1e-4f)) return Vec2{};
    const float k = c.alongMs / dtMs;
    return Vec2{ (bCur.x - bPrev.x) * k, (bCur.y - bPrev.y) * k };
}

// TIME-parameterized clearance test (solver query). The player walks STRAIGHT
// from `player` toward P at `speed`, arriving at tArrive, then holds at P. March
// time over the horizon and, at each step, test the RELATIVE sweep: the segment
// from (bullet(t0) - player(t0)) to (bullet(t1) - player(t1)). Because both the
// bullet and the player move linearly inside a step, that relative segment IS the
// exact bullet-to-player offset over the whole step — the previous form pinned the
// player at the START of the step while sweeping the bullet across it, which for a
// fast bullet (or a fast player) compared the two at different instants and could
// miss a crossing entirely. That mispairing is the fast-shot clip.
//
// Two refinements sit on top of the relative sweep, both cheap:
//   • the step that CONTAINS tArrive is split at tArrive, so the walk-then-stop
//     kink is modelled exactly and a bullet sitting on P at the moment of arrival
//     always rejects the candidate;
//   • a fast lane (Ctx::sub) is additionally split at its half-step sample so the
//     bullet follows its real path rather than a long chord.
//
// TRANSIT is checked over the FULL horizon; DWELL only for dwellMs past arrival
// (kUDwellMs) — past that a lane stops being tested against the held position
// rather than counting as a hit, because the solver will have re-planned many
// times over by then. See kUDwellMs.
//
// ── WHY THIS RETURNS A TIME, NOT A BOOL ─────────────────────────────────────
// Everything above is unchanged; what changed is the LOOP ORDER. The old shape
// marched LANES outer / STEPS inner and returned false at the first violation it
// happened to trip over — which is the first violating LANE, not the earliest
// violating MOMENT. Flipping to STEPS outer / LANES inner makes the first
// violation found the EARLIEST one in time, so the same early exit and the same
// tests now yield the time-to-danger for free. Everything downstream of that (the
// bool wrapper, the solver's durability gradient) is built on this one march.
//
// The flip is also cheaper on two counts, and dearer on none:
//   • the player-path breakpoints (the arrival kink, the half-step time and the
//     player positions at them) are LANE-INDEPENDENT and are now computed once per
//     step instead of once per lane per step;
//   • a violation is normally EARLY in time, and exiting at the earliest step costs
//     (first violating step + 1) × lanes tests instead of (first violating lane) ×
//     steps + 1 — for the common "a bullet is on this cell now" refusal the old
//     shape still had to march every earlier lane across the whole horizon first.
// The per-lane hoists it gives up (half/arrPad/sub/trust) become four indexed
// loads per lane per step over arrays that are ≤ a few KB and stay hot in L1 for
// the whole solve (one Ctx serves all 131 candidates), and c.pos[li][k..k+1] is
// two adjacent floats either way.
static float ExpiryMs(const Ctx& c, int li)
{
    return c.expiresMs[li] > 0.f ? c.expiresMs[li] : kHugeClearance;
}

float TimeToDanger(const Ctx& c, Vec2 player, float speed, Vec2 P, float scanUntilMs)
{
    const Vec2  to = Sub(P, player);
    const float dist = Len(to);
    const Vec2  dir = dist > 1e-4f ? Mul(to, 1.f / dist) : Vec2{};
    const float v = speed;   // tiles/ms
    const float tArrive = (v > 1e-6f) ? dist / v : (dist > 1e-4f ? kHugeClearance : 0.f);
    // The window actually marched. Never longer than the horizon we have samples
    // for; the caller derives it from the walk (DwellWindowMs) or takes the whole
    // horizon when it wants the gradient.
    const float tEnd = std::min(std::max(scanUntilMs, 0.f), kHorizonMs);

    // Player position on the walk-then-hold path at absolute time t.
    const auto playerAt = [&](float t) -> Vec2 {
        return (t >= tArrive) ? P : Add(player, Mul(dir, v * t));
    };

    // BROAD PHASE (see SetReach). The walk-then-hold path stays on the segment
    // player→P for any speed >= 0 (it moves toward P and stops there; a speed at or
    // under the 1e-6 arrival threshold drifts at most 0.0008 tile past P inside the
    // horizon, which kBroadSlackTiles covers). A negative or NaN speed walks off the
    // segment, so that case filters nothing.
    //   • A lane out of reach that is fully traced and not a beam only ever runs
    //     distance tests here, so it is dropped from the march.
    //   • A beam or a short trace out of reach can still reach TracedPathClear's
    //     crossing test; it stays in the list flagged kOutOfReachBit, which skips its distance
    //     tests only.
    // A dropped test could not have fired at any step, so the earliest violating step,
    // and with it the returned time, is unchanged.
    constexpr uint16_t kOutOfReachBit = 0x8000;
    static_assert(kMaxProjectiles <= 0x8000, "active-lane list keeps a flag in bit 15");
    uint16_t active[kMaxProjectiles];
    int      activeCount = 0;
    const Ctx::Box walk = (v >= 0.f) ? PlayerBox(player, P) : EverywhereBox();
    for (int li = 0; li < c.count; ++li) {
        const bool outOfReach = OutOfReach(c.reach[li], walk);
        if (outOfReach && !c.beam[li] && c.trust[li] >= kUTemporalSteps) continue;
        active[activeCount++] = static_cast<uint16_t>(li | (outOfReach ? kOutOfReachBit : 0));
    }
    if (activeCount == 0) return kNoDanger;

    for (int k = 0; k < kUTemporalSteps; ++k) {
        const float t0 = static_cast<float>(k) * kUTemporalStepMs;
        if (t0 >= tEnd) break;                       // past the scanned window
        const float t1 = t0 + kUTemporalStepMs;

        // Breakpoints inside this step, in time order: the arrival kink and the
        // half-step sample (the latter used by FAST lanes only — `isMid` marks it so
        // a slow lane skips it and keeps its single chord). At most two extra
        // breakpoints, so at most three sub-segments, exactly as before. Both the
        // times and the player positions on them are the same for every lane, so
        // they are built ONCE per step here rather than per lane.
        const float tMid = t0 + kUTemporalStepMs * 0.5f;
        const bool  useArr = (tArrive > t0 && tArrive < t1);
        float ts[4]; Vec2 ps[4]; bool isMid[4];
        int   n = 0;
        ts[n] = t0;                                         isMid[n] = false; ++n;
        if (useArr && tArrive <  tMid) { ts[n] = tArrive;    isMid[n] = false; ++n; }
        ts[n] = tMid;                                       isMid[n] = true;  ++n;
        if (useArr && tArrive >= tMid) { ts[n] = tArrive;    isMid[n] = false; ++n; }
        ts[n] = t1;                                         isMid[n] = false; ++n;
        for (int i = 0; i < n; ++i) {
            ps[i] = playerAt(ts[i]);
        }

        for (int ai = 0; ai < activeCount; ++ai) {
            const int  li  = active[ai] & (kOutOfReachBit - 1);
            const bool outOfReach = (active[ai] & kOutOfReachBit) != 0;
            const float expiry = ExpiryMs(c, li);
            if (t0 >= expiry) continue;
            if (c.beam[li]) {
                const float end = std::min({t1, tEnd, expiry});
                if (!TracedPathClear(c, li, playerAt(t0), playerAt(end), c.half[li] + c.arrPad[li], outOfReach)) return t0;
                continue;
            }
            const int trust = c.trust[li];
            if (k > trust) continue;                 // untrusted tail already judged at k == trust
            const float half = c.half[li] + c.arrPad[li];   // speed-scaled (kUPredErrMs)
            if (k == trust) {
                // UNKNOWN TAIL: past the trusted end this lane is judged against its
                // whole traced path, not against a frozen point. The player's path over
                // [tTrust, tEnd] is walk-then-hold, so split it at the arrival kink.
                // tTrust == t0 here (trust is a march index), which is exactly the time
                // this violation is attributed to — the same gate the old shape wrote as
                // `tCheckEnd > tTrust`, since we only reach step k when t0 < tEnd.
                Vec2 pa = ps[0];
                const float tailEnd = std::min(tEnd, expiry);
                if (tArrive > t0 && tArrive < tailEnd) {
                    if (!TracedPathClear(c, li, pa, P, half, outOfReach)) return t0;
                    pa = P;
                }
                if (!TracedPathClear(c, li, pa, playerAt(tailEnd), half, outOfReach)) return t0;
                continue;
            }
            if (outOfReach) continue;   // the march below is distance tests only
            const bool useMid = c.sub[li];
            Vec2  pPrev = ps[0];
            Vec2  bPrev = BulletInStep(c, li, k, 0.f);
            float tPrev = ts[0];
            for (int i = 1; i < n; ++i) {
                if (isMid[i] && !useMid) continue;   // slow lane: one chord across the step
                const float curTime = std::min(ts[i], expiry);
                const Vec2 pCur = curTime == ts[i] ? ps[i] : playerAt(curTime);
                const Vec2 bCur = BulletInStep(c, li, k, (curTime - t0) / kUTemporalStepMs);
                const Vec2 e = AlongPad(c, bPrev, bCur, curTime - tPrev);
                if (MinChebOnSegment(bPrev.x - pPrev.x - e.x, bPrev.y - pPrev.y - e.y,
                                     bCur.x  - pCur.x  + e.x, bCur.y  - pCur.y  + e.y) <= half) return t0;
                pPrev = pCur; bPrev = bCur; tPrev = curTime;
                if (curTime >= expiry) break;
            }
        }
    }
    // NOTE (removed, not lost): the old shape also endpoint-tested the final sample
    // (t = horizon) for fully-trusted lanes when the window reached the horizon.
    // That test is REDUNDANT under the march: it can only fire when tEnd ==
    // kHorizonMs, in which case step kUTemporalSteps−1 is marched (t0 = horizon −
    // step < tEnd, and k < trust for a fully-trusted lane) and its LAST sub-segment
    // ends at exactly that (bullet(horizon) − player(horizon)) offset. Since
    // MinChebOnSegment ≤ Cheb at either endpoint, any hit the endpoint test would
    // report was already reported — one step earlier in time, which is the more
    // conservative answer of the two.
    return kNoDanger;
}

// The dwell window PathClear tests: transit (always) plus dwellMs past arrival,
// clamped to the horizon we have samples for.
float DwellWindowMs(Vec2 player, float speed, Vec2 P, float dwellMs)
{
    const float dist = Len(Sub(P, player));
    const float tArrive = (speed > 1e-6f) ? dist / speed : (dist > 1e-4f ? kHugeClearance : 0.f);
    return std::min(tArrive + std::max(dwellMs, 0.f), kHorizonMs);
}

bool DwellClear(Vec2 player, float speed, Vec2 P, float timeToDangerMs, float dwellMs)
{
    // Strictly `< window` — the march's own gate is `t0 >= tEnd → stop`, so a
    // violation attributed to exactly the window edge is one the bounded scan would
    // never have looked at. This is the one comparison that keeps a caller reusing a
    // FULL-horizon march bit-identical to a caller that marched only its own window.
    return !(timeToDangerMs < DwellWindowMs(player, speed, P, dwellMs));
}

bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P, float dwellMs)
{
    // Bound the march to the dwell window, so a caller that only needs the yes/no
    // pays exactly what it paid before this became a gradient.
    const float window = DwellWindowMs(player, speed, P, dwellMs);
    return TimeToDanger(c, player, speed, P, window) == kNoDanger;
}

float EvidenceHorizonMs(const Ctx& c)
{
    float t = kHorizonMs;
    for (int i = 0; i < c.count; ++i)
        if (c.trust[i] < kUTemporalSteps)
            t = std::min(t, static_cast<float>(c.trust[i]) * kUTemporalStepMs);
    return t;
}

// ARRIVAL-TIME SAFETY (pathfinder query). Standing at B over the arrival window
// [tA, tB], each bullet sweeps from BulletPosAt(tA) to BulletPosAt(tB); the
// swept-segment min-Chebyshev to B must exceed the effective hit half + the
// lane's arrival pad (kUArrivalMargin plus its speed term — see kUPredErrMs), or
// a bullet is at B while the player is there. Swept (not
// endpoint-only) so a fast bullet cannot tunnel across B between arrival times.
//
// NOTE (transit/dwell): unlike PathClear this query carries NO stand-still
// assumption to relax — [tA, tB] is exactly the edge-traversal window the caller
// is paying for (UDodgePathfinder.cpp, edge relaxation), it never runs past tB,
// and the route's final cell is not held open for the rest of the horizon. So the
// dwell fix does not apply here.
//
// Follow every stored segment within the arrival window. A slow curve can
// cross the queried point between the window endpoints too; fast lanes use
// their additional half-step samples.
bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB)
{
    // BROAD PHASE (see SetReach). The player is the single point B, and the crossing
    // test cannot fire on a point: both cross products taken from B→B are exactly
    // 0 for finite input, never strictly opposite. So every test here is a distance
    // and a lane out of reach is dropped outright.
    const Ctx::Box stand = PlayerBox(B, B);
    for (int li = 0; li < c.count; ++li) {
        if (OutOfReach(c.reach[li], stand)) continue;
        const float laneEnd = std::min(tB, ExpiryMs(c, li));
        if (tA >= ExpiryMs(c, li)) continue;
        const float half = c.half[li] + c.arrPad[li];   // speed-scaled (kUPredErrMs)
        if (c.beam[li]) {
            if (!TracedPathClear(c, li, B, B, half)) return false;
            continue;
        }
        // UNKNOWN TAIL: this edge's window runs past what the lane's trace covers,
        // so past that point the lane is judged against its whole traced path
        // (see TracedPathClear). One test covers the entire untrusted remainder —
        // B is a fixed point here, so there is no player path to split.
        if (c.trust[li] < kUTemporalSteps) {
            const float tTrust = static_cast<float>(c.trust[li]) * kUTemporalStepMs;
            if (laneEnd > tTrust && !TracedPathClear(c, li, B, B, half)) return false;
        }
        // Follow every stored segment, including for slow lanes. A long window
        // can contain a turn even when no individual step needs refinement.
        const float dt = c.sub[li] ? kUTemporalStepMs * 0.5f : kUTemporalStepMs;
        float t = std::max(tA, 0.f);
        const float tEnd = std::min(std::max(laneEnd, t), kHorizonMs);
        Vec2  prev = BulletPosFine(c, li, t);
        bool  tested = false;
        for (int guard = 0; guard < 2 * kUTemporalSteps + 2 && t < tEnd; ++guard) {
            float tn = (std::floor(t / dt) + 1.f) * dt;
            if (tn > tEnd || tn <= t) tn = tEnd;
            const Vec2 cur = BulletPosFine(c, li, tn);
            const Vec2 e = AlongPad(c, prev, cur, tn - t);
            if (MinChebOnSegment(prev.x - B.x - e.x, prev.y - B.y - e.y,
                                 cur.x  - B.x + e.x, cur.y  - B.y + e.y) <= half) return false;
            prev   = cur;
            t      = tn;
            tested = true;
        }
        // Degenerate window (tB == tA, or both past the horizon): still test the
        // single instant, so the fast path can never be laxer than the slow one.
        if (!tested && Cheb(prev.x - B.x, prev.y - B.y) <= half) return false;
        if (laneEnd > kHorizonMs) {
            // Beyond the horizon the lane is frozen at its last sample (the
            // CONSERVATIVE-FREEZE contract) — one endpoint test covers the rest.
            const Vec2 bFrozen = c.pos[li][kUTemporalSteps];
            if (Cheb(bFrozen.x - B.x, bFrozen.y - B.y) <= half) return false;
        }
    }
    return true;
}

bool EdgeClear(const Ctx& c, Vec2 A, Vec2 B, float tA, float tB)
{
    if (!(tB > tA)) return ArrivalClear(c, B, tA, tB);
    const auto playerAt = [&](float t) -> Vec2 {
        const float f = std::clamp((t - tA) / (tB - tA), 0.f, 1.f);
        return Add(A, Mul(Sub(B, A), f));
    };

    // playerAt clamps to the segment A→B, but only for a finite window: an infinite tA
    // makes it return NaN, and the narrow phase does not read NaN one way (the
    // untraced-lane floor in TracedPathClear blocks on it, every other test passes
    // it). So a non-finite window is not filtered at all.
    const Ctx::Box edge = (std::isfinite(tA) && std::isfinite(tB - tA)) ? PlayerBox(A, B) : EverywhereBox();
    for (int li = 0; li < c.count; ++li) {
        // `outOfReach`: every distance test between this lane and this edge is settled
        // (clear). What is left is TracedPathClear's crossing test, reached by a beam and
        // by a window running past the trusted end; any other such lane is done.
        // (Not named `far`: that is a macro in the Windows headers.)
        const bool outOfReach = OutOfReach(c.reach[li], edge);
        const float laneEnd = std::min(tB, ExpiryMs(c, li));
        if (tA >= ExpiryMs(c, li)) continue;
        const float half = c.half[li] + c.arrPad[li];
        if (c.beam[li]) {
            if (!TracedPathClear(c, li, A, playerAt(laneEnd), half, outOfReach)) return false;
            continue;
        }
        const float tTrust = static_cast<float>(c.trust[li]) * kUTemporalStepMs;
        if (outOfReach) {
            if (laneEnd > tTrust) {
                const Vec2 u0 = playerAt(std::max(tA, tTrust));
                if (!TracedPathClear(c, li, u0, playerAt(laneEnd), half, true)) return false;
            }
            continue;
        }
        const float trustedEnd = std::min(laneEnd, tTrust);

        float t = std::max(tA, 0.f);
        const float tEnd = std::min(std::max(trustedEnd, t), kHorizonMs);
        Vec2 pPrev = playerAt(t);
        Vec2 bPrev = BulletPosFine(c, li, t);
        const float dt = c.sub[li] ? kUTemporalStepMs * 0.5f : kUTemporalStepMs;
        for (int guard = 0; guard < 2 * kUTemporalSteps + 2 && t < tEnd; ++guard) {
            float tn = (std::floor(t / dt) + 1.f) * dt;
            if (tn > tEnd || tn <= t) tn = tEnd;
            const Vec2 pCur = playerAt(tn);
            const Vec2 bCur = BulletPosFine(c, li, tn);
            const Vec2 e = AlongPad(c, bPrev, bCur, tn - t);
            if (MinChebOnSegment(bPrev.x - pPrev.x - e.x, bPrev.y - pPrev.y - e.y,
                                 bCur.x  - pCur.x  + e.x, bCur.y  - pCur.y  + e.y) <= half) return false;
            pPrev = pCur;
            bPrev = bCur;
            t = tn;
        }

        // An untrusted prediction tail cannot be time-threaded honestly. Preserve
        // the existing conservative traced-prefix floor, but apply it only to the
        // portion of the player edge that lies beyond the trusted time.
        if (laneEnd > tTrust) {
            const Vec2 u0 = playerAt(std::max(tA, tTrust));
            if (!TracedPathClear(c, li, u0, playerAt(laneEnd), half)) return false;
        }
        if (tA >= kHorizonMs) {
            const Vec2 frozen = c.pos[li][kUTemporalSteps];
            if (MinChebOnSegment(frozen.x - A.x, frozen.y - A.y,
                                 frozen.x - playerAt(laneEnd).x, frozen.y - playerAt(laneEnd).y) <= half) return false;
        }
    }
    return true;
}

} // namespace Temporal

} } // namespace UDodge::Core
