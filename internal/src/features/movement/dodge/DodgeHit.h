#pragma once

#include <cmath>

#include "DodgeGeometry.h"        // InProjAabb — Chebyshev/AABB hit test
#include "gui/tabs/WorldTAB.h"    // WorldProjectile (full definition)

// DodgeHit — projectile-aware hit math shared by every dodge engine
// (XDodge spacetime grid + RolloutDodge forward sim) so the two can never
// drift on "what counts as a hit". Pure functions over a WorldProjectile; the
// geometry (Chebyshev/AABB) lives in DodgeGeometry.h.
//
// Realm projectile collision is an axis-aligned square centered on the bullet
// (FUN_18015be50 in the dumped client): hit iff |dx| < effR && |dy| < effR,
// where effR already folds in the player half-extent. See InProjAabb.
namespace DodgeHit {

// RotMG player collision half-hitbox (tiles). The server hit test uses this
// for the player side; it matches XDriver's dodge math and is intentionally
// distinct from the slightly larger 0.2285 environment-collision half used
// for wall checks (TestTAB::IsWalkPositionBlocked).
inline constexpr float kPlayerHalf = 0.2139f;

// Per-projectile Chebyshev half-extent with finite + 0.5 fallback. The runtime
// field can resolve to 0 on a fresh game build (offset rotation), which would
// give a ZERO hitbox -> the planner sees no danger -> never dodges. The 0.5
// default (standard CollisionMult 1.0 x 0.5) keeps dodge alive across updates.
inline float ProjChebyshevHalf(const WorldProjectile& b)
{
    if (b.runtimeChebyshevHalf > 1e-5f && std::isfinite(b.runtimeChebyshevHalf))
        return b.runtimeChebyshevHalf;
    if (b.projHalfSize > 1e-6f && std::isfinite(b.projHalfSize))
        return b.projHalfSize;
    return 0.5f;
}

// Effective AABB half-side for a bullet-vs-player test: bullet half x scale +
// player half + an optional command-latency pad. This is the `effR` that
// DodgeGeometry::InProjAabb expects.
inline float EffectiveHalf(const WorldProjectile& b, float hitScale, float pad = 0.f)
{
    return ProjChebyshevHalf(b) * hitScale + kPlayerHalf + pad;
}

// True if a player at (px,py) overlaps bullet `b` whose center is (bx,by).
inline bool Hits(const WorldProjectile& b, float bx, float by,
                 float px, float py, float hitScale, float pad = 0.f)
{
    if (b.laser && std::isfinite(b.laserDistance) && b.laserDistance > 0.f && std::isfinite(b.angle))
        return DodgeGeometry::SegmentHitsBox(bx, by,
            bx + std::cos(b.angle) * b.laserDistance, by + std::sin(b.angle) * b.laserDistance,
            px, py, EffectiveHalf(b, hitScale, pad));
    return DodgeGeometry::InProjAabb(bx, by, px, py, EffectiveHalf(b, hitScale, pad));
}

} // namespace DodgeHit
