#pragma once
#include "UDodgePathfinder.h"
#include "UDodgeSolver.h"

// UDodge pathfinder worker (plan 65) — the background thread that runs the grid
// Dijkstra (Path::Compute) decoupled from render/update frame rate. Rebuilt fresh
// from the retired plan-58/59 planner seam for the new grid pathfinder.
//
// THREAD-BOUNDARY CONTRACT (mandatory): the worker touches ONLY the plain-data
// Path::PlannerSnapshot and writes a plain-data Path::PlanResult. It never calls
// IL2CPP, never reads a game object, never dereferences an Env function pointer.
// All IL2CPP reads and all movement execution stay on the game-update thread
// (UDodge::Tick), which publishes snapshots and consumes plans through the
// non-blocking handoff below. The game thread NEVER blocks on the worker; its
// immediate micro-dodge stays the safety floor even when the route is stale.
namespace UDodge { namespace Worker {

struct Result {
    CoreState solveState{};
    uint64_t commitmentRevision = 0; // snapshot state this decision was computed from
    Path::PlanResult plan{};
    Solver::SolveResult solve{};
    Vec2 snapshotPlayer{};
    Vec2 solveGoal{}; // actual corridor point used by the worker solver
    // Bounded temporal-planner advice for this snapshot (UDodgeTimedPlanner.h).
    // Advisory only: the game thread re-tests it against every hard floor.
    Solver::TimedAdvice timed{};
    Vec2 walkGoal{};
    bool walkActive = false;
    bool groupActive = false;
    Vec2 groupPos{};
    int32_t groupBossId = 0;
    // Worker wall-clock for the temporal planner and the worker solve (ms) —
    // plain data for the field diagnostics (DiagTiming); never steers anything.
    float timedMs = 0.f;
    float solveMs = 0.f;
    // What the temporal planner did with this snapshot — plain data for the field
    // diagnostics and the host tests; never steers anything. timedReused: the plan
    // retained from an earlier cycle was still valid at this cycle's planning time
    // and was kept. timedBudgetHit: the search stopped on its expansion count or its
    // wall-clock deadline (Timed::Budget) rather than on an answer.
    uint8_t  timedStatus = 0;         // SpacetimeDodge::Status
    uint8_t  timedReplanReason = 0;   // SpacetimeDodge::Reason (None: nothing retained, or reused)
    bool     timedReused = false;
    bool     timedBudgetHit = false;
    int32_t  timedExpansions = 0;
};

void Start();  // idempotent; spawns the worker thread (double-start guarded)
void Stop();   // joins the worker thread; idempotent (safe if never started)

// Game thread → worker. Non-blocking: on lock contention the publish is dropped
// (the worker keeps the previous snapshot); the game thread NEVER blocks. Returns
// the publish sequence assigned to this snapshot, or 0 if dropped on contention.
uint32_t PublishSnapshot(const Path::PlannerSnapshot& snap);

// Worker → game thread. Non-blocking: returns false on contention or when no plan
// has been produced yet; the game thread then keeps its own last-known plan.
bool TryGetLatest(Result& out);

} } // namespace UDodge::Worker
