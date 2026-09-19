// UDodge decision telemetry (Tactician Slice 1, Part B): the pure half.
//
// What is tested here: the line carries every field; a line is written on a decision
// change and as a heartbeat; the rate limits hold per class of change and report what
// they dropped; the replan and reversal flags; the heartbeat's window totals; writing
// allocates nothing; a buffer too small for the line is truncated, not overrun.
//
// OFF is a branch in UDodge::Tick (`if (diagOn)`), not code in this header, so it is
// tested where it lives: `run_scenarios.py --telemetry-check` runs the production
// Tick in the scenario harness with diagnostics off and on.
//
// What cannot be tested on a host: that the sample is filled correctly from a live
// game, and what the log costs on the game thread while it is ON.
#include "UDodgeTelemetry.h"

#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <vector>

using namespace UDodge;
namespace T = UDodge::Telemetry;

// Every operator-new in the process is counted: the telemetry must never allocate.
static long g_allocations = 0;
void* operator new(std::size_t n) { ++g_allocations; if (void* p = std::malloc(n ? n : 1)) return p; throw std::bad_alloc(); }
void* operator new[](std::size_t n) { ++g_allocations; if (void* p = std::malloc(n ? n : 1)) return p; throw std::bad_alloc(); }
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

static int checks = 0, failures = 0;
static void Check(bool ok, const char* name)
{
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); }
}

static int g_sinkCalls = 0;
static char g_lastLine[T::kLineCap] = {};
static void Sink(const char* line)
{
    ++g_sinkCalls;
    std::snprintf(g_lastLine, sizeof(g_lastLine), "%s", line);
}
static bool Has(const char* line, const char* token) { return std::strstr(line, token) != nullptr; }

// A locked boss 10 tiles east of the player, approached through the walk-to pipeline.
static T::Sample Approach(uint64_t nowMs)
{
    T::Sample s{};
    s.nowMs = nowMs;
    s.dodgeMode = 7;
    s.ruleGame = true;
    s.navigatorDstar = true;
    s.corridorState = 0;
    s.objective = T::Objective::LockApproach;
    s.targetId = 901;
    s.hasTarget = true;
    s.player = { 6.5f, 0.5f };
    s.target = { 16.5f, 0.5f };
    s.ringInner = 2.45f; s.ringOuter = 6.25f;
    s.goalActive = true; s.goal = { 9.9f, 0.5f };
    s.navRoute = T::NavRoute::Cached; s.navWpts = 7;
    s.plan = T::Plan::StartIsGoal;
    s.solve = T::Solve::Solver;
    s.source = T::Source::Worker;
    s.drive = T::Drive::Ok;
    s.clearance = 0.42f;
    s.commanded = { -0.1f, 0.f };   // straight away from the boss
    s.lanes = 48; s.enemies = 1;
    s.workerDodgeMs = 0.02f; s.workerNavMs = 0.f; s.workerTimedMs = 1.1f; s.workerSolveMs = 0.19f;
    s.timedStatus = 1; s.timedReused = true;
    return s;
}

static size_t StepLine(T::State& state, const T::Sample& s, std::string& line)
{
    char buf[T::kLineCap];
    const size_t n = T::Step(state, s, buf, sizeof(buf));
    line.assign(buf, n);
    return n;
}

int main()
{
    std::string line;

    // ── First line: every field, and no allocation ───────────────────────────
    {
        T::State state{};
        g_sinkCalls = 0;
        const long before = g_allocations;
        T::Emit(state, Approach(100000), &Sink);
        for (int i = 1; i <= 600; ++i) {            // ten more seconds of steady frames
            T::Sample s = Approach(100000 + i * 16);
            s.solve = (i & 1) ? T::Solve::Hold : T::Solve::Solver;
            T::Emit(state, s, &Sink);
        }
        T::Idle(state, 200000, "projectile_source_unavailable", &Sink);
        Check(g_allocations == before, "sampling, stepping and writing lines allocates nothing");
        Check(g_sinkCalls > 10, "lines were written while counting allocations");

        T::State fresh{};
        g_sinkCalls = 0;
        T::Emit(fresh, Approach(100000), &Sink);
        Check(g_sinkCalls == 1, "the first sample writes one line");
        T::Emit(fresh, Approach(100016), nullptr);
        Check(g_sinkCalls == 1, "no sink, no write, no crash");
        const char* l = g_lastLine;
        Check(std::strncmp(l, "[Diag/Nav] t=100000 why=first ", 30) == 0, "line starts with tag, time and reason");
        Check(Has(l, " mode=unified rule=game nav=dstar corridor=idle map_pending=0 assist=0 "),
              "mode, collision rule, navigator and map-capture state");
        Check(Has(l, " obj=lock_approach target=901 at=(16.50,0.50) dist=10.00 bearing=0 ring=[2.45,6.25] "),
              "objective source, target id, distance, bearing and engagement ring");
        Check(Has(l, " player=(6.50,0.50) goal=(9.90,0.50) navroute=cached wpts=7 partial=0 "),
              "player, steering goal and walk-to follower state");
        Check(Has(l, " plan=start_is_goal solve=solver src=worker drive=ok clr=0.42 "),
              "plan class, step source, decider and drive result");
        Check(Has(l, " cmd=0.100 radial=+1.00 tang=+0.00 "), "a step straight away from the target is radial +1");
        Check(Has(l, " replan=0 reversal=0 lanes=48 zones=0 enemies=1 "), "flags and live threats");
        Check(Has(l, " worker_ms=1.31(dodge=0.02 nav=0.00 timed=1.10 solve=0.19) timed=waiting reused=1 budget_hit=0 "),
              "worker cycle ms and the temporal planner's outcome");
        Check(Has(l, " dropped=0") && !Has(l, "win{"), "a change line carries no window");
    }

    // ── Bearing and the tangential sign ──────────────────────────────────────
    {
        T::State state{};
        T::Sample s = Approach(1000);
        s.target = { 6.5f, 10.5f };          // due +y of the player
        s.commanded = { 0.1f, 0.f };         // +x: counter-clockwise? away = (0,-1); cross(away, +x) = +1
        StepLine(state, s, line);
        Check(Has(line.c_str(), " bearing=90 "), "a target due +y is at bearing 90");
        Check(Has(line.c_str(), " radial=+0.00 tang=+1.00 "), "a step across the line to the target is tangential");
        s.target = { 16.5f, 0.45f };         // a hair clockwise of due +x: 359.7 degrees
        T::State wrap{};
        StepLine(wrap, s, line);
        Check(Has(line.c_str(), " bearing=0 "), "a bearing that rounds up to 360 prints as 0");
        s.target = { 6.5f, 10.5f };
        s.commanded = { 0.f, 0.1f };         // toward the target
        T::State other{};
        StepLine(other, s, line);
        Check(Has(line.c_str(), " radial=-1.00 "), "a step toward the target is radial -1");

        T::State none{};
        T::Sample idle{};
        idle.nowMs = 1000; idle.dodgeMode = 7; idle.clearance = 1e9f;
        StepLine(none, idle, line);
        Check(Has(line.c_str(), " obj=none target=0 at=- dist=- bearing=- ring=- ") &&
              Has(line.c_str(), " goal=- ") && Has(line.c_str(), " radial=- tang=- ") && Has(line.c_str(), " clr=inf "),
              "no objective: target, ring, goal, components and a huge clearance print as absent");
    }

    // ── Nothing changes: silence until the heartbeat, then once a second ─────
    {
        T::State state{};
        int lines = 0, heartbeats = 0;
        std::string last;
        for (int frame = 0; frame < 300; ++frame) {   // 5 s at 60 FPS
            const T::Sample s = Approach(100000 + static_cast<uint64_t>(frame * 1000.0 / 60.0));
            if (StepLine(state, s, line)) {
                ++lines;
                last = line;
                if (Has(line.c_str(), "why=heartbeat ")) ++heartbeats;
            }
        }
        Check(lines == 5 && heartbeats == 4, "a steady objective writes the first line and one heartbeat per second");
        Check(Has(last.c_str(), " win{frames=60 moved=6.00 out=6.00 in=0.00 tang=0.00 holds=0 vetoes=0 reversals=0"
                                " replans=0 changes=0}"),
              "the heartbeat totals the second it covers");

        T::State quiet{};
        lines = 0;
        T::Sample idle{};
        for (int frame = 0; frame < 300; ++frame) {
            idle.nowMs = 100000 + static_cast<uint64_t>(frame * 1000.0 / 60.0);
            if (StepLine(quiet, idle, line)) ++lines;
        }
        Check(lines == 1, "with no objective there is no heartbeat");
        // The beat starts when the objective does, not at some phase of the idle time.
        T::Sample s = Approach(idle.nowMs + 17);
        Check(StepLine(quiet, s, line) && Has(line.c_str(), "why=objective,target,"), "an objective starting is a change line");
        s.nowMs += 900;
        Check(StepLine(quiet, s, line) == 0, "no heartbeat before the objective is a second old");
        s.nowMs += 100;
        Check(StepLine(quiet, s, line) && Has(line.c_str(), "why=heartbeat "), "heartbeat one second into the objective");
    }

    // ── Decision changes, one class at a time ────────────────────────────────
    {
        T::State state{};
        T::Sample s = Approach(100000);
        StepLine(state, s, line);
        const auto changed = [&](const char* why) {
            s.nowMs += 1100;   // past every rate-limit window; heartbeats also fire, so look at `why`
            return StepLine(state, s, line) && Has(line.c_str(), why);
        };
        s.objective = T::Objective::Lock;                 Check(changed("why=objective"), "objective source change");
        s.targetId = 902;                                 Check(changed("why=target"), "target change");
        s.mapPending = true;                              Check(changed("why=nav") && Has(line.c_str(), "map_pending=1"), "map capture pending");
        s.mapPending = false; s.corridorState = 4;        Check(changed("why=nav") && Has(line.c_str(), "corridor=partial"), "router state change");
        s.navRoute = T::NavRoute::Waiting;                Check(changed("why=route") && Has(line.c_str(), "navroute=waiting"), "walk-to follower waiting");
        s.plan = T::Plan::TemporalGoal;                   Check(changed("why=plan") && Has(line.c_str(), "plan=temporal_goal"), "plan class change");
        s.solve = T::Solve::Hold; s.commanded = {};       Check(changed("why=solve") && Has(line.c_str(), "solve=hold"), "step source change");
        s.drive = T::Drive::BlockedPath;                  Check(changed("why=drive") && Has(line.c_str(), "drive=blocked_path"), "drive result change");
        s.source = T::Source::ReflexVeto;                 Check(changed("veto") && Has(line.c_str(), "src=reflex_veto"), "a reflex veto is an event");
        // A ring plan is visible (Tactician Slice 2): the snapshot asking for a ring, the
        // route into it on a shot-free cell or on the time-aware goal, and the step taken from it.
        Check(Has(line.c_str(), " ring_approach=0 "), "every line says whether a ring approach is being published");
        s.ringApproach = true;                            Check(changed("why=plan") && Has(line.c_str(), " ring_approach=1 "), "publishing a ring approach is a plan change");
        s.plan = T::Plan::RingTemporal;                   Check(changed("why=plan") && Has(line.c_str(), " plan=ring_temporal "), "an in-ring route on the time-aware goal has its own plan value");
        s.plan = T::Plan::RingRoute;                      Check(changed("why=plan") && Has(line.c_str(), " plan=ring_route "), "an in-ring route on a shot-free cell has its own plan value");
        s.solve = T::Solve::RingRoute; s.commanded = { -0.1f, 0.f };
        Check(changed("why=solve") && Has(line.c_str(), " solve=ring_route "), "a step taken from the ring route is not reported as a walk-to corridor step");
    }

    // ── Rate limits: per class, and what was dropped is reported ─────────────
    {
        T::State state{};
        T::Sample s = Approach(100000);
        StepLine(state, s, line);
        // The solver flaps every frame for half a second: the step class gets its
        // one line a second, the rest are counted, not written.
        int written = 0;
        for (int frame = 1; frame <= 30; ++frame) {
            s.nowMs = 100000 + frame * 16;
            s.solve = (frame & 1) ? T::Solve::Hold : T::Solve::Solver;
            if (StepLine(state, s, line)) ++written;
        }
        Check(written == T::kStepLinesPerSec, "a flapping solver is held to the step-class rate");
        // An objective change in the same second is not starved by it...
        s.nowMs += 16; s.objective = T::Objective::Lock;
        Check(StepLine(state, s, line) && Has(line.c_str(), "why=objective"), "an objective change gets through a saturated step class");
        // ...and says how many change lines were suppressed before it.
        Check(Has(line.c_str(), " dropped=29"), "the next line reports the suppressed count");
        s.nowMs += 16; s.plan = T::Plan::Route;
        Check(StepLine(state, s, line) && Has(line.c_str(), " dropped=0"), "the suppressed count resets once reported");

        // Each class has its own ceiling.
        T::State planState{};
        T::Sample p = Approach(200000);
        StepLine(planState, p, line);
        written = 0;
        for (int frame = 1; frame <= 40; ++frame) {
            p.nowMs = 200000 + frame * 16;
            p.plan = (frame & 1) ? T::Plan::Route : T::Plan::StartIsGoal;
            if (StepLine(planState, p, line)) ++written;
        }
        Check(written == T::kPlanLinesPerSec, "a flapping plan class is held to the plan-class rate");
        // Nothing the limiter drops is lost from the heartbeat's totals.
        p.nowMs = 201000;
        Check(StepLine(planState, p, line) && Has(line.c_str(), "why=heartbeat") && Has(line.c_str(), " changes=40}"),
              "the heartbeat counts every change, written or not");
    }

    // ── Replan flag ──────────────────────────────────────────────────────────
    {
        T::State state{};
        T::Sample s = Approach(100000);
        s.plan = T::Plan::Route; s.planGoalValid = true; s.planGoal = { 7.25f, -1.75f };
        StepLine(state, s, line);
        Check(Has(line.c_str(), " replan=0 ") && Has(line.c_str(), " plan_goal=(7.25,-1.75) "), "the first committed goal is a plan, not a replan");
        s.nowMs += 16; s.planGoal = { 7.30f, -1.70f };
        Check(StepLine(state, s, line) == 0, "the same goal cell is not a replan");
        s.nowMs += 16; s.planGoal = { 8.25f, -1.75f };
        Check(StepLine(state, s, line) && Has(line.c_str(), "why=replan ") && Has(line.c_str(), " replan=1 "),
              "the goal moving to another cell is a replan");
        s.nowMs += 16; s.navRouteDelivered = true;
        Check(StepLine(state, s, line) == 0, "the first delivered walk-to route is a plan");
        s.nowMs += 16;
        Check(StepLine(state, s, line) && Has(line.c_str(), " replan=1 "), "a replaced walk-to route is a replan");
        s.nowMs += 16; s.targetId = 777; s.planGoal = { 20.f, 20.f };
        Check(StepLine(state, s, line) && Has(line.c_str(), " replan=0 "), "a new target's first goal and route are plans again");
    }

    // ── Heading reversal flag and the window's radial split ──────────────────
    {
        T::State state{};
        T::Sample s = Approach(100000);
        s.commanded = { 0.1f, 0.f };            // toward the boss
        StepLine(state, s, line);
        s.nowMs += 16; s.commanded = { 0.f, 0.1f };   // 90 degrees: not a reversal
        Check(StepLine(state, s, line) == 0, "a right-angle turn is not a reversal");
        s.nowMs += 16; s.commanded = { 0.f, 0.f };    // a hold keeps the last heading
        StepLine(state, s, line);
        s.nowMs += 16; s.commanded = { 0.f, -0.1f };
        Check(StepLine(state, s, line) && Has(line.c_str(), "why=reversal ") && Has(line.c_str(), " reversal=1 "),
              "a step more than 90 degrees off the last moving step is a reversal");
        s.nowMs = 101000; s.commanded = { -0.1f, 0.f };   // away from the boss
        StepLine(state, s, line);
        Check(Has(line.c_str(), "why=heartbeat") &&
              Has(line.c_str(), " win{frames=5 moved=0.40 out=0.10 in=0.10 tang=0.20 holds=1 vetoes=0 reversals=1"),
              "the window splits movement into radial out, radial in and tangential");
    }

    // ── Gaps and idle frames ─────────────────────────────────────────────────
    {
        T::State state{};
        T::Sample s = Approach(100000);
        StepLine(state, s, line);
        s.nowMs += T::kStateExpiryMs + 1;
        Check(StepLine(state, s, line) && Has(line.c_str(), "why=first "), "after a gap in sampling the state starts over");

        g_sinkCalls = 0;
        T::State idleState{};
        for (uint64_t t = 50000; t < 53000; t += 16)
            T::Idle(idleState, t, "projectile_source_unavailable", &Sink);
        Check(g_sinkCalls == 3, "an idle frame's reason is written once a second");
        Check(std::strcmp(g_lastLine, "[Diag/Nav] t=52016 why=idle reason=projectile_source_unavailable") == 0,
              "the idle line carries its time and reason");
    }

    // ── A short buffer truncates; it never overruns ──────────────────────────
    {
        T::State state{};
        char small[64];
        std::memset(small, 0x7f, sizeof(small));
        const size_t n = T::Step(state, Approach(100000), small, 48);
        Check(n == 47 && small[47] == '\0' && small[48] == 0x7f, "the line stops at the buffer's end, terminated");
        T::State again{};
        Check(T::Step(again, Approach(100000), nullptr, 0) == 0, "no buffer, no line, no crash");
    }

    std::printf("Telemetry tests: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
