#include "pch-il2cpp.h"
#include "features/movement/sensors/TileSensor.h"

#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/TestTAB.h"

#include <cmath>

namespace Movement { namespace TileSensor {

bool IsHazardAt(HazardMemo& memo, float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return false;
    const int tx = static_cast<int>(std::floor(worldX));
    const int ty = static_cast<int>(std::floor(worldY));
    const uint32_t key = TileKey(tx, ty);
    uint8_t cached = 0;
    if (memo.Find(key, cached)) return cached != 0;
    // Live, cover-aware check (transform-proof); falls back to the cached map
    // internally if the raw call is unavailable on this build.
    const bool hz = WorldTAB::IsTileDamagingLive(tx, ty);
    memo.Insert(key, hz ? 1 : 0);
    return hz;
}

bool IsWallAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return true;  // unknown → treat as blocked
    return TestTAB::IsWalkPositionBlocked(worldX, worldY);
}

bool CanOccupy(HazardMemo& memo, float worldX, float worldY, bool safeWalk)
{
    if (!IsFinitePoint(worldX, worldY)) return false;   // unknown → treat as blocked
    // The game's isValidPosition has TWO parts and the planner must model BOTH, or
    // it steers to positions the game then refuses and the player wedges in place.
    //   A) IsWalkPositionBlocked — the player box against blocked tiles.
    //   B) IsWalkCircleBlocked   — the SUB-TILE FullOccupy neighbour rule: a tile can
    //      be perfectly walkable and still reject a position whose fractional offset
    //      puts the player against a FullOccupy neighbour (Player.isFullOccupy()).
    // Only (A) was checked here, so every FullOccupy object — trees above all — had a
    // ring of sub-tile positions the planner believed were free and the game denied.
    // Walking into one produced no movement at all: the step was issued every tick,
    // refused every tick, and the player sat stuck against the trees until the goal
    // moved. TestTAB's own Ctrl-teleport already gates on both tests (IsPositionBlocked
    // || IsCircleBlocked); this simply brings the dodge/nav occupancy model in line.
    if (TestTAB::IsWalkPositionBlocked(worldX, worldY)) return false;
    if (TestTAB::IsWalkCircleBlocked(worldX, worldY))   return false;
    if (safeWalk && IsHazardAt(memo, worldX, worldY)) return false;
    return true;
}

} } // namespace Movement::TileSensor
