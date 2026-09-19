#pragma once
#include "UDodgeTelemetry.h"
#include "UDodgeTypes.h"

// Item 1 (navigation finish plan, S1): a single per-tick answer to "what is the
// objective right now". UDodge::Tick already derives WASD / walk-to / lock-approach
// / follow / lock from the existing DangerPlanner getters (GetWalkGoal,
// GetFollowPlayer, the enemy lock on DangerMap) once per tick, to build both
// Solver::Goal and the [Diag/Nav] telemetry sample. This header gives that
// derivation one name and one identity so route commitment (UDodge.cpp, the
// walk-to nav re-plan decision) can ask "did the objective change since last
// tick" without re-deriving it a third time.
//
// Deliberately NOT a rewrite of DangerPlanner: the setters (SetWalkGoal,
// SetEnemyLock, SetFollowPlayer, ...) are untouched and keep their signatures.
// UDodge::Tick fills one GoalOwner from what it already computed; nothing else
// writes one. Plain data, game-update thread only.
namespace UDodge {

struct GoalOwner {
    Telemetry::Objective kind = Telemetry::Objective::None;
    int32_t targetId = 0;   // enemy lock id (Lock / LockApproach) or followed player id (Follow); 0 otherwise
    Vec2    target{};       // lock position, or the walk-to / follow goal

    // Same objective as `other` — same kind, same target identity. Used to tell a
    // detour (still the same objective) from a real hand-off (a new one) so the
    // route follower knows whether "the objective changed" is a re-plan trigger
    // this tick.
    bool SameObjective(const GoalOwner& other) const
    {
        return kind == other.kind && targetId == other.targetId;
    }
};

// Item 1 S2: why the walk-to / lock-approach route follower re-planned this
// tick, or None on a frame that kept following the committed route. Exactly the
// four triggers the plan names, plus the two pre-existing hard-safety triggers
// (GoalMoved covers the lock-approach goal itself moving, which is a form of
// "objective changed" already handled by its own hysteresis; Blocked is "route
// invalidated" by a fresh occupancy/keep-out read rather than by distance).
enum class ReplanReason : uint8_t {
    None, Invalidated, ObjectiveChanged, Arrival, NoProgress, GoalMoved, Blocked
};

} // namespace UDodge
