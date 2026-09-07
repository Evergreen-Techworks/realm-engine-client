#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include <cstdio>
#include "../src/features/movement/dodge/DodgeGeometry.h"

using namespace UDodge;
static int failures = 0;
static int checks = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

int main()
{
    static DangerMap map{};
    MapInput in{};
    in.map = &map;
    in.speed = 0.005f;
    Solver::Goal goal{};
    goal.active = true;
    goal.pos = {5.f, 0.f};
    Path::PlanResult route{};
    CoreState state{};
    state.lastMoveDir = {1.f, 0.f};
    Solver::SolveResult decision{};
    map.laneCount = 1;
    auto& lane = map.lanes[0];
    lane.hitHalf = 0.05f;
    lane.pointCount = 2;
    lane.instantCount = 1; // only the beginning is painted; the full prediction hits
    lane.points[0] = {4.f, 0.f};
    lane.points[1] = {0.f, 0.f};
    lane.pointTimesMs[0] = 0.f;
    lane.pointTimesMs[1] = 250.f;
    lane.tailAtShotEnd = true;
    Core::Temporal::Ctx ctx{};
    Core::Temporal::Build(map, 1.f, 0.f, {}, kUTemporalCullTiles, ctx);
    Check(Core::SegmentSafety(in, {}, {1.f, 0.f}) >= kULatencyPad,
          "fixture passes shortened spatial lane check");
    Check(!Core::Temporal::PathClear(ctx, {}, in.speed, {1.f, 0.f}),
          "fixture predicts a collision on the same move");
    Solver::Solve(in, 1.f, goal, route, state, decision);
    Check(decision.kind == Solver::SolveKind::Safe && decision.shouldMove,
          "solver finds a safe alternative");
    Check(Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "spatially clear candidate cannot bypass temporal veto");

    decision.kind = Solver::SolveKind::Safe;
    decision.shouldMove = true;
    decision.target = {1.f, 0.f};
    Check(Solver::RevalidateAndSolve(in, 1.f, goal, route, state, decision, false),
          "moving cached target rechecks prediction beyond painted lane");
    Check(Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "cached move replaced with temporally safe alternative");

    // Simulate a new projectile entering a rebuilt map. The stale target now
    // fails even the spatial check; rebuilding must not suppress the re-solve.
    lane.instantCount = 2;
    decision.kind = Solver::SolveKind::Safe;
    decision.shouldMove = true;
    decision.target = {1.f, 0.f};
    Check(Solver::RevalidateAndSolve(in, 1.f, goal, route, state, decision, true),
          "rebuilt map triggers immediate replacement of unsafe movement");
    Check(Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "rebuild replacement is safe before movement executes");

    // A stale Hold also needs early warning when the newly captured shot is
    // outside its painted prefix, before it reaches the player's current cell.
    lane.instantCount = 1;
    decision = Solver::SolveResult{};
    Check(Solver::RevalidateAndSolve(in, 1.f, goal, route, state, decision, true),
          "new threat invalidates a spatially clear hold on rebuilt map");
    Check(decision.shouldMove && Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "new threat prompts a safe dodge while worker is pending");

    // The worker found a safe retreat along the bullet axis. A fully safe
    // lateral move must be considered before blindly accepting that route.
    goal = Solver::Goal{};
    route.found = true;
    route.stepTarget = {-1.f, 0.f};
    lane.points[0] = {3.f, 0.f};
    lane.points[1] = {-1.f, 0.f};
    lane.pointTimesMs[1] = 800.f;
    lane.remainingLifeMs = 800.f;
    lane.instantCount = 2;
    in.speed = 0.01f;
    state.Reset();
    state.lastMoveDir = {-1.f, 0.f};
    Core::Temporal::Build(map, 1.f, 0.f, {}, kUTemporalCullTiles, ctx);
    // Use a longer retreat to put the route's endpoint beyond the shot lifetime.
    route.stepTarget = {-2.f, 0.f};
    Check(Core::Temporal::PathClear(ctx, {}, in.speed, route.stepTarget),
          "retreat fixture itself is safe");
    Solver::Solve(in, 2.f, goal, route, state, decision);
    Check(decision.shouldMove && std::fabs(decision.target.y) > std::fabs(decision.target.x),
          "safe lateral movement wins over radial worker retreat");
    Check(Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "lateral route replacement preserves temporal admission");
    in.env.canOccupy = [](float, float y, bool) { return std::fabs(y) < 0.1f; };
    state.Reset();
    Solver::Solve(in, 2.f, goal, route, state, decision);
    Check(decision.shouldMove && std::fabs(decision.target.y) < 0.1f &&
          Core::Temporal::PathClear(ctx, {}, in.speed, decision.target),
          "blocked sidesteps preserve safe retreat");
    in.env.canOccupy = nullptr;
    route = Path::PlanResult{};
    map.laneCount = 0;
    decision = Solver::SolveResult{};
    Check(!Solver::RevalidateAndSolve(in, 1.f, goal, route, state, decision, true),
          "clear rebuild does not trigger unnecessary solve");
    Check(!Solver::RevalidateAndSolve(in, 1.f, goal, route, state, decision, false),
          "clear held position does not re-solve every frame");
    map.laneCount = 1;
    lane = LaneThreat{};
    lane.beam = true;
    lane.pointCount = lane.instantCount = 2;
    lane.points[0] = {-10.f, 0.f}; lane.points[1] = {10.f, 0.f};
    lane.hitHalf = 0.1f; lane.remainingLifeMs = 500.f;
    Core::Temporal::Build(map, 1.f, 0.f, {}, 2.f, ctx);
    Check(ctx.count == 1 && ctx.beam[0], "long beam survives culling by its distant origin");
    Check(!Core::Temporal::ArrivalClear(ctx, {}, 200.f, 300.f), "beam middle remains occupied at future times");
    Check(!Core::Temporal::EdgeClear(ctx, {0,-2}, {0,2}, 0.f, 400.f), "cannot time-thread through a stationary beam");
    Check(Core::Temporal::EdgeClear(ctx, {-2,2}, {2,2}, 0.f, 400.f), "parallel motion outside beam is safe");
    Check(Core::Temporal::ArrivalClear(ctx, {}, 600.f, 700.f), "beam danger ends after expiry grace");
    Check(!Core::Temporal::PathClear(ctx, {0,-2}, 0.01f, {0,2}), "live movement gate rejects crossing beam");
    Check(DodgeGeometry::SegmentHitsBox(-10,0,10,0,0,0,0.3f) &&
          !DodgeGeometry::SegmentHitsBox(-10,0,10,0,12,0,0.3f), "beam collision covers middle but stops at endpoint");
    std::printf("Admission/rebuild regression tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
