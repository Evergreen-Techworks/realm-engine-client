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
    // Selection-radius CAP in tiles. 0 = no cap (the weapon-derived range
    // stands). When > 0 it can only SHRINK maxRange, never extend it — the same
    // shrink-only semantics `mouseBoundingRange` above already uses. Killaura
    // sets this; nothing else does.
    //
    // It USED to REPLACE the weapon-derived range, and killaura pinned it at a
    // flat 16 tiles. That let killaura lock targets the player could not
    // actually reach, and the hit claims for those shots were refused — the
    // server validates a hit against ITS OWN position for us, so no amount of
    // shot-packet spoofing extends reach. See the measured-results comment at
    // the top of KillAura.cpp.
    float          maxRangeCapTiles     = 0.f;
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
// `rangeCapTiles` is a SHRINK-ONLY cap on the weapon-derived selection radius;
// 0 = auto, i.e. the weapon's own range stands. It can never extend reach.
// `forcedEnemyId != 0` pins the choice to that object id and disables the
// no-health-bar filter, so a breakable wall can be targeted (plan 89).
// Reads the current EnemyTracker snapshot — call after EnemyTracker::Tick().
Result SelectKillAura(bool atMouse, float rangeCapTiles,
                      float playerX, float playerY,
                      int32_t forcedEnemyId,
                      const WeaponProfile& weapon);

// The selection radius SelectKillAura will ACTUALLY filter on for `weapon`
// under `capTiles` (0 = auto). Exposed so killaura's retention drop radius and
// its lock-overlay rings come from the SAME number the selector uses instead of
// a second copy of the weapon-range formula — a mismatch there is what makes a
// lock ring lie about where the lock will be dropped.
float KillAuraSelectionRangeTiles(const WeaponProfile& weapon, float capTiles);

// Read-only view of the priority tier Select() would file `objType` under on
// the killaura path — LOWER rank wins, matching the quest > normal > fallback
// > invuln resolution order. Exposed so a caller weighing two candidates ranks
// them exactly the way the selector does instead of re-deriving the type
// tables. Pure function of objType; changes nothing about what Select()
// returns for any caller.
int KillAuraTierRank(int32_t objType);

} // namespace TargetSelector
