#pragma once
// LockPolicy — what AutoAim does with an explicit lock (TargetSelector Mode::Locked
// with an id: the script's scriptEnemyLockId / scriptCombatTargetId, or the
// Locked radio). Pure, so the host suite tests it (tests/enemy_tracker_tests.cpp).
//
// An explicit lock is a choice, so AutoAim's "Ignore walls" and "Ignore
// walls / breakables" filters do not apply to it. Those filters keep breakables
// out of AUTOMATIC selection; the 68 <Enemy/> types they catch in 86ad651b are
// all destructible walls, barrels, trees and structures, none <Invincible/>.
// KillAura's forced target was already exempt.
//
// What stays: an invulnerable lock is not shot (unless "Shoot invulnerable"), and
// AutoAim then holds instead of silently switching to another enemy — the caller
// asked for this one, and the script re-targets on its own isTargetable. Only a
// lock that is gone from the snapshot (killed, despawned, or dropped by
// EnemyClassify) falls back to normal selection, as it always has.
#include "features/combat/enemytracker/EnemyTracker.h"

namespace LockPolicy {

enum class Use {
    Aim,        // aim at the locked enemy
    Hold,       // locked enemy present but not to be shot: no target this tick
    FallBack,   // locked enemy not in the snapshot: normal selection
};

inline Use Decide(const EnemyTracker::Entry* locked, bool shootInvulnerable)
{
    if (!locked) return Use::FallBack;
    if (locked->isInvulnerable && !shootInvulnerable) return Use::Hold;
    return Use::Aim;
}

} // namespace LockPolicy
