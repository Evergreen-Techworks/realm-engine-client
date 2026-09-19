#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

// ENEMY STANDOFF — "never walk near enemies, right on top of them, or in front of
// them to get shotgunned."
//
// WHY (152 real hits, owner's logs 2026-09-18). The nearest enemy was within 4
// tiles at 54 % of hits, 5 tiles at 71 %, 6 tiles at 82 %; median 3.7 tiles. The
// shot that landed had been in our model for a MEDIAN OF 62 ms (74 of 101 inside
// 150 ms). 68 of the hits happened while a script was walking the player. Sixty-two
// milliseconds is under four frames: no contact-box tuning, no faster solver and no
// better lane trace can dodge that. The only variable that buys reaction time is
// DISTANCE, so distance is what this file spends.
//
// The rule has three radii per enemy:
//   • CORE (kCoreTiles): hard. Nothing plans a route through it and no fight ring
//     reaches inside it. NAVIGATION ONLY — the immediate bullet solver keeps every
//     escape square it has today, because a dodge that cannot cross a core is a
//     dodge that dies in a corridor.
//   • BAND (core .. r): a strong route cost. Going around a pack is preferred over
//     going through it, but a band never makes a destination unreachable.
//   • r itself: how far the enemy's fastest shot travels in kReactionSec, plus its
//     body. That is the distance at which we would see a shot with time to move.
//
// Pure data and pure math: no IL2CPP, no globals, safe on the worker thread and in
// the offline harness.
namespace UDodge { namespace Standoff {

// udodgeEnemyStandoff. Off = the pre-standoff engine, byte for byte.
enum class Mode : unsigned char { Off = 0, Auto = 1 };

inline Mode ModeFromText(const char* text)
{
    return (text && text[0] == 'o' && text[1] == 'f') ? Mode::Off : Mode::Auto;
}
inline const char* ModeName(Mode m) { return m == Mode::Off ? "off" : "auto"; }

// Hard core. 2 tiles is "not on top of it and not in its face": past the body of
// every mob in the game, inside the reach of nothing that needs reacting to.
constexpr float kCoreTiles     = 2.0f;
// Reaction budget the band buys. The measured median shot age at the moment of a
// hit was 62 ms; 450 ms is that plus a comfortable margin for a 100 ms plan period.
constexpr float kReactionSec   = 0.45f;
constexpr float kMinBandTiles  = 3.0f;   // the 54 %-of-hits radius: never narrower
constexpr float kMaxBandTiles  = 6.0f;   // the 82 % radius: past here it is a wall, not a rule
constexpr float kUnknownTiles  = 4.0f;   // type or projectiles unreadable
// The final approach to a walk-to destination that ITSELF sits in a band (a loot
// bag or a portal beside a mob) is exempt from the band cost — never from a core.
constexpr float kGoalExemptTiles = 1.5f;
// Extra nav A* cost per band cell. Above kUNavHazardCost (6.0): a route would
// rather cross a damaging tile than walk into shotgun range, which is the whole
// point — ground damage is survivable and reactable, a 62 ms shotgun is not.
constexpr float kNavBandCost   = 8.0f;

// r for one enemy TYPE. `projectileTilesPerSec` is the fastest of the type's
// projectile definitions (EnemyTracker caches it per type); `hasProjectiles` says
// whether the type has any at all. An enemy that cannot shoot and has no learned
// self-blast keeps no band — walls, destructibles and inert scenery must not fence
// off a room.
inline float BandRadius(float projectileTilesPerSec, float bodyHalf,
                        bool hasProjectiles, float learnedKeepoutTiles)
{
    float r = 0.f;
    if (hasProjectiles) {
        r = (std::isfinite(projectileTilesPerSec) && projectileTilesPerSec > 0.f)
            ? std::clamp(projectileTilesPerSec * kReactionSec + bodyHalf, kMinBandTiles, kMaxBandTiles)
            : kUnknownTiles;
    }
    // A learned self-blast / stationary field is already a measured keep-out; it
    // sets a floor on the band, never a wider wall than the band's own cap.
    if (std::isfinite(learnedKeepoutTiles) && learnedKeepoutTiles > 0.f)
        r = std::max(r, std::min(learnedKeepoutTiles, kMaxBandTiles));
    return r;
}

// The core this enemy carries. A live mob always has one; inert scenery only earns
// one by shooting (a setpiece tower is not a target but is very much a hazard).
inline float CoreRadius(bool passiveScenery, float bandRadius)
{
    return (!passiveScenery || bandRadius > 0.f) ? kCoreTiles : 0.f;
}

// One rasterised disc. Plain data, copied across the worker and nav-thread
// boundaries; world coordinates, tiles.
struct Disc {
    float x = 0.f, y = 0.f;
    float core = 0.f;   // hard radius (0 = none)
    float band = 0.f;   // soft radius (0 = none); always >= core when non-zero
};
constexpr int kMaxDiscs = 48;

// Raster bits added to the existing occupancy grids (NavGrid::flags,
// OccGrid::flags). The low six are ALL spoken for by TileOccupancy's cell
// vocabulary — 0x20 is kCellFullBody, which the game collision rule reads back
// out of the nav raster (Collision::SquaresFromCells), so taking it silently
// deleted every FullOccupy object from the walk-to route. Only 0x40 and 0x80 are
// genuinely free.
constexpr uint8_t kCoreBit = 0x40;
constexpr uint8_t kBandBit = 0x80;

// Stamp the discs into a square flags grid, ONCE per publish. Cost is the sum of
// the disc areas (about 170 cells for the widest band), never cells x enemies:
// the dodge already peaks at 12-14 ms in a dense scene and a per-cell enemy loop
// over 192 blockers would be the whole frame.
//
// `originX/Y` is the world centre of cell (0,0) and cells advance by `cellTiles`.
// A core the PLAYER IS ALREADY INSIDE is not stamped — the way out has to stay
// open, the same escape rule the AoE and keep-out floors use. Bands are only ever
// a cost, so standing in one fences nobody and they are always stamped.
//
// `exemptGoal` clears the BAND bits (never a core) within kGoalExemptTiles of the
// walk-to destination, so a loot bag, portal or quest marker that itself lies
// beside a mob can still be reached.
inline void Rasterize(uint8_t* flags, int side, float originX, float originY, float cellTiles,
                      const Disc* discs, int count, float playerX, float playerY,
                      bool exemptGoal, float goalX, float goalY)
{
    if (!flags || side <= 0 || cellTiles <= 0.f) return;
    const int cells = side * side;
    for (int i = 0; i < cells; ++i) flags[i] &= static_cast<uint8_t>(~(kCoreBit | kBandBit));
    if (!discs || count <= 0) return;

    const auto stamp = [&](float cx, float cy, float radius, uint8_t bit) {
        if (radius <= 0.f) return;
        const float fx = (cx - originX) / cellTiles, fy = (cy - originY) / cellTiles;
        const int span = static_cast<int>(std::ceil(radius / cellTiles));
        const int cx0 = static_cast<int>(std::lround(fx)), cy0 = static_cast<int>(std::lround(fy));
        const float rSq = radius * radius;
        for (int gy = std::max(0, cy0 - span); gy <= std::min(side - 1, cy0 + span); ++gy) {
            const float wy = originY + static_cast<float>(gy) * cellTiles - cy;
            for (int gx = std::max(0, cx0 - span); gx <= std::min(side - 1, cx0 + span); ++gx) {
                const float wx = originX + static_cast<float>(gx) * cellTiles - cx;
                if (wx * wx + wy * wy < rSq) flags[gy * side + gx] |= bit;
            }
        }
    };

    for (int i = 0; i < count; ++i) {
        const Disc& d = discs[i];
        stamp(d.x, d.y, d.band, kBandBit);
        const float dx = playerX - d.x, dy = playerY - d.y;
        if (d.core > 0.f && dx * dx + dy * dy >= d.core * d.core) stamp(d.x, d.y, d.core, kCoreBit);
    }

    if (!exemptGoal) return;
    const float fx = (goalX - originX) / cellTiles, fy = (goalY - originY) / cellTiles;
    const int span = static_cast<int>(std::ceil(kGoalExemptTiles / cellTiles));
    const int cx0 = static_cast<int>(std::lround(fx)), cy0 = static_cast<int>(std::lround(fy));
    const float rSq = kGoalExemptTiles * kGoalExemptTiles;
    for (int gy = std::max(0, cy0 - span); gy <= std::min(side - 1, cy0 + span); ++gy) {
        const float wy = originY + static_cast<float>(gy) * cellTiles - goalY;
        for (int gx = std::max(0, cx0 - span); gx <= std::min(side - 1, cx0 + span); ++gx) {
            const float wx = originX + static_cast<float>(gx) * cellTiles - goalX;
            if (wx * wx + wy * wy < rSq) flags[gy * side + gx] &= static_cast<uint8_t>(~kBandBit);
        }
    }
}

} }  // namespace UDodge::Standoff
