#pragma once
// One worker planning cycle over a plain-data snapshot: the grid pathfinder, the
// bounded temporal planner, then the worker-side solve. Shared by the worker
// thread (UDodgeWorker.cpp) and the host scenario harness, so the harness drives
// the exact cycle the game uses rather than a copy of it.
//
// IL2CPP-FREE: plain data in, plain data out — see UDodgeWorker.cpp.
#include "UDodgeWorker.h"
#include "UDodgePathfinder.h"
#include "UDodgeTimedPlanner.h"

#include <chrono>

// RunCycle takes its planning clock and search budget from the caller (see below).
#define UDODGE_WORKER_CYCLE_CLOCK 1

namespace UDodge { namespace Worker {

// The planning clock: milliseconds on the time base the caller's world runs on. The
// temporal planner stamps the plan it retains across cycles with it and ages that
// plan by the difference, which decides whether the plan is kept (the player is
// where it says) or dropped, and how much of a wait is left.
//   - The worker thread passes SteadyNowMs: the host's monotonic clock, which is the
//     game's time base. It is sampled at the point the cycle always sampled it.
//   - A caller that simulates time (the host scenario harness) passes its scenario
//     clock. On the host clock its plans aged by microseconds while its world moved
//     by whole frames, so every retained plan looked diverged or blocked.
// The per-phase timers below (timedMs, solveMs) measure compute cost and stay on the
// host clock for every caller.
using PlanningClock = double (*)();

inline double SteadyNowMs()
{
    return std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// `budget` bounds the temporal search. Its maxSearchMs is a WALL-CLOCK deadline on
// the host (SpacetimeCore reads steady_clock for it): the worker thread passes
// Timed::Budget{}; a caller on simulated time passes maxSearchMs = 0, leaving the
// search bounded by its expansion count alone, so its result does not depend on how
// fast the host is.
inline void RunCycle(const Path::PlannerSnapshot& local, Result& latest,
                     PlanningClock planningNowMs, const Timed::Budget& budget)
{
    Path::PlanResult plan{};
    Path::Compute(local, plan);

    MapInput in{};
    in.player = local.player;
    in.speed = local.speed;
    in.stepTiles = local.moveBudget;
    in.tickId = local.tickId;
    in.playerOnHazard = local.playerOnHazard;
    in.settings = local.settings;
    in.map = &local.map;
    in.env.occFlags = local.grid.flags;
    in.env.occCenter = local.grid.center;
    in.env.occSide = kUPathMaxSide;
    in.env.occRadius = kUPathMaxRadCells;
    in.env.occCellTiles = kUPathCellTiles;
    in.env.rule = local.collisionRule;
    if (local.collisionRule == Movement::Collision::Rule::Game) {
        in.env.squares = local.grid.squares;
        in.env.squareX0 = local.grid.squareX0;
        in.env.squareY0 = local.grid.squareY0;
        in.env.squareSide = kUOccSquareSide;
    }

    Solver::Goal goal{};
    goal.active = local.goalActive;
    goal.pos = local.goalPos;
    goal.walkTo = local.goalWalkTo;
    goal.groupActive = local.groupActive;
    goal.groupPos = local.groupPos;
    // Path::Compute may have produced a brand-new navigation corridor from
    // this snapshot. Solve against that corridor's immediate step, not the
    // pre-compute goal submitted by the game thread. Otherwise the overlay
    // shows a correct cyan path while the yellow committed move follows the
    // previous/raw goal for another worker cycle.
    if (goal.walkTo && plan.navFound)
        goal.pos = plan.navStepTarget;
    goal.fromLock = local.hasLock;
    goal.lockPos = local.lockPos;
    goal.maxRange = local.weaponRangeTiles;
    goal.innerStandoff = local.innerStandoffTiles;

    // ── Bounded temporal search (advisory) ──────────────────────────────────
    // Runs on the worker, never on the game thread: it allocates inside its
    // search and is bounded by an expansion count and a wall-clock budget. A
    // search that finds nothing certified publishes an INVALID advice, which the
    // solver treats exactly as "no advice".
    const auto timed0 = std::chrono::steady_clock::now();
    static SpacetimeDodge::State timedState;   // retained plan across cycles (worker thread only)
    SpacetimeDodge::Input timedIn{};
    const double nowMs = planningNowMs();
    Timed::BuildInput(in, nowMs, 16.7f, budget, timedIn);
    SpacetimeDodge::Output timedOut{};
    SpacetimeDodge::Evaluate(timedIn, timedState, timedOut);
    const Solver::TimedAdvice timed = Timed::ToAdvice(timedOut, in.player, local.moveBudget);

    const auto solve0 = std::chrono::steady_clock::now();
    CoreState solveState = local.commitment.state;
    Solver::SolveResult solve{};
    Solver::Solve(in, local.moveBudget, goal, plan, solveState, solve, timed);
    const auto solve1 = std::chrono::steady_clock::now();

    latest.plan = plan;
    latest.solve = solve;
    latest.solveGoal = goal.pos;
    latest.timed = timed;
    latest.solveState = solveState;
    latest.commitmentRevision = local.commitment.revision;
    latest.snapshotPlayer = local.player;
    latest.walkGoal = local.navGoal;
    latest.walkActive = local.goalWalkTo;
    latest.groupActive = local.groupActive;
    latest.groupPos = local.groupPos;
    latest.groupBossId = local.groupBossId;
    latest.timedMs = std::chrono::duration<float, std::milli>(solve0 - timed0).count();
    latest.solveMs = std::chrono::duration<float, std::milli>(solve1 - solve0).count();
    latest.timedStatus = static_cast<uint8_t>(timedOut.status);
    latest.timedReplanReason = static_cast<uint8_t>(timedOut.replanReason);
    latest.timedReused = timedOut.reused;
    latest.timedBudgetHit = timedOut.budgetHit;
    latest.timedExpansions = timedOut.expansions;
}

} } // namespace UDodge::Worker
