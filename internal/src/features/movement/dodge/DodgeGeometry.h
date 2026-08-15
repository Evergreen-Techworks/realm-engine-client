#pragma once

#include <cmath>

// DodgeGeometry — small inline helpers shared by DangerPlanner (planner /
// frame phases) and MovementCorrector (last-mile veto hook). Kept in one
// header so the two consumers can never drift apart on the math that
// decides "is this position a hit?" or "where's the closest seam out of
// this trap?". Header-only, zero state — pure functions.
//
// Realm projectile collision is an axis-aligned square centered on the
// bullet (FUN_18015be50 in the dumped client): hit iff
// |cx-px| < effR && |cy-py| < effR — Chebyshev / AABB, NOT Euclidean
// circle. Using circle-distance over-stamps corners (~21% larger area)
// and under-stamps the diagonals; the planner threads gaps the game
// never actually closes. These helpers all use the AABB convention so
// CCD aligns with the actual collision the server will execute.
namespace DodgeGeometry {

// Chebyshev / AABB hit test. `effR` is the half-side of the projectile's
// axis-aligned bounding square already inflated by player half-extent.
inline bool InProjAabb(float cx, float cy, float px, float py, float effR)
{
    const float dx = cx - px;
    const float dy = cy - py;
    return std::fabs(dx) < effR && std::fabs(dy) < effR;
}

inline float MinDistPointToSegment(float px, float py,
                                   float ax, float ay,
                                   float bx, float by)
{
    const float dx = bx - ax, dy = by - ay;
    const float L2 = dx * dx + dy * dy;
    float t = (L2 > 1e-9f) ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0.f;
    if (t < 0.f) t = 0.f;
    else if (t > 1.f) t = 1.f;
    const float cx = ax + t * dx, cy = ay + t * dy;
    const float ddx = px - cx, ddy = py - cy;
    return std::sqrt(ddx * ddx + ddy * ddy);
}

// Push `probe` outside the AABB centered on `center` with half-side `half`.
// Picks the cheaper axis to clear. Used as an analytic escape vector when
// the player is currently inside a single bullet's AABB and we need to
// step out along the SHORTEST exit path. Mirrors PushOutsideProjectileAabb
// in the AutoDodgeV4 reference.
inline void PushOutsideAabb(float probeX, float probeY,
                            float centerX, float centerY,
                            float half,
                            float& outX, float& outY,
                            float pad = 0.04f)
{
    const float dx = probeX - centerX;
    const float dy = probeY - centerY;
    if (std::fabs(dx) >= half || std::fabs(dy) >= half) {
        outX = probeX;
        outY = probeY;
        return;
    }
    const float ax = half - std::fabs(dx);
    const float ay = half - std::fabs(dy);
    outX = probeX;
    outY = probeY;
    if (ax < ay) {
        const float sgn = (dx >= 0.f) ? 1.f : -1.f;
        outX = centerX + sgn * (half + pad);
    } else {
        const float sgn = (dy >= 0.f) ? 1.f : -1.f;
        outY = centerY + sgn * (half + pad);
    }
}

// Two analytic intersection points of two circles (treating each
// projectile's AABB as its inscribed circle of radius `r`). Returns the
// number of valid intersections — 0 if the circles don't overlap, 2
// otherwise. Used to seed candidate "seam" points between two threatening
// bullets — typically the only escape when the player is wedged between
// two overlapping danger fronts. Mirrors CircleCircleIntersections from
// the AutoDodgeV4 reference.
inline int CircleSeamPoints(float c0x, float c0y, float r0,
                            float c1x, float c1y, float r1,
                            float& aX, float& aY,
                            float& bX, float& bY)
{
    const float dx = c1x - c0x;
    const float dy = c1y - c0y;
    const float d  = std::sqrt(dx * dx + dy * dy);
    if (d < 1e-5f || d > r0 + r1 || d < std::fabs(r0 - r1)) return 0;
    const float a   = (r0 * r0 - r1 * r1 + d * d) / (2.f * d);
    const float h2  = r0 * r0 - a * a;
    if (h2 < 0.f) return 0;
    const float h   = std::sqrt(h2);
    const float invD = 1.f / d;
    const float px = c0x + a * dx * invD;
    const float py = c0y + a * dy * invD;
    const float rx = -dy * (h * invD);
    const float ry =  dx * (h * invD);
    aX = px + rx; aY = py + ry;
    bX = px - rx; bY = py - ry;
    return 2;
}

} // namespace DodgeGeometry
