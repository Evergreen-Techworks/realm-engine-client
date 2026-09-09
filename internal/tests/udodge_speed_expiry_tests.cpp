#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include "../src/features/movement/dodge/MovementSpeed.h"
#include "../src/features/projectiles/ProjectileRetirePolicy.h"
#include "../src/features/movement/dodge/MovementFrameBudget.h"
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
    // ── Live-pool reconcile: retire on consecutive misses, not on a per-pass cap ──
    // A tracked shot the game has deleted must disappear from the danger map fast
    // (a dense volley despawning at once otherwise leaves ghost lanes that block
    // movement), but a single INCOMPLETE pool read must never drop a live shot.
    {
        using ProjectileRetirePolicy::Reconcile;
        using ProjectileRetirePolicy::Action;
        const float minAge = 150.f;

        // Genuinely deleted: absent from two consecutive reads.
        uint8_t streak = 0;
        Check(Reconcile(false, 200.f, minAge, streak) == Action::Keep, "one miss is not yet proof of deletion");
        Check(Reconcile(false, 200.f, minAge, streak) == Action::Retire, "two consecutive misses retire the shot");

        // A partial read that misses a LIVE shot once cannot retire it: the next
        // successful read sees it again and clears the streak.
        streak = 0;
        Check(Reconcile(false, 200.f, minAge, streak) == Action::Keep, "partial read misses a live shot once");
        Check(Reconcile(true, 200.f, minAge, streak) == Action::Keep, "reappearing shot is kept");
        Check(streak == 0, "a present shot clears its miss streak");
        Check(Reconcile(false, 200.f, minAge, streak) == Action::Keep, "streak restarts after reappearing");

        // A fresh spawn may not be in the pool read yet: never judged, never counted.
        streak = 0;
        Check(Reconcile(false, 10.f, minAge, streak) == Action::Keep, "a too-young slot is not judged");
        Check(streak == 0, "a too-young slot accrues no miss streak");
        Check(Reconcile(false, 10.f, minAge, streak) == Action::Keep, "repeated young misses still keep the shot");

        // No per-pass cap: a whole volley retires together once each shot has
        // missed twice, which is what clears ghost lanes promptly.
        int retired = 0;
        uint8_t volley[40] = {};
        for (int pass = 0; pass < 2; ++pass)
            for (auto& m : volley)
                if (Reconcile(false, 200.f, minAge, m) == Action::Retire) ++retired;
        Check(retired == 40, "an entire despawned volley retires in the second pass");
    }
    // ── One movement allowance per game update ───────────────────────────────
    // The game's own update moves the player from input, and the dodge then
    // issues its own MoveTo in the same update. Without an allowance the two
    // stack and the player travels up to twice their speed for that frame, so
    // the plan the solver validated is not the motion that happens.
    {
        DodgeRuntime::MovementFrameBudget budget;
        Check(budget.Available(1000.) == 0.f, "no allowance exists before an update begins");
        Check(!budget.Claim(1000., 5.f), "nothing can be claimed before an update begins");

        budget.Begin(1000., 16.f);
        Check(budget.Available(1000.) == 16.f, "the first update falls back to the supplied delta");
        Check(!budget.Claim(1000., 20.f), "a claim longer than the allowance is refused");
        Check(budget.Available(1000.) == 16.f, "a refused claim consumes nothing");
        Check(budget.Claim(1000., 16.f), "the full allowance can be claimed");
        Check(budget.Available(1000.) == 0.f, "a claimed allowance is spent");
        Check(!budget.Claim(1000., 1.f), "a spent allowance refuses a second claim");

        // A second update measures its own elapsed time; idle time is not banked.
        budget.Begin(1016., 16.f);
        Check(budget.Available(1016.) == 16.f, "each update measures its own elapsed time");
        budget.End();
        Check(budget.Available(1016.) == 0.f, "no allowance survives the end of the update");

        // The game moved the player itself: the automated mover must add nothing.
        budget.Begin(1032., 16.f);
        budget.Native(1032.);
        Check(budget.Available(1032.) == 0.f, "native movement consumes the update's allowance");
        Check(!budget.Claim(1032., 1.f), "nothing may be added on top of native movement");

        // Partial charging is what keeps the dodge able to override. The game
        // moving the player part of a frame must reduce the allowance, not erase
        // it: erasing it would leave the dodge unable to steer at all whenever
        // the player holds a direction.
        DodgeRuntime::MovementFrameBudget shared;
        shared.Begin(2000., 16.f);
        shared.Charge(6.f);
        Check(std::fabs(shared.Available(2000.) - 10.f) < 1e-4f, "observed native travel is charged, not erased");
        Check(shared.Claim(2000., 10.f), "the remainder stays claimable after a partial charge");
        shared.Begin(2016., 16.f);
        shared.Charge(40.f);
        Check(shared.Available(2016.) == 0.f, "a charge larger than the allowance empties it");
        Check(!shared.Claim(2016., 1.f), "an emptied allowance refuses a claim");
        shared.Begin(2032., 16.f);
        shared.Charge(-5.f);
        shared.Charge(std::numeric_limits<float>::quiet_NaN());
        Check(shared.Available(2032.) == 16.f, "malformed charges are ignored");

        // A long stall must not bank a huge allowance for one update.
        DodgeRuntime::MovementFrameBudget stalled;
        stalled.Begin(0., 16.f);
        stalled.Begin(5000., 16.f);
        Check(stalled.Available(5000.) <= 50.f, "a stalled update's allowance stays bounded");

        // Malformed durations are refused rather than silently clamped.
        DodgeRuntime::MovementFrameBudget guard;
        guard.Begin(0., 16.f);
        Check(!guard.Claim(0., 0.f), "a zero-duration claim is refused");
        Check(!guard.Claim(0., -1.f), "a negative claim is refused");
        Check(!guard.Claim(0., std::numeric_limits<float>::quiet_NaN()), "a non-finite claim is refused");
        Check(guard.Available(0.) == 16.f, "refused malformed claims consume nothing");
    }

    std::printf("Speed/expiry tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
