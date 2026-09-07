#pragma once
#include "UDodgeTypes.h"

namespace UDodge {
// Game-thread-owned state. Workers receive value snapshots, never references.
struct MovementCommitment {
    CoreState state{};
    uint64_t revision = 0;

    void Reset() { state.Reset(); ++revision; }
    bool Accepts(uint64_t basis) const { return basis == revision; }

    bool Record(const CoreState& proposed, Vec2 displacement, bool moveAccepted)
    {
        const float distance = Len(displacement);
        if (!moveAccepted || !std::isfinite(distance) || distance <= 1e-5f) return false;
        const Vec2 heading = Mul(displacement, 1.f / distance);
        const bool changed = LenSq(Sub(heading, state.lastMoveDir)) > 1e-6f ||
                             proposed.dampStreak != state.dampStreak;
        state = proposed;
        state.lastMoveDir = heading;
        if (changed) ++revision;
        return true;
    }
};
}
