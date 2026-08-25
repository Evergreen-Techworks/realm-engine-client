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
void SampleLane(const LaneThreat& L, Vec2* outPos)
{
    const int cnt = L.pointCount;
    if (cnt <= 0) { for (int k = 0; k < kSamples; ++k) outPos[k] = Vec2{}; return; }
    if (cnt == 1) { for (int k = 0; k < kSamples; ++k) outPos[k] = L.points[0]; return; }

    int seg = 0;
    for (int k = 0; k < kSamples; ++k) {
        const float t = static_cast<float>(k) * kUTemporalStepMs;
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

// TIME-parameterized clearance test (solver query). The player walks STRAIGHT
// from `player` toward P at `speed`, arriving at tArrive, then holds at P. March
// time over the horizon: at each step check the player's position against every
// relevant bullet's SWEPT segment over that step (swept, so a fast bullet cannot
// tunnel between samples). Clear at every step ⇒ the whole path to P — and
// holding there — dodges the moving bullets, with kUArrivalMargin of slack.
bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P)
{
    const Vec2  to = Sub(P, player);
    const float dist = Len(to);
    const Vec2  dir = dist > 1e-4f ? Mul(to, 1.f / dist) : Vec2{};
    const float v = speed;   // tiles/ms
    const float tArrive = (v > 1e-6f) ? dist / v : (dist > 1e-4f ? kHugeClearance : 0.f);

    for (int li = 0; li < c.count; ++li) {
        const float half = c.half[li] + kUArrivalMargin;
        for (int k = 0; k < kUTemporalSteps; ++k) {
            const float t = static_cast<float>(k) * kUTemporalStepMs;
            const Vec2 pp = (t >= tArrive) ? P : Add(player, Mul(dir, v * t));
            const Vec2 b0 = c.pos[li][k];
            const Vec2 b1 = c.pos[li][k + 1];
            if (MinChebOnSegment(b0.x - pp.x, b0.y - pp.y,
                                 b1.x - pp.x, b1.y - pp.y) <= half) return false;
        }
        // Final sample (t = horizon): player is holding at P by now.
        const float tEnd = static_cast<float>(kUTemporalSteps) * kUTemporalStepMs;
        const Vec2 ppEnd = (tEnd >= tArrive) ? P : Add(player, Mul(dir, v * tEnd));
        const Vec2 bEnd = c.pos[li][kUTemporalSteps];
        if (Cheb(bEnd.x - ppEnd.x, bEnd.y - ppEnd.y) <= half) return false;
    }
    return true;
}

// ARRIVAL-TIME SAFETY (pathfinder query). Standing at B over the arrival window
// [tA, tB], each bullet sweeps from BulletPosAt(tA) to BulletPosAt(tB); the
// swept-segment min-Chebyshev to B must exceed the effective hit half +
// kUArrivalMargin, or a bullet is at B while the player is there. Swept (not
// endpoint-only) so a fast bullet cannot tunnel across B between arrival times.
bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB)
{
    for (int li = 0; li < c.count; ++li) {
        const float half = c.half[li] + kUArrivalMargin;
        const Vec2  b0 = BulletPosAt(c, li, tA);
        const Vec2  b1 = BulletPosAt(c, li, tB);
        if (MinChebOnSegment(b0.x - B.x, b0.y - B.y,
                             b1.x - B.x, b1.y - B.y) <= half) return false;
    }
    return true;
}

} // namespace Temporal

} } // namespace UDodge::Core
