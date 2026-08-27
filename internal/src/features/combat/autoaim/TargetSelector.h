#pragma once

#include "WeaponProfile.h"
#include <cstdint>

namespace TargetSelector {

enum class Mode : int {
    ClosestToPlayer = 0,
    HighestHP       = 1,
    ClosestToMouse  = 2,
    Locked          = 3, // Track a specific enemy by ID; falls back to ClosestToPlayer if it dies
};

struct Config {
    Mode           mode                 = Mode::ClosestToPlayer;
    bool           shootInvulnerable    = false;
    bool           prioritizeBosses     = true;
    bool           ignoreWalls          = true;  // skip noHealthBar entities
    // Skip static objects that cannot shoot: walls, breakable trees, crates.
    // They are tagged as enemies and do have health bars, so ignoreWalls misses
    // them and the aim snaps to whatever scenery happens to be closest.
    bool           ignoreScenery        = true;
    float          rangeLeadBias        = 1.0f;  // extra tiles past weapon range
    bool           mouseBoundingEnabled = false;
    float          mouseBoundingRange   = 8.0f;
    int32_t        lockedEnemyId        = -1;    // used when mode == Locked
    const int32_t* skipObjTypes         = nullptr; // optional phase-skip list
    int            skipObjCount         = 0;
};

struct Result {
    bool    found   = false;
    float   aimX    = 0.f;
    float   aimY    = 0.f;
    int32_t enemyId = -1;
    int32_t objType = 0;
};

// playerX/Y and mouseX/Y in world-space tiles.
// Reads the current EnemyTracker snapshot — call after EnemyTracker::Tick().
Result Select(const Config& cfg,
              float playerX, float playerY,
              float mouseX,  float mouseY,
              const WeaponProfile& weapon);

} // namespace TargetSelector
