#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include "../src/features/movement/dodge/MovementSpeed.h"
#include <cstdio>
#include <limits>
using namespace UDodge;
static int checks = 0, failures = 0;
static void Check(bool ok, const char* name) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}
int main() {
    using namespace DodgeRuntime;
    const float base = ResolveTilesPerSec(50, 1.f);
    Check(std::fabs(ResolveTilesPerSec(50, .1f) - base * .1f) < 1e-5f, "honor severe slow");
    Check(std::fabs(ResolveTilesPerSec(50, .2f) - base * .2f) < 1e-5f, "honor old threshold boundary");
    Check(ResolveTilesPerSec(50, .01f) > 0.f && ResolveTilesPerSec(50, .01f) < .5f, "retain tiny valid speeds");
    Check(ResolveTilesPerSec(50, 0.f) == 0.f, "zero is immobilized");
    Check(ResolveTilesPerSec(-1, 0.f) == 0.f, "zero does not require base stat");
    Check(ResolveTilesPerSec(50, -1.f) < 0.f, "negative multiplier is unreadable");
    Check(ResolveTilesPerSec(50, std::numeric_limits<float>::quiet_NaN()) < 0.f, "nonfinite multiplier rejected");
    Check(SpeedOrFallback(0.f, base) == 0.f, "fallback preserves valid zero");
    Check(SpeedOrFallback(-1.f, base) == base, "fallback handles failed read");
    Check(ResolveTilesPerSec(20, SpeedOrFallback(-1.f, 1.f)) == ResolveTilesPerSec(20, 1.f), "unknown multiplier retains known SPD");

    static DangerMap map{};
    MapInput in{}; in.map = &map;
    Solver::Goal goal{}; goal.active = goal.walkTo = true; goal.pos = {5.f, 0.f};
    Path::PlanResult route{}; CoreState state{}; Solver::SolveResult result{};
    Solver::Solve(in, 1.f, goal, route, state, result);
    Check(!result.shouldMove && result.kind != Solver::SolveKind::Safe, "zero-speed solver does not invent reachable move");
    result.shouldMove = true; result.target = {1.f, 0.f};
    Check(Solver::RevalidateAndSolve(in, 1.f, goal, route, state, result, false) && !result.shouldMove,
          "zero speed cancels a previously moving decision");

    map.laneCount = 1; auto& l = map.lanes[0];
    l.pointCount = l.instantCount = 2; l.hitHalf = .05f;
    l.points[0] = {-1.f, 0.f}; l.points[1] = {0.f, 0.f};
    l.pointTimesMs[1] = 100.f; l.tailAtShotEnd = true;
    Core::Temporal::Ctx ctx{};
    auto build = [&] { Core::Temporal::Build(map, 1.f, 0.f, {}, 10.f, ctx); };
    build();
    Check(Core::Temporal::PathClear(ctx, {2.f,0.f}, .005f, {}), "walk into gap after known shot expiry");
    Check(!Core::Temporal::PathClear(ctx, {}, 0.f, {}), "shot still hits before expiry");
    Check(Core::Temporal::ArrivalClear(ctx, {}, 300.f, 400.f), "arrival ignores expired shot");
    Check(!Core::Temporal::ArrivalClear(ctx, {}, 50.f, 100.f), "arrival preserves live crossing");
    Check(Core::Temporal::EdgeClear(ctx, {2.f,0.f}, {}, 0.f, 400.f), "edge clips at expiry during traversal");
    Check(!Core::Temporal::EdgeClear(ctx, {-1.f,0.f}, {}, 0.f, 100.f), "edge still rejects live collision");
    const float expiry = ctx.expiresMs[0];
    Check(expiry == 100.f + kUPredErrMs, "known death includes timing grace");
    Check(!Core::Temporal::ArrivalClear(ctx, {}, expiry - 1.f, expiry + 1.f), "arrival clips a partial step at expiry");
    Check(Core::Temporal::ArrivalClear(ctx, {}, expiry + 1.f, expiry + 2.f), "arrival is clear after grace");
    Check(Core::Temporal::EdgeClear(ctx, {-1.f,0.f}, {1.f,0.f}, expiry + 1.f, expiry + 2.f), "edge is clear after grace");

    l.tailAtShotEnd = false; build();
    Check(!Core::Temporal::PathClear(ctx, {2.f,0.f}, .005f, {}), "unknown trace end does not imply death");
    l.tailAtShotEnd = true; l.remainingLifeMs = 600.f; build();
    Check(!Core::Temporal::PathClear(ctx, {2.f,0.f}, .005f, {}), "explicit lifetime overrides shortened trace end");
    l.remainingLifeMs = 75.f; build();
    Check(ctx.expiresMs[0] == 75.f + kUPredErrMs, "live lifetime refresh changes expiry independent of trace");
    Check(Core::Temporal::ArrivalClear(ctx, {}, 1100.f, 1200.f), "expired shot does not reappear past horizon");
    Check(Core::Temporal::EdgeClear(ctx, {-1.f,0.f}, {1.f,0.f}, 1100.f, 1200.f), "expired edge stays clear past horizon");
    std::printf("Speed/expiry tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
