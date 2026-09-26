// Owner hypothesis, 2026-09-26: while a boss lock is active and the current
// spot is a durable safe stand, udodgeNeverStandLocked must decline the
// stand-still candidate and pick a safe MOVING candidate instead, rather than
// holding — see UDodgeTypes.h's Settings::neverStandLocked doc comment and
// docs/dodge-loop/progress.md for the measurable prediction this is tested
// against live. This exercises the real Solver::Solve() path (not a synthetic
// helper) because the fix spans two spots inside Solve(): the early Hold
// decline and the reflex loop's candidate exclusion — either alone is not
// enough to change the outcome (see the OFF/ON asymmetry below).
#include "UDodgeSolver.h"
#include <cstdio>
using namespace UDodge;

int main() {
    int n = 0, f = 0;
    auto ck = [&](bool x, const char* m) { ++n; if (!x) { ++f; std::printf("FAIL %s\n", m); } };

    static DangerMap map;              // empty/open map: no lanes, no zones, no enemies --
                                        // every candidate around the player is safe, so the
                                        // choice between "stand" and "move" is decided purely
                                        // by this flag, not by any surrounding danger.
    MapInput in;
    in.map = &map;
    in.speed = .05f;
    in.player = {0.f, 0.f};

    Solver::Goal goal;
    goal.active = goal.fromLock = true;
    goal.lockPos = {3.f, 0.f};
    goal.pos = {3.f, 0.f};
    goal.maxRange = 6.f;                // well within range: no repositionInward pull.

    Path::PlanResult route;             // no route: isolates the reflex loop, not pre-position.

    {
        // OFF (default): today's engine holds at a durable, in-range, boss-locked stand.
        in.settings = Settings{};
        in.settings.neverStandLocked = false;
        CoreState state;
        Solver::SolveResult out;
        Solver::Solve(in, 1.f, goal, route, state, out);
        ck(out.kind == Solver::SolveKind::Hold && !out.shouldMove,
           "switch off: holds at the durable in-range locked stand, as today");
    }

    {
        // ON: the exact same scenario must NOT hold -- a safe moving candidate
        // must be picked instead (the open map guarantees several exist).
        in.settings = Settings{};
        in.settings.neverStandLocked = true;
        CoreState state;
        Solver::SolveResult out;
        Solver::Solve(in, 1.f, goal, route, state, out);
        ck(out.kind == Solver::SolveKind::Safe && out.shouldMove,
           "switch on: does not accept the stand-still candidate -- picks a safe moving one");
        ck(!(out.target.x == in.player.x && out.target.y == in.player.y),
           "switch on: the chosen target actually differs from the current position");
    }

    {
        // ON but NOT locked (goal.fromLock=false): the flag is scoped to an
        // active boss lock only -- unlocked navigation is unaffected.
        Solver::Goal unlockedGoal;                 // fromLock=false by default
        in.settings = Settings{};
        in.settings.neverStandLocked = true;
        CoreState state;
        Solver::SolveResult out;
        Solver::Solve(in, 1.f, unlockedGoal, route, state, out);
        ck(out.kind == Solver::SolveKind::Hold && !out.shouldMove,
           "switch on, no active lock: unlocked stand is unaffected, still holds");
    }

    std::printf("never-stand-locked: %d checks %d failures\n", n, f);
    return f ? 1 : 0;
}
