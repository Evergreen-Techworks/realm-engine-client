#include "pch-il2cpp.h"
#include "UDodgeCore.h"

#include <algorithm>
#include <cmath>

// UDodge core (plan 64) — pruned to the pure spatial safety primitives the
// per-tick solver uses. The 35-candidate reactive scoring machinery (probe-and-
// rank selection with tick-locked hysteresis) was retired with the reactive
// engine; the solver in UDodgeSolver now chooses among reachable points using
// PointSafety/PointSafe below.
namespace UDodge { namespace Core {
namespace {

// Min over the lane polyline of Chebyshev distance from p. A lane is dangerous
// NOW over its whole length — the spatial hit geometry every safety test below
// measures against.
float LaneDistCheb(const LaneThreat& L, Vec2 p)
{
    if (L.pointCount <= 0) return kHugeClearance;
    if (L.pointCount == 1) return Cheb(L.points[0].x - p.x, L.points[0].y - p.y);
    float best = kHugeClearance;
    for (int j = 0; j + 1 < L.pointCount; ++j) {
        const Vec2 a = L.points[j];
        const Vec2 b = L.points[j + 1];
        best = std::min(best, MinChebOnSegment(a.x - p.x, a.y - p.y,
                                               b.x - p.x, b.y - p.y));
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

} // namespace

// "Could the player stand at `pos` right now?" — on standable ground, outside
// every danger lane (Chebyshev > hitHalf × hitScale) and outside every ACTIVE
// zone. Pending zones do NOT block (cost-only). Enemy bodies NOT checked.
// NOTE: omits the player half-extent — see PointSafety for the server-accurate
// test the solver uses. Kept for callers / overlay that want raw bullet geometry.
bool PointClear(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
        return false;   // wall, or hazard endpoint when safeWalk is on
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
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
        if (L.pointCount <= 0) continue;
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale;
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
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;
        if (Len(Sub(z.pos, pos)) - (z.radius + kUPlayerHalf) < 0.f) return false;
    }
    return true;
}

float PointSafety(const MapInput& in, Vec2 pos)
{
    if (!in.map) return 0.f;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.pointCount <= 0) continue;
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale + kUPlayerHalf;
        best = std::min(best, LaneDistCheb(L, pos) - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        // Pending zones are cost-only (soft) — only active discs subtract clearance.
        if (z.active) best = std::min(best, Len(Sub(z.pos, pos)) - (z.radius + kUPlayerHalf));
    }
    return best;
}

bool PointSafe(const MapInput& in, Vec2 pos, float pad)
{
    if (!in.map) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
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
    float best = kHugeClearance;
    for (int i = 0; i < in.map->laneCount; ++i) {
        const LaneThreat& L = in.map->lanes[i];
        if (L.pointCount <= 0) continue;
        const float half = std::clamp(L.hitHalf, 0.05f, 2.5f) * hitScale + kUPlayerHalf;
        float dCheb;
        if (L.pointCount == 1) {
            // Point lane: min Cheb from the single bullet point to the swept segment.
            dCheb = MinChebOnSegment(L.points[0].x - a.x, L.points[0].y - a.y,
                                     L.points[0].x - b.x, L.points[0].y - b.y);
        } else {
            dCheb = kHugeClearance;
            for (int j = 0; j + 1 < L.pointCount; ++j)
                dCheb = std::min(dCheb, SegSegCheb(a, b, L.points[j], L.points[j + 1]));
        }
        best = std::min(best, dCheb - half);
    }
    for (int i = 0; i < in.map->zoneCount; ++i) {
        const ZoneThreat& z = in.map->zones[i];
        if (!z.active) continue;   // pending zones are cost-only
        best = std::min(best, PointSegDistEuclid(z.pos, a, b) - (z.radius + kUPlayerHalf));
    }
    return best;
}

bool EnemyBlocked(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    for (int i = 0; i < in.map->enemyCount; ++i) {
        const EnemyBlocker& e = in.map->enemies[i];
        if (Len(Sub(pos, e.pos)) < e.radius + kUPlayerHalf) return true;
    }
    return false;
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
// how ghost lanes appear — see ClampLaneToAnchor, UDodgeSensors.cpp). Freezing
// only UNDER-counts a still-closing wall OUTSIDE the horizon; the fix for that
// under-count is the longer horizon (kUTemporalSteps, plan 95), not extrapolation.
// This is safety-positive: it can only report equal-or-more danger, never less.
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

// Build the temporal context: predict every lane's future positions once, and
// cull lanes whose whole traced path stays > cullTiles from cullCenter over the
// horizon (far / receding shots contribute nothing to the search region).
void Build(const DangerMap& map, float hitScale, Vec2 cullCenter,
           float cullTiles, Ctx& out)
{
    out.count = 0;
    const float scale = std::clamp(hitScale, 0.25f, 2.5f);
    for (int i = 0; i < map.laneCount && out.count < kMaxProjectiles; ++i) {
        const LaneThreat& L = map.lanes[i];
        if (L.pointCount <= 0) continue;
        Vec2 samples[kSamples];
        SampleLane(L, samples);
        float minD = kHugeClearance;
        for (int k = 0; k < kSamples; ++k)
            minD = std::min(minD, Len(Sub(samples[k], cullCenter)));
        if (minD > cullTiles) continue;                  // far/receding — irrelevant
        const int idx = out.count++;
        for (int k = 0; k < kSamples; ++k) out.pos[idx][k] = samples[k];
        out.half[idx] = std::clamp(L.hitHalf, 0.05f, 2.5f) * scale + kUPlayerHalf;
        // FAST LANE? The swept-segment queries chord this lane between march
        // samples; if it travels far enough per step for that chord to diverge
        // from its real (possibly curving) path, sample the half-steps too so the
        // queries follow the path in two pieces instead of one. Only fast lanes
        // pay for this — one extra SampleLaneTimes here and one extra segment
        // test per step in the queries.
        float maxSweep = 0.f;
        for (int k = 0; k < kUTemporalSteps; ++k)
            maxSweep = std::max(maxSweep, Len(Sub(samples[k + 1], samples[k])));
        out.sub[idx] = (maxSweep > kUTemporalMaxSweepTiles);
        if (out.sub[idx])
            SampleLaneTimes(L, kUTemporalStepMs * 0.5f, kUTemporalSteps, out.mid[idx]);
    }
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
bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P, float dwellMs)
{
    const Vec2  to = Sub(P, player);
    const float dist = Len(to);
    const Vec2  dir = dist > 1e-4f ? Mul(to, 1.f / dist) : Vec2{};
    const float v = speed;   // tiles/ms
    const float tArrive = (v > 1e-6f) ? dist / v : (dist > 1e-4f ? kHugeClearance : 0.f);
    // Everything up to tArrive is transit (always checked); dwellMs past it is the
    // hold window. Never longer than the horizon we actually have samples for.
    const float tCheckEnd = std::min(tArrive + std::max(dwellMs, 0.f), kHorizonMs);

    // Player position on the walk-then-hold path at absolute time t.
    const auto playerAt = [&](float t) -> Vec2 {
        return (t >= tArrive) ? P : Add(player, Mul(dir, v * t));
    };

    for (int li = 0; li < c.count; ++li) {
        const float half = c.half[li] + kUArrivalMargin;
        for (int k = 0; k < kUTemporalSteps; ++k) {
            const float t0 = static_cast<float>(k) * kUTemporalStepMs;
            if (t0 >= tCheckEnd) break;              // past the dwell window — next lane
            const float t1 = t0 + kUTemporalStepMs;

            // Breakpoints inside this step, in time order: the arrival kink and (for
            // a fast lane) the half-step sample. At most two, so at most three
            // sub-segments; a slow lane outside the arrival step keeps ONE test.
            float ts[4];
            int   n = 0;
            ts[n++] = t0;
            const float tMid = t0 + kUTemporalStepMs * 0.5f;
            const bool  useMid = c.sub[li];
            const bool  useArr = (tArrive > t0 && tArrive < t1);
            if (useMid && useArr) {
                if (tArrive < tMid) { ts[n++] = tArrive; ts[n++] = tMid; }
                else                { ts[n++] = tMid;    ts[n++] = tArrive; }
            } else if (useMid)      { ts[n++] = tMid; }
            else if (useArr)        { ts[n++] = tArrive; }
            ts[n++] = t1;

            Vec2 pPrev = playerAt(ts[0]);
            Vec2 bPrev = BulletInStep(c, li, k, 0.f);
            for (int i = 1; i < n; ++i) {
                const float f = (ts[i] - t0) * (1.f / kUTemporalStepMs);
                const Vec2  pCur = playerAt(ts[i]);
                const Vec2  bCur = BulletInStep(c, li, k, f);
                if (MinChebOnSegment(bPrev.x - pPrev.x, bPrev.y - pPrev.y,
                                     bCur.x  - pCur.x,  bCur.y  - pCur.y) <= half) return false;
                pPrev = pCur; bPrev = bCur;
            }
        }
        // Final sample (t = horizon): player is holding at P by now. Only meaningful
        // if the dwell window actually reaches the end of the horizon.
        if (kHorizonMs <= tCheckEnd) {
            const Vec2 ppEnd = playerAt(kHorizonMs);
            const Vec2 bEnd  = c.pos[li][kUTemporalSteps];
            if (Cheb(bEnd.x - ppEnd.x, bEnd.y - ppEnd.y) <= half) return false;
        }
    }
    return true;
}

// ARRIVAL-TIME SAFETY (pathfinder query). Standing at B over the arrival window
// [tA, tB], each bullet sweeps from BulletPosAt(tA) to BulletPosAt(tB); the
// swept-segment min-Chebyshev to B must exceed the effective hit half +
// kUArrivalMargin, or a bullet is at B while the player is there. Swept (not
// endpoint-only) so a fast bullet cannot tunnel across B between arrival times.
//
// NOTE (transit/dwell): unlike PathClear this query carries NO stand-still
// assumption to relax — [tA, tB] is exactly the edge-traversal window the caller
// is paying for (UDodgePathfinder.cpp, edge relaxation), it never runs past tB,
// and the route's final cell is not held open for the rest of the horizon. So the
// dwell fix does not apply here.
//
// A FAST lane is followed piecewise across the stored (half-)samples inside the
// window instead of chorded end-to-end: an edge window can span more than one
// march step, and chording a fast lane across several steps straightens away the
// very crossing this test exists to catch. Bounded — an edge window is one cell
// of travel, and the walk is hard-capped anyway.
bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB)
{
    for (int li = 0; li < c.count; ++li) {
        const float half = c.half[li] + kUArrivalMargin;
        if (!c.sub[li]) {
            const Vec2 b0 = BulletPosAt(c, li, tA);
            const Vec2 b1 = BulletPosAt(c, li, tB);
            if (MinChebOnSegment(b0.x - B.x, b0.y - B.y,
                                 b1.x - B.x, b1.y - B.y) <= half) return false;
            continue;
        }
        // Fast lane: step from tA to tB, breaking at every stored half-step sample.
        const float dt = kUTemporalStepMs * 0.5f;
        float t = std::max(tA, 0.f);
        const float tEnd = std::min(std::max(tB, t), kHorizonMs);
        Vec2  prev = BulletPosFine(c, li, t);
        bool  tested = false;
        for (int guard = 0; guard < 2 * kUTemporalSteps + 2 && t < tEnd; ++guard) {
            float tn = (std::floor(t / dt) + 1.f) * dt;
            if (tn > tEnd || tn <= t) tn = tEnd;
            const Vec2 cur = BulletPosFine(c, li, tn);
            if (MinChebOnSegment(prev.x - B.x, prev.y - B.y,
                                 cur.x  - B.x, cur.y  - B.y) <= half) return false;
            prev   = cur;
            t      = tn;
            tested = true;
        }
        // Degenerate window (tB == tA, or both past the horizon): still test the
        // single instant, so the fast path can never be laxer than the slow one.
        if (!tested && Cheb(prev.x - B.x, prev.y - B.y) <= half) return false;
        if (tB > kHorizonMs) {
            // Beyond the horizon the lane is frozen at its last sample (the
            // CONSERVATIVE-FREEZE contract) — one endpoint test covers the rest.
            const Vec2 bFrozen = c.pos[li][kUTemporalSteps];
            if (Cheb(bFrozen.x - B.x, bFrozen.y - B.y) <= half) return false;
        }
    }
    return true;
}

} // namespace Temporal

} } // namespace UDodge::Core
