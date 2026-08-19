#pragma once
#include "UDodgeTypes.h"
namespace UDodge { namespace Planner {

// ── Whole-window rasterized occupancy grid (Stage D1/60) ─────────────────────
// The game thread rasterizes a plain-data occupancy+hazard grid over the local
// window (calling Sensors::CanOccupy / IsHazardAt per cell — game-thread-only);
// the worker runs the route planner over this grid ALONE, touching no IL2CPP.
// The radius is a constant so plan 61 can expose it (drop to 24 on regression).
constexpr int   kPlanGridRadius = 40;                       // cells from center
constexpr int   kPlanGridSize   = kPlanGridRadius * 2 + 1;  // 81
constexpr int   kPlanGridCells  = kPlanGridSize * kPlanGridSize;
constexpr float kPlanCellTiles  = 0.5f;                     // 40 tiles reach each way
// kMaxPathPoints (route cap) is defined in UDodgeTypes.h so DebugSnapshot shares it;
// it is visible here through the enclosing UDodge namespace.

struct OccGrid {
    Vec2    center{};                 // world position of the grid center (= player)
    uint8_t flags[kPlanGridCells]{};  // bit0 = wall/blocked, bit1 = hazard
};

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
    DangerMap map{};                   // plain-data danger (lanes/zones) for routing cost
    OccGrid   grid{};                  // rasterized occupancy+hazard (game thread fills it)
};

// The planner's output — PLAIN DATA ONLY.
struct PlanResult {
    uint32_t forSeq = 0;       // snapshot seq this plan was computed from
    bool     hasGoal = false;  // a goal target exists (autopilot has a lock)
    Vec2     goalPos{};        // world target the plan aims at
    Vec2     firstDir{};       // unit intent direction to feed Core::Evaluate (0 = none)
    Vec2     path[kMaxPathPoints]{};   // routed polyline (world coords), for overlay
    int      pathCount = 0;
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Planner
