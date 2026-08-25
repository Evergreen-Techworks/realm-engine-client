#pragma once

#include "features/combat/autoaim/core/WeaponProfile.h"
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
    float          rangeLeadBias        = 1.0f;  // extra tiles past weapon range
    bool           mouseBoundingEnabled = false;
    float          mouseBoundingRange   = 8.0f;
    int32_t        lockedEnemyId        = -1;    // used when mode == Locked
    const int32_t* skipObjTypes         = nullptr; // optional phase-skip list
    int            skipObjCount         = 0;
    // Absolute selection radius in tiles. 0 = off (weapon-derived range, the
    // pre-existing behavior). When > 0 it REPLACES the weapon-derived maxRange
    // for both player-ref and mouse-ref modes. Killaura sets this so it can
    // select past weapon range; nothing else sets it.
    float          overrideRangeTiles   = 0.f;
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

// Killaura selection. Thin wrapper over Select():
//   atMouse == false -> reference point is the player
//   atMouse == true  -> reference point is the mouse world position
// `rangeTiles` is an ABSOLUTE radius around the reference point (not weapon
// range). `forcedEnemyId != 0` pins the choice to that object id and disables
// the no-health-bar filter, so a breakable wall can be targeted (plan 89).
// Reads the current EnemyTracker snapshot — call after EnemyTracker::Tick().
Result SelectKillAura(bool atMouse, float rangeTiles,
                      float playerX, float playerY,
                      int32_t forcedEnemyId,
                      const WeaponProfile& weapon);

// Read-only view of the priority tier Select() would file `objType` under on
// the killaura path — LOWER rank wins, matching the quest > normal > fallback
// > invuln resolution order. Exposed so a caller weighing two candidates ranks
// them exactly the way the selector does instead of re-deriving the type
// tables. Pure function of objType; changes nothing about what Select()
// returns for any caller.
int KillAuraTierRank(int32_t objType);

} // namespace TargetSelector
