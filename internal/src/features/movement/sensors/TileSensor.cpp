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
    if (TestTAB::IsWalkPositionBlocked(worldX, worldY)) return false;
    if (safeWalk && IsHazardAt(memo, worldX, worldY)) return false;
    return true;
}

} } // namespace Movement::TileSensor
