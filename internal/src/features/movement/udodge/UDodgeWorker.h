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
    Path::PlanResult plan{};
    Solver::SolveResult solve{};
    Vec2 snapshotPlayer{};
    Vec2 walkGoal{};
    bool walkActive = false;
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
