#pragma once
#include "UDodgeTypes.h"
namespace UDodge { namespace Planner {

// Everything the goal planner needs — PLAIN DATA ONLY (no IL2CPP handles, no
// void*, no function pointers). Safe to copy across a thread boundary.
struct PlannerSnapshot {
    uint32_t seq = 0;          // monotonically increasing publish sequence
    uint32_t tickId = 0;
    Vec2     player{};
    Settings settings{};
    bool     hasLock = false;
    Vec2     lockPos{};
    float    weaponRangeTiles = 6.f;   // resolved on the game thread
    bool     rangeResolved = false;
    // (Stage D1/60 adds the DangerMap + rasterized occupancy grid here.)
};

// The planner's output — PLAIN DATA ONLY.
struct PlanResult {
    uint32_t forSeq = 0;       // snapshot seq this plan was computed from
    bool     hasGoal = false;  // a goal target exists (autopilot has a lock)
    Vec2     goalPos{};        // world target the plan aims at
    Vec2     firstDir{};       // unit intent direction to feed Core::Evaluate (0 = none)
    // (Stage D1/60 adds Vec2 path[] + int pathCount for overlay drawing.)
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Planner
