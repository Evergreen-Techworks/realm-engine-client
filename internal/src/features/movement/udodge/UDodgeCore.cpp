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

} } // namespace UDodge::Core
