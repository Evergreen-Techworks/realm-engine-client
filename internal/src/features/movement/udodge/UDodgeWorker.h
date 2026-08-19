#pragma once
#include "UDodgePlanner.h"

// UDodge planner worker — the background thread that runs Planner::Compute
// decoupled from render/update frame rate (Stage C2, plan 59).
//
// THREAD-BOUNDARY CONTRACT (mandatory — see plan 55): the worker touches ONLY
// the plain-data PlannerSnapshot and writes a plain-data PlanResult. It never
// calls IL2CPP, never reads a game object, never dereferences an Env function
// pointer. All IL2CPP reads and all movement execution stay on the game-update
// thread (UDodge::Tick), which publishes snapshots and consumes plans through
// the non-blocking handoff below.
namespace UDodge { namespace Worker {

void Start();  // idempotent; spawns the worker thread (double-start guarded)
void Stop();   // joins the worker thread; idempotent (safe if never started)

// Game thread → worker. Non-blocking: on lock contention the publish is dropped
// (the worker keeps the previous snapshot); the game thread NEVER blocks.
void PublishSnapshot(const Planner::PlannerSnapshot& snap);

// Worker → game thread. Non-blocking: returns false on contention or when no
// plan has been produced yet; the game thread then keeps its own last-known plan.
bool TryGetLatestPlan(Planner::PlanResult& out);

} } // namespace UDodge::Worker
