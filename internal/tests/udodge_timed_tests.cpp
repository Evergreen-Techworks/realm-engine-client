// Timed-escape stage: shared lane/enemy facts the planner consumes, the
// planner itself, and the solver stage that gates its advice.
#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgeLaneMotion.h"
#include "UDodgeTimedPlanner.h"
#include <cstdio>
#include <cmath>

using namespace UDodge;
static int checks = 0, failures = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

int main()
{
    // ── Verified constant motion ─────────────────────────────────────────────
    // Only a polyline that really is a straight line at constant speed may be
    // projected past its traced samples. Anything else must stay unknown, so a
    // curved or packet-guessed lane can never authorise extrapolation.
    {
        Vec2  pts[4]; float ts[4];
        Vec2  v{};
        for (int i = 0; i < 4; ++i) { pts[i] = {i * 0.6f, i * 0.8f}; ts[i] = i * 50.f; }
        Check(LaneMotion::DetectLinear(pts, ts, 4, v) &&
              std::fabs(v.x - 0.012f) < 1e-6f && std::fabs(v.y - 0.016f) < 1e-6f,
              "a straight constant-speed polyline yields its velocity");

        pts[2] = {1.6f, 1.6f};   // a bend
        Check(!LaneMotion::DetectLinear(pts, ts, 4, v), "a bent polyline is not linear motion");

        for (int i = 0; i < 4; ++i) { pts[i] = {i * i * 0.5f, 0.f}; ts[i] = i * 50.f; }
        Check(!LaneMotion::DetectLinear(pts, ts, 4, v), "an accelerating polyline is not linear motion");

        for (int i = 0; i < 4; ++i) { pts[i] = {i * 0.6f, 0.f}; ts[i] = i * 50.f; }
        ts[2] = ts[1];   // non-advancing clock
        Check(!LaneMotion::DetectLinear(pts, ts, 4, v), "a non-advancing sample clock is rejected");

        ts[2] = 100.f;
        pts[3] = {std::nanf(""), 0.f};
        Check(!LaneMotion::DetectLinear(pts, ts, 4, v), "a non-finite sample is rejected");

        Vec2 two[2] = {{0.f, 0.f}, {1.f, 0.f}}; float twoT[2] = {0.f, 100.f};
        Check(LaneMotion::DetectLinear(two, twoT, 2, v) && std::fabs(v.x - 0.01f) < 1e-6f,
              "a two-point lane is linear by construction");
        Check(!LaneMotion::DetectLinear(two, twoT, 1, v), "a single point carries no velocity");
    }

    // ── Enemy keep-out radius ────────────────────────────────────────────────
    // Scenery constrains routes but is never scaled: only live mobs respond to
    // the clearance preference, and the default scale reproduces today's radius.
    {
        EnemyBlocker mob{}; mob.pos = {}; mob.radius = 0.8f;
        EnemyBlocker scenery = mob; scenery.passiveScenery = true;
        Settings s{};
        Check(std::fabs(EnemyAvoidanceRadius(mob, s) - (0.8f + kUPlayerHalf)) < 1e-6f,
              "default enemy avoidance radius is the legacy body + player footprint");
        s.enemyAvoidanceScale = 2.f;
        Check(std::fabs(EnemyAvoidanceRadius(mob, s) - 2.f * (0.8f + kUPlayerHalf)) < 1e-6f,
              "a live mob honours the clearance scale");
        Check(std::fabs(EnemyAvoidanceRadius(scenery, s) - (0.8f + kUPlayerHalf)) < 1e-6f,
              "static scenery ignores the clearance scale");
    }

    // ── Solver stage 6b: the timed-escape gate ───────────────────────────────
    // The advice contributes a step target and nothing else. It is driven only
    // when it passes every floor the grid route step passes, and it is reached
    // only where UDodge would otherwise fall through to the reflex.
    {
        static DangerMap map{};
        MapInput in{};
        in.map = &map;
        in.speed = 0.005f;              // 5 tiles/s
        in.player = {};
        // A shot sweeping up the y axis through the stand at ~300 ms: the stand
        // is not durable (so stage 5 cannot hold) but survives its dwell window.
        map.laneCount = 1;
        auto& sweep = map.lanes[0];
        sweep = LaneThreat{};
        sweep.pointCount = sweep.instantCount = 2;
        sweep.hitHalf = 0.2f;
        sweep.points[0] = {0.f, -3.f};
        sweep.points[1] = {0.f,  3.f};
        sweep.pointTimesMs[0] = 0.f;
        sweep.pointTimesMs[1] = 600.f;
        sweep.tailAtShotEnd = true;

        Solver::Goal goal{};             // no walk-to, no lock: stages 4/5/6 cannot return
        Path::PlanResult route{};        // no grid route: stage 6 cannot return
        Solver::SolveResult result{};

        Solver::TimedAdvice advice{};
        advice.valid = true;
        advice.moves = true;
        advice.stepTarget = {2.f, 0.f};  // clear of the sweeping lane

        CoreState state{};
        Solver::Solve(in, 1.f, goal, route, state, result, advice);
        Check(result.timedEscape && result.shouldMove && result.kind == Solver::SolveKind::Safe,
              "a safe timed step is driven");
        Check(std::fabs(result.target.x - 1.f) < 1e-4f && std::fabs(result.target.y) < 1e-4f,
              "the timed step is clamped to one move budget");

        // Every floor, one at a time. In each case the advice must be dropped
        // and control must fall through to the untouched reflex.
        in.env.canOccupy = [](float x, float, bool) { return x <= 0.5f; };
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, advice);
        Check(!result.timedEscape, "a timed step through a wall is refused");
        in.env.canOccupy = nullptr;

        map.enemyCount = 1;
        map.enemies[0].pos = {1.f, 0.f};
        map.enemies[0].radius = 0.5f;
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, advice);
        Check(!result.timedEscape, "a timed step through an enemy body is refused");
        map.enemyCount = 0;

        map.zoneCount = 1;
        map.zones[0].pos = {1.f, 0.f};
        map.zones[0].radius = 0.6f;
        map.zones[0].active = true;
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, advice);
        Check(!result.timedEscape, "a timed step into an active blast is refused");
        map.zoneCount = 0;

        map.laneCount = 2;               // a stationary shot parked on the step target
        auto& parked = map.lanes[1];
        parked = LaneThreat{};
        parked.pointCount = parked.instantCount = 2;
        parked.hitHalf = 0.3f;
        parked.points[0] = parked.points[1] = {1.f, 0.f};
        parked.pointTimesMs[0] = 0.f;
        parked.pointTimesMs[1] = 1200.f;
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, advice);
        Check(!result.timedEscape, "a temporally unsafe timed step is refused");
        map.laneCount = 1;

        // A deliberate wait is honoured only while UDodge's own dwell test says
        // the stand survives — the same admission test every candidate faces.
        Solver::TimedAdvice wait{};
        wait.valid = true;
        wait.waiting = true;
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, wait);
        Check(result.timedEscape && !result.shouldMove && result.kind == Solver::SolveKind::Hold,
              "a wait is honoured while the stand survives its dwell window");

        sweep.pointTimesMs[1] = 200.f;   // the same shot arrives inside the dwell window
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, wait);
        Check(!result.timedEscape, "a wait is refused once the stand fails its dwell window");
        sweep.pointTimesMs[1] = 600.f;

        // No advice at all reproduces today's behaviour exactly.
        state = CoreState{};
        Solver::SolveResult baseline{};
        Solver::Solve(in, 1.f, goal, route, state, baseline);
        Check(!baseline.timedEscape, "an absent advice never reports a timed escape");
        Solver::TimedAdvice stale{};     // valid=false
        state = CoreState{};
        Solver::Solve(in, 1.f, goal, route, state, result, stale);
        Check(!result.timedEscape && result.kind == baseline.kind &&
              Len(Sub(result.target, baseline.target)) < 1e-5f,
              "an invalid advice leaves the solve unchanged");
    }

    // ── Planner input construction ───────────────────────────────────────────
    // The planner must agree with UDodge's own temporal constants, must model
    // the player as standing still (UDodge owns movement outright), and must not
    // invent timed zones UDodge's map cannot supply.
    {
        static DangerMap empty{};
        MapInput world{};
        world.map = &empty;
        world.speed = 0.005f;
        world.player = {3.f, -2.f};
        SpacetimeDodge::Input in{};
        Timed::BuildInput(world, 1000.0, 16.7f, Timed::Budget{}, in);
        Check(in.nominal.x == 0.f && in.nominal.y == 0.f, "the planner models the player as standing still");
        Check(in.settings.horizonMs == Core::Temporal::kHorizonMs, "planner horizon matches the temporal horizon");
        Check(in.settings.dwellMs == kUDwellMs, "planner dwell matches the solver dwell");
        Check(in.zoneCount == 0, "no timed zones are invented from an untimed map");
        Check(in.settings.lookRange >= kUTemporalCullTiles, "planner look range covers the temporal cull radius");

        // End to end on an empty map: standing still is safe, so there is nothing
        // to advise and the solver keeps its own hold.
        SpacetimeDodge::State state{};
        SpacetimeDodge::Output out{};
        SpacetimeDodge::Evaluate(in, state, out);
        Check(out.status == SpacetimeDodge::Status::Clear, "an empty map leaves the stand clear");
        Check(!Timed::ToAdvice(out, world.player, 1.f).valid, "a clear stand produces no advice");
    }

    // ── Output → advice ──────────────────────────────────────────────────────
    {
        const Vec2 player{};
        SpacetimeDodge::Output out{};

        // A moving plan advises the position it reaches one server tick ahead.
        out.status = SpacetimeDodge::Status::Moving;
        out.plan.count = 2;
        out.plan.points[0] = {{0.f, 0.f}, 0.f};
        out.plan.points[1] = {{0.f, 2.f}, 400.f};
        auto advice = Timed::ToAdvice(out, player, 1.f);
        Check(advice.valid && advice.moves && !advice.waiting, "a moving plan advises a step");
        Check(std::fabs(advice.stepTarget.y - 1.f) < 1e-4f && std::fabs(advice.stepTarget.x) < 1e-4f,
              "the advised step is the plan position one server tick ahead");

        // A plan that has not departed yet advises a wait, not a nudge.
        out.status = SpacetimeDodge::Status::Waiting;
        out.plan.points[1] = {{0.f, 2.f}, 4000.f};   // 200 ms in reaches 0.1 tiles
        advice = Timed::ToAdvice(out, player, 1.f);
        Check(advice.valid && advice.waiting && !advice.moves, "an undeparted plan advises a wait");

        // Statuses that are not a certified route never advise anything.
        for (auto status : {SpacetimeDodge::Status::NoPlan, SpacetimeDodge::Status::Incomplete,
                            SpacetimeDodge::Status::Locked, SpacetimeDodge::Status::Recovery}) {
            out.status = status;
            Check(!Timed::ToAdvice(out, player, 1.f).valid, "an uncertified planner status produces no advice");
        }

        // A plan with no usable geometry cannot advise a step.
        out.status = SpacetimeDodge::Status::Moving;
        out.plan.count = 0;
        Check(!Timed::ToAdvice(out, player, 1.f).valid, "an empty plan produces no advice");
    }

    std::printf("Timed-escape tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
