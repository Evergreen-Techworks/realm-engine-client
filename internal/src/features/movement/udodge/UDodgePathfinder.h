#pragma once
#include "UDodgeTypes.h"

// UDodge grid pathfinder (plan 65; TIME-EXPANDED per plan 64 temporal model) — a
// bounded local grid Dijkstra that finds a WAYPOINT ROUTE around obstacles to the
// nearest durable-safe area, the piece the straight-line per-tick solver cannot
// supply. The solver picks the nearest safe pocket and walks STRAIGHT at it; if
// bullets or a wall block that ray it settles for a nearer, worse one — it can
// never route AROUND the obstruction. This does: it lays a coarse occupancy grid
// over a bounded window centered on the player, marks walls / hazard / enemy
// bodies as BLOCKED, then runs an 8-neighbour Dijkstra (no diagonal corner-cutting)
// to the nearest durable-safe cell (PointSafety ≥ kUPocketMargin).
//
// ── SPEED-AWARE / TIME-EXPANDED (the fix) ────────────────────────────────────
// The player moves at a FINITE speed, so a multi-tile route takes several ticks
// to walk and a cell that is "safe now" is NOT safe at the later time the player
// actually arrives (bullets have moved there). So the search solves path(t)
// subject to |path'| ≤ speed and safety at each t:
//   • The Dijkstra edge cost is TIME, not distance: moving cell A→B costs
//     dist(A,B) / player_speed, so g(cell) is the arrival TIME along the route.
//     player_speed derives from the snapshot moveBudget (= speed × kServerTickSec).
//   • A cell is traversable only if it is SAFE AT ITS ARRIVAL TIME g(cell): the
//     player position (the cell) is checked against every relevant bullet's
//     PREDICTED position at g(cell), reusing the plan-64 temporal prediction (the
//     lane pointTimesMs polyline + a swept-segment check over the arrival window,
//     culled to nearby lanes). So the route is chosen only if the player, moving
//     at real speed, is clear of bullets at every point at the time they are there.
//   • Goal = a durable-safe cell reached by such a time-feasible route; the
//     time-cost Dijkstra naturally prefers the one reachable SOONEST. If NO
//     time-feasible route to a durable pocket exists, it degrades gracefully to
//     the best partial route toward the safest reachable-in-time cell — never a
//     route that assumes impossible speed.
// Its first step (≈ one budget along the route) is the lookahead target; over
// ticks the player follows the curve around the obstacle. If nothing safe is near,
// the window EXPANDS outward and re-searches. The game-thread immediate micro-dodge
// floor still overrides every step (unchanged) — this only improves the ROUTE.
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
    // Route polyline in WORLD coords for the debug overlay ([0] = player cell,
    // [wptCount-1] = goal). Bounded copy of the reconstructed route (≤ kMaxPathPoints);
    // plain data, safe across the worker→game handoff. Overlay only — the solver
    // steers by stepTarget/goalPos, not this buffer.
    int   wptCount    = 0;
    Vec2  wpts[kMaxPathPoints]{};
    bool  startIsGoal = false; // the player cell is already durable-safe (no route needed)
    bool  expanded    = false; // the window grew beyond the base radius to find the goal
    bool  outOfRange  = false; // locked: no in-range goal, used an unconstrained (out-of-range) goal
    bool  partial      = false; // no durable pocket was time-reachable; the route heads to the
                                // SAFEST reachable-in-time cell instead (best-effort lookahead bias,
                                // still fully time-feasible — never assumes impossible speed)
    float goalArriveMs = 0.f;   // predicted arrival TIME at the goal along the time-cost route (ms)
    int   tempLanes    = 0;     // relevant lanes kept for the arrival-time temporal check (diagnostics)
    int   radiusCells = 0;     // final window radius used (diagnostics)
    int   pops        = 0;     // cells finalized by Dijkstra across all passes (perf diagnostics)
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O, no Env.
// Runs the grid Dijkstra (with in-range-disk gating + safety override when
// snap.hasLock) over the snapshot and writes the route. Called ONLY on the
// worker thread.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Path
