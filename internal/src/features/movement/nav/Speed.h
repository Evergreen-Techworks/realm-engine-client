#pragma once
// Movement::Speed — the one player speed for every step and every route time.
//
// TilesPerSec(pos, conditions) = the player's speed with its conditions applied
// (DodgeRuntime::EffectiveTilesPerSec: SPD curve, Slowed, Speedy, Paralyzed, Stasis,
// Petrified, capped by the game's own getter) x the ground <Speed> at pos.
//
// EffectiveTilesPerSec is measured on the player's OWN square (the game's
// CalcMoveSpeed is part of it), so BaseTilesPerSec divides that square's <Speed> back
// out once and every other square scales from the same base. On the player's own
// square the result is EffectiveTilesPerSec again, so the per-frame step the game
// checks does not change.
//
// Pure and header-only; the <Speed> values come from WorldTAB's s_tileSpeedMap (the
// game thread reads WorldTAB::GetTileSpeed, the worker a CopyTileSpeeds snapshot).
#include <algorithm>
#include <cmath>
#include <limits>

namespace Movement { namespace Speed {

// A square's <Speed> as WorldTAB stores it: 0 means the element is absent (x1).
inline float TileFactor(float xmlSpeed)
{
    return (std::isfinite(xmlSpeed) && xmlSpeed > 0.f && xmlSpeed < 5.f) ? xmlSpeed : 1.f;
}

// The player's speed off any square: EffectiveTilesPerSec on its own square, divided
// by that square's <Speed>. 0 when the player cannot move.
inline float BaseTilesPerSec(float effectiveTilesPerSec, float ownSquareXmlSpeed)
{
    if (!std::isfinite(effectiveTilesPerSec) || effectiveTilesPerSec <= 0.f) return 0.f;
    return effectiveTilesPerSec / TileFactor(ownSquareXmlSpeed);
}

// The speed on the square whose <Speed> is `xmlSpeedAtPos`.
inline float TilesPerSec(float baseTilesPerSec, float xmlSpeedAtPos)
{
    const float base = std::isfinite(baseTilesPerSec) ? std::max(0.f, baseTilesPerSec) : 0.f;
    return base * TileFactor(xmlSpeedAtPos);
}

// Milliseconds to walk `lengthTiles` between two cell centres, half the way on each
// square: 0.5 L (1/fromFactor + 1/toFactor) / base. Infinite when nothing moves.
inline float EdgeMs(float baseTilesPerMs, float fromFactor, float toFactor, float lengthTiles)
{
    if (!(baseTilesPerMs > 0.f) || !(fromFactor > 0.f) || !(toFactor > 0.f))
        return std::numeric_limits<float>::infinity();
    return 0.5f * lengthTiles * (1.f / fromFactor + 1.f / toFactor) / baseTilesPerMs;
}

} } // namespace Movement::Speed
