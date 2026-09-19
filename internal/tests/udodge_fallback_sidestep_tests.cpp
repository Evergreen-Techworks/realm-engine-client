// Navigation finish plan, item 2 ("no safe move: sidestep, do not bolt").
// Unit tests for Solver::SelectFallbackCandidate — the ranking policy inside
// UDodgeSolver.cpp's Fallback branch (no safe reachable cell). Exercised
// directly against synthetic FallbackCandidate arrays rather than through a
// full DangerMap/Solve() fixture, so the tie-break, displacement-floor and
// standing-still-floor rules are each pinned to an exact, controlled scenario.
#include "UDodgeSolver.h"
#include <cstdio>

using namespace UDodge;
using UDodge::Solver::FallbackCandidate;
using UDodge::Solver::SelectFallbackCandidate;

static int failures = 0;
static int checks = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

int main()
{
    // (a) Two candidates tie on time-to-danger (within kSolveFallbackTieMs):
    // one steps radially OUTWARD from the reference direction, one steps
    // TANGENTIAL to it. With the switch on, the tangential step must win; with
    // it off, today's plain (time, val) reduction keeps the first-seen
    // candidate on an exact tie, i.e. the outward one.
    {
        FallbackCandidate cands[2];
        cands[0].dir = { 1.f, 0.f };   // radially outward (dot 1.0 with radialRef)
        cands[0].moveDist = 1.0f;
        cands[0].val = 5.f;
        cands[0].safeTime = 300.f;
        cands[1].dir = { 0.f, 1.f };   // tangential (dot 0.0 with radialRef)
        cands[1].moveDist = 1.0f;
        cands[1].val = 5.f;
        cands[1].safeTime = 300.f;     // exact tie, well inside the 60 ms band
        const Vec2 radialRef{ 1.f, 0.f };

        const int offPick = SelectFallbackCandidate(cands, 2, radialRef, /*sidestepOn=*/false, /*standTime=*/0.f);
        Check(offPick == 0, "switch off: today's pick is the first-seen (radially outward) candidate");

        const int onPick = SelectFallbackCandidate(cands, 2, radialRef, /*sidestepOn=*/true, /*standTime=*/0.f);
        Check(onPick == 1, "switch on: a time-to-danger tie is broken toward the tangential step");
    }

    // (b) A candidate that lives 200 ms longer than standing still must be
    // taken instead of a 0.02-tile jitter, even though the jitter's OWN
    // time-to-danger ranks higher (900 vs 500) and would win the plain
    // (time, val) reduction outright — this isolates the minimum-displacement
    // rule from the tie-break rule above (900 vs 500 is far outside the 60 ms
    // tie band, so rule 1 alone would pick the jitter without rule 5).
    {
        FallbackCandidate cands[2];
        cands[0].dir = {};             // the jitter — e.g. the stand point itself
        cands[0].moveDist = 0.02f;
        cands[0].val = 0.f;
        cands[0].safeTime = 900.f;     // ranks best on time alone
        cands[1].dir = { 0.f, 1.f };
        cands[1].moveDist = 1.0f;
        cands[1].val = 0.f;
        cands[1].safeTime = 500.f;     // 200 ms longer than standing (standTime = 300)
        const float standTime = 300.f;

        const int onPick = SelectFallbackCandidate(cands, 2, Vec2{}, /*sidestepOn=*/true, standTime);
        Check(onPick == 1, "a 200ms-longer-than-standing mover is taken over a 0.02-tile jitter");

        const int offPick = SelectFallbackCandidate(cands, 2, Vec2{}, /*sidestepOn=*/false, standTime);
        Check(offPick == 0, "switch off: the jitter still wins today's plain time-to-danger reduction");
    }

    // (c) A candidate shorter-lived than standing still is never taken: with
    // the switch on and nothing else to choose from, the selector must report
    // "nothing" (-1) rather than commit to a step that is worse than holding.
    {
        FallbackCandidate cands[1];
        cands[0].dir = { 1.f, 0.f };
        cands[0].moveDist = 1.0f;
        cands[0].val = 5.f;
        cands[0].safeTime = 200.f;
        const float standTime = 500.f;   // standing still already outlives this candidate

        const int onPick = SelectFallbackCandidate(cands, 1, Vec2{}, /*sidestepOn=*/true, standTime);
        Check(onPick == -1, "switch on: a step shorter-lived than standing still is never selected");

        const int offPick = SelectFallbackCandidate(cands, 1, Vec2{}, /*sidestepOn=*/false, standTime);
        Check(offPick == 0, "switch off: today's reduction has no standing-still floor and still takes it");
    }

    // Sanity: an empty candidate set never crashes and reports "nothing".
    {
        Check(SelectFallbackCandidate(nullptr, 0, Vec2{}, true, 0.f) == -1, "empty set (on) returns -1");
        Check(SelectFallbackCandidate(nullptr, 0, Vec2{}, false, 0.f) == -1, "empty set (off) returns -1");
    }

    // Settings default: the switch ships ON.
    {
        Settings s{};
        Check(s.fallbackSidestep, "udodgeFallbackSidestep defaults on");
    }

    std::printf("Fallback sidestep regression tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
