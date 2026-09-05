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
// to the nearest durable-safe cell (PointSafety ≥ kUDurablePocketMargin).
//
// ── SPEED-AWARE / TIME-EXPANDED (the fix) ────────────────────────────────────
// The player moves at a FINITE speed, so a multi-tile route takes several ticks
// to walk and a cell that is "safe now" is NOT safe at the later time the player
// actually arrives (bullets have moved there). So the search solves path(t)
// subject to |path'| ≤ speed and safety at each t:
//   • The Dijkstra edge cost is TIME, not distance: moving cell A→B costs
//     dist(A,B) / player_speed, so g(cell) is the arrival TIME along the route.
//     player_speed is the snapshot's REAL PlannerSnapshot::speed — the same
//     MapInput::speed the immediate solver validates the step with (finding K).
//   • A BOUNDED WAIT (finding F): where the direct relaxation would arrive into a
//     bullet, the search may depart up to kUPathMaxWaitSlices temporal slices
//     later (standing at the current cell, itself ArrivalClear over that whole
//     window) — "stand here 200 ms, let the wall pass, then go", the move a pure
//     arrival-time Dijkstra with no self-edge cannot express.
//   • A cell is traversable only if it is SAFE AT ITS ARRIVAL TIME g(cell): the
//     player position (the cell) is checked against every relevant bullet's
//     PREDICTED position at g(cell), reusing the plan-64 temporal prediction (the
//     lane pointTimesMs polyline + a swept-segment check over the arrival window,
//     culled to nearby lanes). So the route is chosen only if the player, moving
//     at real speed, is clear of bullets at every point at the time they are there.
//   • Goal = a durable-safe cell reached by such a time-feasible route; the
//     time-cost Dijkstra naturally prefers the one reachable SOONEST. If no such
//     SPATIAL pocket exists anywhere in the window, a SECOND-CLASS TEMPORAL goal
//     is admitted instead (finding F): a cell that is merely ArrivalClear over
//     [arrival, arrival + kUDwellMs). The spatial pocket ALWAYS wins when one is
//     available — this is a fallback that stops the route collapsing to `partial`
//     in exactly the dense patterns where the solver's temporal layer would have
//     threaded the gap. Failing both, it degrades gracefully to the best partial
//     route toward the safest reachable-in-time cell — never a route that assumes
//     impossible speed.
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

// Coarse 1-tile navigation occupancy for the walk-to A* (SEPARATE from OccGrid —
// larger window, no hazard/temporal axis). The GAME THREAD fills it from WorldTAB's
// blocked-tile map (one bulk locked read). Squares the server has not streamed are
// map void, NOT open floor: FillNavGrid folds bit3 into bit0 so the A* never routes
// into them. center = the world position of the CENTER cell (= player at raster
// time); cell (gx,gy) covers world tile floor(center) + (gx-rad, gy-rad).
struct NavGrid {
    Vec2    center{};                  // world position of the center cell (= player)
    uint8_t flags[kUNavCells]{};       // bit0 = blocked (wall / occupy-square)
                                      // bit1 = damaging ground (SOFT: kUNavHazardCost per cell, safeWalk only)
                                      // bit2 = sink / water ground (HARD: impassable for nav — see NavBlocked)
                                      // bit3 = UNSTREAMED map void. Folded into bit0 for traversal, but kept
                                      //        distinct so ComputeNav can tell the EXPLORATION boundary ("the
                                      //        map continues here, it just hasn't arrived yet") apart from a
                                      //        wall — see the frontier-partial comment in ComputeNav.
};

// Everything the pathfinder needs — PLAIN DATA ONLY (no IL2CPP handles, no void*,
// no function pointers). Safe to copy across the thread boundary.
struct PlannerSnapshot {
    uint32_t seq = 0;              // monotonic publish sequence (freshness plumbing)
    uint32_t tickId = 0;
    Vec2     player{};
    float    moveBudget = 1.f;     // per-tick move budget (tiles) — a STEP-LENGTH knob ONLY:
                                   // it places the route's step target / lookahead anchor. It is
                                   // NOT the speed the arrival times are computed from — see `speed`.
    // REAL player speed (tiles per ms), the same MapInput::speed the immediate
    // solver validates with. FINDING K: the pathfinder used to derive its
    // ms-per-tile from moveBudget, which equals speed × kServerTickSec ONLY when
    // the user leaves the "Step distance" slider on auto AND the auto clamp
    // [0.4, 3.0] does not bind. Set the slider (or play a heavily-Slowed / very
    // fast character) and the two DECOUPLE: the worker planned arrival times at a
    // fictional speed while the solver validated the step at the real one, so
    // cells were admitted here and rejected there (churn), or a route step was
    // validated against an optimistic arrival. Carrying the real speed makes the
    // two halves of the MPC agree by construction. 0 = unreadable → the old
    // moveBudget-derived value is used as the fallback.
    float    speed = 0.f;
    Settings settings{};           // hitScale / safeWalk feed the plain safety + occupancy tests
    bool     goalActive = false;   // a soft goal exists (tie-break only)
    Vec2     goalPos{};
    bool     goalWalkTo = false;
    bool     playerOnHazard = false;
    bool     hasLock = false;      // locked boss → gate goal cells to the weapon-range disk
    Vec2     lockPos{};
    float    weaponRangeTiles = 0.f; // disk radius (0 = no gate)
    float    innerStandoffTiles = 0.f; // annulus inner radius (0 = no inner gate). Goal cells inside
                                       // this radius of lockPos are rejected as GOALS but stay traversable.
    // ── Plan-commitment hysteresis (plan 76) ─────────────────────────────────
    // Last tick's accepted durable-safe goal, carried forward so the Dijkstra can
    // prefer it among near-equal options (stops the goal marker flip-flopping). The
    // worker re-tests it every pass and drops it the instant it stops being a valid
    // reachable-in-time durable goal — commitment is a tiebreak, never a safety override.
    bool     prevGoalValid = false;
    Vec2     prevGoalPos{};         // last accepted g_route.goalPos (world)
    bool     retreatValid = false;  // an older, nearby point the player actually traversed
    Vec2     retreatPos{};          // soft retreat preference; never bypasses safety/occupancy
    DangerMap map{};               // plain-data danger (lanes+times / zones / enemies) for per-cell cost
    OccGrid   grid{};              // rasterized occupancy+hazard (game thread fills)
    // ── Navigation (Shift+Click walk-to) — second job on the same worker ─────
    bool     navActive = false;   // a walk-to is in progress → run the nav A* too
    Vec2     navGoal{};           // world walk-to target (the clicked spot)
    NavGrid  navGrid{};           // coarse 1-tile occupancy (game thread fills from WorldTAB)
};

// The pathfinder's output — PLAIN DATA ONLY.
struct PlanResult {
    uint32_t forSeq = 0;       // snapshot seq this plan was computed from
    bool  found       = false; // a durable-safe goal cell was reached
    Vec2  goalPos{};           // the durable-safe goal cell (world)
    Vec2  stepTarget{};        // immediate steering target: route point ~one budget ahead
    Vec2  stepDir{};           // unit direction of the first step (player → stepTarget)
    bool  retreatValid = false;
    Vec2  retreatPos{};        // breadcrumb forwarded to the least-bad immediate fallback
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
    bool  tempGoal     = false; // the goal is a SECOND-CLASS TEMPORAL pocket (finding F): no
                                // SPATIAL durable pocket (PointSafety ≥ kUDurablePocketMargin — the
                                // whole-lane-forever test) was time-reachable anywhere in the window,
                                // so the route targets a cell that is merely ArrivalClear over
                                // [arrival, arrival + kUDwellMs]. A spatial pocket ALWAYS wins when
                                // one exists; this only stops the route collapsing to `partial` in
                                // dense patterns where the durable-goal set is empty but the solver's
                                // temporal layer would happily thread the gap. found=true,
                                // partial=false — it is a real, time-feasible goal, just a weaker one.
    float goalArriveMs = 0.f;   // predicted arrival TIME at the goal along the time-cost route (ms)
    int   tempLanes    = 0;     // relevant lanes kept for the arrival-time temporal check (diagnostics)
    int   radiusCells = 0;     // final window radius used (diagnostics)
    int   pops        = 0;     // cells finalized by Dijkstra across all passes (perf diagnostics)
    // ── Navigation A* output (walk-to) ───────────────────────────────────────
    bool  navFound     = false; // an A* route toward the walk-to goal was produced
    bool  navPartial   = false; // goal was outside the window → route heads to the in-window cell nearest it
    bool  navArrived   = false; // the goal cell itself was reached within the window
    Vec2  navStepTarget{};      // immediate steering target: route point ~one move budget ahead
    Vec2  navGoalCell{};        // world center of the reached/target goal cell (diagnostics)
    int   navWptCount  = 0;     // number of route cells in navWpts
    Vec2  navWpts[kMaxNavWpts]{}; // route polyline (world; [0] = player cell) — driver + overlay
    int   navPops      = 0;     // A* cells finalized (perf diagnostics)
    // ── Worker phase timing (perf diagnostics) — plain data, filled by Compute
    // on the worker thread, read by the game thread through the normal handoff.
    float computeDodgeMs = 0.f; // wall-clock of ComputeDodge (ms)
    float computeNavMs   = 0.f; // wall-clock of ComputeNav (ms; 0 when nav idle)
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O, no Env.
// Runs the grid Dijkstra (with in-range-disk gating + safety override when
// snap.hasLock) over the snapshot and writes the route. Called ONLY on the
// worker thread.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Path
