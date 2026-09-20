// Worker cycle planning clock (Tactician Slice 1, Part A).
//
// Worker::RunCycle keeps one temporal plan across cycles and ages it by
// `now - plan.epochMs`. That age decides whether the retained plan is still where
// the player is (kept) or has drifted (dropped and searched again), and how much of
// a wait is left. The cycle used to read the host's steady clock for `now`, so a
// caller that simulates time - the scenario harness, 40 to 200 times faster than
// real time - had its plans aged by microseconds of host time instead of the tens
// of milliseconds of scenario time between two cycles.
//
// These tests drive two cycles a known scenario interval apart, with the world
// advanced by exactly that interval, and check the cycle decided from the clock it
// was given. (A plan is only ever kept while it is still waiting to leave: once it
// moves, re-validation charges a fresh 40 ms command lead that a latest-departure
// plan has no slack for, on any clock. So the wait is where the clock shows.)
#include "UDodgeWorkerCycle.h"

#include <cmath>
#include <cstdio>

using namespace UDodge;

// Isolate the cycle's temporal planner from the grid search (as the commitment
// tests do): the real RunCycle, planner adapter, SpacetimeCore and solver still run.
namespace UDodge { namespace Path {
void Compute(const PlannerSnapshot& in, PlanResult& out) { out = {}; out.forSeq = in.seq; }
} }

static int checks = 0, failures = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

static double g_scenarioMs = 0.0;
static double ScenarioNowMs() { return g_scenarioMs; }

// No wall-clock search deadline: the search is bounded by its expansion count only,
// so the result cannot depend on how fast the host happens to be.
static Timed::Budget DeterministicBudget()
{
    Timed::Budget budget{};
    budget.maxSearchMs = 0.f;
    return budget;
}

static void Cycle(const Path::PlannerSnapshot& snap, Worker::Result& out, const Timed::Budget& budget)
{
#ifdef UDODGE_WORKER_CYCLE_CLOCK
    Worker::RunCycle(snap, out, &ScenarioNowMs, budget);
#else
    (void)budget;
    Worker::RunCycle(snap, out);   // pre-fix cycle: no way to hand it scenario time
#endif
}

// One straight shot flying +x along y = 0, `elapsedMs` after it was fired from
// (-3.5, 0) at 10 tiles/s with 600 ms of life. The lane is re-anchored to the
// bullet's live position, the way the sensors rebuild it every frame.
static void PutShot(DangerMap& map, float elapsedMs)
{
    constexpr float kSpeed = 0.01f, kLifeMs = 600.f, kStartX = -3.5f;
    map.laneCount = 1;
    LaneThreat& lane = map.lanes[0];
    lane = LaneThreat{};
    lane.hitHalf = 0.4f;
    lane.hasLinearMotion = true;
    lane.linearVelocity = { kSpeed, 0.f };
    lane.remainingLifeMs = kLifeMs - elapsedMs;
    lane.pointCount = lane.instantCount = 2;
    lane.points[0] = { kStartX + kSpeed * elapsedMs, 0.f };
    lane.points[1] = { kStartX + kSpeed * kLifeMs, 0.f };
    lane.pointTimesMs[0] = 0.f;
    lane.pointTimesMs[1] = kLifeMs - elapsedMs;
    lane.tailAtShotEnd = true;
}

static Path::PlannerSnapshot& Snapshot()
{
    static Path::PlannerSnapshot snap{};   // large: keep off the stack
    return snap;
}

int main()
{
    constexpr float kSpeed = 0.005f;        // player, tiles per ms
    constexpr double kT0 = 250000.0;        // scenario time of the first cycle
    constexpr float kWaitGapMs = 100.f;     // not a multiple of the planner's 40 ms control step
    constexpr uint8_t kWaiting = static_cast<uint8_t>(SpacetimeDodge::Status::Waiting);
    constexpr uint8_t kNoReason = static_cast<uint8_t>(SpacetimeDodge::Reason::None);
    const Timed::Budget budget = DeterministicBudget();

    Path::PlannerSnapshot& snap = Snapshot();
    snap.speed = kSpeed;
    snap.moveBudget = 3.f;
    snap.player = { 0.f, 0.f };
    PutShot(snap.map, 0.f);                 // reaches the stand in about 290 ms

    // ── Cycle 1 at scenario time T0: a fresh plan that waits, then sidesteps ──
    Worker::Result first{};
    g_scenarioMs = kT0;
    Cycle(snap, first, budget);
    Check(first.timedStatus == kWaiting && first.timed.valid && first.timed.waiting,
          "the first cycle advises a wait");
    Check(!first.timedReused, "the first cycle has no plan to keep");
    Check(first.timed.departureMs > kWaitGapMs + 1.f,
          "the shot is far enough out that the wait outlasts the gap to the next cycle");

    // ── Cycle 2 at T0 + 100 ms: same stand, the shot 100 ms further on ───────
    // The retained plan still fits the world exactly, so it is kept and its wait has
    // 100 ms less to run. Aged by microseconds of host time instead, the plan says
    // "leave in 160 ms" about a shot that now arrives 100 ms sooner: it fails its own
    // validation, is thrown away, and a new search runs - whose wait can only be a
    // multiple of the 40 ms control step, never "100 ms less".
    PutShot(snap.map, kWaitGapMs);
    Worker::Result second{};
    g_scenarioMs = kT0 + kWaitGapMs;
    Cycle(snap, second, budget);
    Check(second.timedReused && second.timedReplanReason == kNoReason,
          "a cycle at scenario time T0+100 ms ages the retained plan by 100 ms and keeps it");
    Check(second.timed.valid && second.timed.waiting &&
          std::fabs(second.timed.departureMs - (first.timed.departureMs - kWaitGapMs)) < 1e-2f,
          "the wait left at T0+100 ms is the first cycle's wait less 100 ms");
    if (!second.timedReused)
        std::fprintf(stderr, "  cycle at T0+100: status=%d reused=%d wait=%.1f (first wait %.1f) replan reason: %s\n",
                     second.timedStatus, second.timedReused ? 1 : 0, second.timed.departureMs,
                     first.timed.departureMs,
                     SpacetimeDodge::ReasonName(static_cast<SpacetimeDodge::Reason>(second.timedReplanReason)));

    // ── The clock alone ages a plan ──────────────────────────────────────────
    // Nothing moved, but the scenario clock says two seconds passed: the plan ran
    // out long ago (it spans 800 ms), however little host time went by.
    Worker::Result late{};
    g_scenarioMs = kT0 + kWaitGapMs + 2000.0;
    Cycle(snap, late, budget);
    Check(!late.timedReused, "a plan past its own horizon by the scenario clock is not kept");

#ifdef UDODGE_WORKER_CYCLE_CLOCK
    // ── The search deadline is the caller's too ─────────────────────────────
    // The production worker passes Timed::Budget{} (a 4 ms wall-clock deadline); a
    // caller on simulated time passes none, so its result cannot depend on the host.
    const auto freshSearch = [&](const Timed::Budget& b, Worker::Result& out) {
        snap.player = { 0.f, 0.f };
        snap.map.laneCount = 0;             // an empty map drops the retained plan
        Worker::Result clear{};
        g_scenarioMs += 1000.0;
        Cycle(snap, clear, budget);
        Check(clear.timedStatus == static_cast<uint8_t>(SpacetimeDodge::Status::Clear),
              "an empty map leaves the stand clear");
        PutShot(snap.map, 0.f);
        g_scenarioMs += 1000.0;
        Cycle(snap, out, b);
    };
    Worker::Result fed{}, starved{};
    freshSearch(budget, fed);
    Timed::Budget expired{};
    expired.maxSearchMs = 1e-6f;            // a deadline that has passed before the search starts
    freshSearch(expired, starved);
    Check(fed.timedStatus == kWaiting && !fed.timedBudgetHit && fed.timedExpansions > 16,
          "with no wall-clock deadline the search runs to its answer");
    Check(starved.timedBudgetHit && starved.timedExpansions < fed.timedExpansions,
          "an expired wall-clock deadline cuts the same search short");

    const double a = Worker::SteadyNowMs();
    const double b = Worker::SteadyNowMs();
    Check(std::isfinite(a) && a > 0.0 && b >= a, "the production planning clock is the monotonic host clock");
#endif

    std::printf("Worker clock tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
