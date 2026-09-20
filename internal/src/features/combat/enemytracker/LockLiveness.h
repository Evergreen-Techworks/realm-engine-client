#pragma once
// Lock liveness — the one answer to "is the locked enemy still a fight?".
//
// Every consumer reads this: the dodge planner (UDodge's hasLock, filled in
// UDodgeSensors PopulateEnemies), the dodge lock goal (DangerPlanner
// ResolveEnemyLock) and AutoAim's explicit lock (TargetSelector via LockPolicy).
// They used to answer it three ways (an hp > 0 test, presence in the live-enemy
// scan plus a 4 s grace, presence in the snapshot).
//
// No grace. A lock whose enemy is dead or gone from this thread's snapshot is Gone
// on the same tick, so the planner stops fighting and keeps dodging what is already
// in the air — the rule l_lock_boss_dies measures at 0 hits. The unified engine
// never read the old grace, and holding a dead boss's last position is the "walks
// back toward the stale position" the rebuild spec forbids (spec 4.3, section 7).
//
// Pure over a snapshot, so the host suite tests it and the scenario harness drives
// the rule the game uses. EnemyTracker::GetLock reads this thread's snapshot.
#include "features/combat/enemytracker/EnemyTracker.h"

#include <cmath>
#include <cstdint>
#include <vector>

namespace EnemyTracker {

enum class LockState : uint8_t {
    None,           // no lock (id <= 0)
    Live,           // alive and damageable
    Invulnerable,   // alive, not damageable right now: keep the fight, do not shoot
    Gone,           // dead, or not in the snapshot (killed, despawned, out of view, filtered)
};

struct LockInfo {
    LockState    state = LockState::None;
    int32_t      id    = 0;
    const Entry* entry = nullptr;   // into the snapshot; valid until this thread's next Tick
    float        x = 0.f, y = 0.f;
};

// Alive: positive HP at a finite position. EnemyClassify already keeps hp <= 0 out of
// the game's snapshot; the rule is stated once here so any snapshot answers the same.
inline bool EntryAlive(const Entry& e)
{
    return e.hp > 0 && std::isfinite(e.x) && std::isfinite(e.y);
}

inline LockInfo ResolveLock(const std::vector<Entry>& snapshot, int32_t lockId)
{
    LockInfo info;
    info.id = lockId;
    if (lockId <= 0) return info;
    info.state = LockState::Gone;
    for (const Entry& e : snapshot) {
        if (e.id != lockId) continue;
        if (!EntryAlive(e)) return info;
        info.state = e.isInvulnerable ? LockState::Invulnerable : LockState::Live;
        info.entry = &e;
        info.x = e.x;
        info.y = e.y;
        return info;
    }
    return info;
}

// The planner keeps fighting (approach, orbit, engagement ring) a Live or
// Invulnerable lock, and nothing else.
inline bool Engages(const LockInfo& lock)
{
    return lock.state == LockState::Live || lock.state == LockState::Invulnerable;
}

// This thread's snapshot (call EnemyTracker::Tick first on this thread).
inline LockInfo GetLock(int32_t lockId) { return ResolveLock(GetSnapshot(), lockId); }

} // namespace EnemyTracker
