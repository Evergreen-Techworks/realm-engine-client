#pragma once
#include "UDodgeTypes.h"

// UDodge grid pathfinder (plan 65) — a bounded local grid Dijkstra that finds a
// WAYPOINT ROUTE around obstacles to the nearest durable-safe area, the piece the
// straight-line per-tick solver cannot supply. The solver picks the nearest safe
// pocket and walks STRAIGHT at it; if bullets or a wall block that ray it settles
// for a nearer, worse one — it can never route AROUND the obstruction. This does:
// it lays a coarse occupancy/cost grid over a bounded window centered on the
// player, marks walls / hazard / enemy bodies as BLOCKED and derives per-cell
// danger from the CHEAP spatial Core::PointSafety, then runs an 8-neighbour
// Dijkstra (no diagonal corner-cutting) to the nearest durable-safe cell
// (PointSafety ≥ kUPocketMargin). Its first step (≈ one budget along the route)
// is the lookahead target; over ticks the player follows the curve around the
// obstacle. If nothing safe is near, the window EXPANDS outward and re-searches.
//
// ── THREADING (plan 65 two-rate MPC) ─────────────────────────────────────────
// Compute() runs on the DEDICATED WORKER THREAD (UDodge::Worker), NOT the game
// thread. It is PURE PLAIN-DATA MATH: it reads only the PlannerSnapshot (a
// DangerMap copy + a rasterized occupancy grid the GAME THREAD filled) and writes
// a plain PlanResult. It NEVER calls IL2CPP, never touches a game object, and
// never dereferences an Env function pointer — occupancy comes from the plain
// grid, danger from Core::PointSafety over the plain DangerMap. The game thread's
// immediate micro-dodge remains the safety floor and consumes the route only as a
// lookahead bias. See UDodgeWorker.h for the non-blocking handoff contract.
namespace UDodge { namespace Path {

// Rasterized occupancy + hazard over the maximum window (kUPathMaxRadCells). The
// GAME THREAD fills this (Sensors::CanOccupy / IsHazardAt per cell — game-thread
// only) and packs it into the snapshot; the worker reads it ALONE for occupancy,
// never Env::canOccupy. Always the full max window so the worker's radius
// expansion just searches a larger sub-window of the same grid.
struct OccGrid {
    Vec2    center{};                  // world position of the center cell (= player at raster time)
    uint8_t flags[kUPathMaxCells]{};   // bit0 = wall/blocked, bit1 = hazard
};

// Everything the pathfinder needs — PLAIN DATA ONLY (no IL2CPP handles, no void*,
// no function pointers). Safe to copy across the thread boundary.
struct PlannerSnapshot {
    uint32_t seq = 0;              // monotonic publish sequence (freshness plumbing)
    uint32_t tickId = 0;
    Vec2     player{};
    float    moveBudget = 1.f;     // per-tick move budget (tiles) — places the step target
    Settings settings{};           // hitScale / safeWalk feed the plain safety + occupancy tests
    bool     goalActive = false;   // a soft goal exists (tie-break only)
    Vec2     goalPos{};
    bool     hasLock = false;      // locked boss → gate goal cells to the weapon-range disk
    Vec2     lockPos{};
    float    weaponRangeTiles = 0.f; // disk radius (0 = no gate)
    DangerMap map{};               // plain-data danger (lanes+times / zones / enemies) for per-cell cost
    OccGrid   grid{};              // rasterized occupancy+hazard (game thread fills)
};

// The pathfinder's output — PLAIN DATA ONLY.
struct PlanResult {
    uint32_t forSeq = 0;       // snapshot seq this plan was computed from
    bool  found       = false; // a durable-safe goal cell was reached
    Vec2  goalPos{};           // the durable-safe goal cell (world)
    Vec2  stepTarget{};        // immediate steering target: route point ~one budget ahead
    Vec2  stepDir{};           // unit direction of the first step (player → stepTarget)
    float goalDist    = 0.f;   // grid path arc-length to the goal (tiles)
    int   waypoints   = 0;     // number of route cells (diagnostics; PATH len=<n>)
    bool  startIsGoal = false; // the player cell is already durable-safe (no route needed)
    bool  expanded    = false; // the window grew beyond the base radius to find the goal
    bool  outOfRange  = false; // locked: no in-range goal, used an unconstrained (out-of-range) goal
    int   radiusCells = 0;     // final window radius used (diagnostics)
    int   pops        = 0;     // cells finalized by Dijkstra across all passes (perf diagnostics)
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O, no Env.
// Runs the grid Dijkstra (with in-range-disk gating + safety override when
// snap.hasLock) over the snapshot and writes the route. Called ONLY on the
// worker thread.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Path
