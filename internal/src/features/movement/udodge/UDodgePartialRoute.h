#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Navigation {

// A settled blocked endpoint is a deliberate wait, not a failed movement.
// Recheck once per second. Reflex dodge remains independent; leaving the
// endpoint or changing the request immediately restores ordinary replanning.
inline bool PauseBlockedGoalRetry(bool blockedApproach, bool atEnd,
                                  uint64_t now, uint64_t plannedAt)
{
    return blockedApproach && atEnd && now >= plannedAt && now - plannedAt < 1000;
}

// Partial routes explore when a destination cannot currently be reached. A
// nearby destination can reopen before the frontier is reached; check cheaply
// at a bounded cadence rather than committing to an obsolete excursion.
struct PartialRouteRecovery {
    static constexpr uint64_t kIntervalMs = 1000;
    static constexpr float kNearbyTiles = 12.f;
    bool armed = false;
    uint64_t checkedAt = 0;
    Vec2 goal{};

    void Reset() { armed = false; checkedAt = 0; goal = {}; }

    template<class Clear>
    bool Recheck(uint64_t now, bool eligible, Vec2 player, Vec2 destination, Clear clear)
    {
        if (!eligible || !std::isfinite(destination.x) || !std::isfinite(destination.y) ||
            LenSq(Sub(player, destination)) > kNearbyTiles * kNearbyTiles) {
            Reset();
            return false;
        }
        if (!armed || LenSq(Sub(destination, goal)) > .01f || now < checkedAt) {
            armed = true; checkedAt = now; goal = destination;
            return false;
        }
        if (now - checkedAt < kIntervalMs) return false;
        checkedAt = now;
        return clear();
    }
};

} }
