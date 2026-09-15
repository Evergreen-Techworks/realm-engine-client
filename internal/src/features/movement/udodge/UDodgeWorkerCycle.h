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

namespace UDodge { namespace Worker {

inline void RunCycle(const Path::PlannerSnapshot& local, Result& latest)
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
    // Path::Compute may have produced a brand-new navigation corridor from
    // this snapshot. Solve against that corridor's immediate step, not the
    // pre-compute goal submitted by the game thread. Otherwise the overlay
    // shows a correct cyan path while the yellow committed move follows the
    // previous/raw goal for another worker cycle.
    if (goal.walkTo && plan.navFound)
        goal.pos = plan.navStepTarget;
    // A route that exists only across damaging ground is followed with safe-walk
    // relaxed, matching the game thread (UDodge.cpp): the route just planned, or the
    // cached one the game thread is still following.
    if (goal.walkTo && ((plan.navFound && plan.navCrossesHazard) || local.navFollowingHazardRoute)) {
        in.settings.safeWalk = false;
        in.playerOnHazard = false;
    }
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
    const double nowMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    Timed::BuildInput(in, nowMs, 16.7f, Timed::Budget{}, timedIn);
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
    latest.timedMs = std::chrono::duration<float, std::milli>(solve0 - timed0).count();
    latest.solveMs = std::chrono::duration<float, std::milli>(solve1 - solve0).count();
}

} } // namespace UDodge::Worker
