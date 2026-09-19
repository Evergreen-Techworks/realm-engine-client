#pragma once
// UDodge decision telemetry: WHY the bot stood where it stood and WHY it moved.
//
// OFF by default. It rides the existing field-diagnostics switch (DiagTiming::On():
// the RE_ASSETS\diag-timing.flag file, or the developer "Diag timing" checkbox) and
// adds no switch, no saved setting and no overlay patch of its own. UDodge::Tick
// wraps everything below in `if (diagOn) { ... }`, the flag it already tests for its
// phase timers: off, that is one predictable branch, and nothing is sampled,
// formatted, allocated or written. (The branch is written out at the call site on
// purpose. Handing a capturing lambda to a gated helper looks the same, but MSVC
// builds the closure - one store per captured local - before it tests the flag.)
//
// When ON, one "[Diag/Nav]" line is written through the caller's sink (the ungated
// DbgFileLogWrite, so RE_ASSETS\native-trace.log in a portable):
//   - on every DECISION CHANGE, rate-limited per class of change so a flapping
//     solver cannot starve an objective change or flood the log, and
//   - as a HEARTBEAT about once a second while an objective is active, carrying
//     what happened since the last heartbeat (win{...}), so nothing the rate limit
//     dropped is lost from the totals.
//
// Everything here is plain data and pure functions of (State, Sample): no IL2CPP, no
// clock, no I/O. The caller fills a Sample from what Tick already computed and hands
// in the time; the host tests drive Step() directly.
//
// Line fields, in order:
//   t             caller's millisecond clock (GetTickCount64)
//   why           what changed: first | objective | target | nav | route | plan |
//                 replan | solve | drive | reversal | veto | heartbeat (comma list)
//   mode          dodge mode (unified = UDodge; the line is only written by UDodge)
//   rule          navCollisionRule: legacy | game
//   nav           navNavigator: legacy | dstar;  corridor = the global router's state
//                 (idle | repairing | ready | arrived | partial | unreachable),
//                 map_pending = the map capture is not ready, so the router cannot
//                 answer yet; assist = the global corridor is steering the walk-to
//   obj           objective source: lock (in the engagement ring's hand-off range,
//                 orbiting) | lock_approach (locked target out of range, routed
//                 through the walk-to pipeline) | walk_to (script, Shift+Click or
//                 minimap: one native walk goal, the writer is not recorded) |
//                 follow | steer (WASD) | none
//   target        object id (lock / follow), 0 otherwise;  at = target position
//   dist bearing  player to target: tiles, and degrees with 0 = +x, 90 = +y
//   ring          engagement ring [inner, outer] around a locked target, tiles
//   goal          what the solver is steering at this frame
//   navroute      walk-to follower: none | direct (straight, sweep is clear) |
//                 cached (following the A* route: wpts, partial) | waiting (no
//                 route yet; the player holds until the worker answers)
//   plan          the dodge pathfinder's last accepted answer: none |
//                 start_is_goal (the stand already is a durable pocket, nothing
//                 routed) | route | partial | temporal_goal | stale (too old to use)
//                 | ring_route (a route to a shot-free cell inside the lock target's
//                 ring) | ring_temporal (a route to an in-ring cell that is clear on
//                 arrival and for the dwell after it)
//   ring_approach 1 while the published snapshot asks the pathfinder to plan into the
//                 lock target's ring during a lock approach (PlannerSnapshot::ringApproach)
//   solve         what picked this frame's step: hold | timed_wait | surrounded |
//                 nav_route (walk-to corridor step) | dodge_route (step along the
//                 dodge route) | lateral (pre-position sidestep) | timed (temporal
//                 planner advice) | solver (reflex pick among safe cells) | fallback
//                 | ring_route (the walk-to step was aimed at the ring route's step
//                 target instead of the corridor's)
//   src           who decided: worker (accepted this frame) | live (game-thread
//                 solve) | reflex_veto (this frame's map invalidated the standing
//                 decision and the game thread re-solved) | cached (earlier frame)
//   drive         ok | none (no step wanted) | blocked_enemy | blocked_path |
//                 refused (the game's MoveTo returned false);  clr = the solver's
//                 clearance at its target, tiles (inf: no threat anywhere near)
//   cmd radial tang   commanded step this frame (tiles) and its unit components
//                 relative to the target: radial + is AWAY from the target,
//                 tang + is counter-clockwise in world axes; "-" with no target
//   replan        the committed dodge goal moved to another cell, or a walk-to
//                 route was replaced (the first of either is a plan, not a replan)
//   reversal      this step points more than 90 degrees off the previous step
//   lanes zones enemies   live threats in the danger map
//   worker_ms     the latest worker cycle handed to the game thread: the sum of its
//                 four timed phases (dodge nav timed solve), then the temporal
//                 planner's outcome: status, plan kept from an earlier cycle, budget hit
//   win{...}      heartbeat only: frames, tiles moved, of which radially out / in /
//                 tangential (target-relative), hold frames, vetoes, reversals,
//                 replans, decision changes since the last heartbeat
//   dropped       change lines the rate limit suppressed since the last line
#include "UDodgeTypes.h"

#include <cmath>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace UDodge { namespace Telemetry {

enum class Objective : uint8_t { None, Steer, WalkTo, Follow, LockApproach, Lock };
enum class NavRoute  : uint8_t { None, Direct, Cached, Waiting };
enum class Plan      : uint8_t { None, StartIsGoal, Route, Partial, TemporalGoal, Stale, RingRoute, RingTemporal };
enum class Solve     : uint8_t { Hold, TimedWait, Surrounded, NavRoute, DodgeRoute, Lateral, Timed, Solver, Fallback, RingRoute };
enum class Source    : uint8_t { Cached, Worker, Live, ReflexVeto };
enum class Drive     : uint8_t { None, Ok, BlockedEnemy, BlockedPath, Refused };
// Item 1 S2/S4 (navigation finish plan): why the walk-to / lock-approach route
// follower re-planned this tick, or None on a frame that kept following the
// committed route. The four triggers the plan names (Invalidated, Objective-
// Changed, Arrival, NoProgress) plus two pre-existing hard-safety triggers
// (GoalMoved: the lock-approach goal itself moved; Blocked: a fresh occupancy/
// keep-out read invalidated the route immediately, not by distance).
enum class ReplanReason : uint8_t {
    None, Invalidated, ObjectiveChanged, Arrival, NoProgress, GoalMoved, Blocked
};

// One frame of UDodge::Tick, as plain data. Filled only while telemetry is on.
struct Sample {
    uint64_t nowMs = 0;
    // Configuration.
    int      dodgeMode = 0;          // TestTAB::DodgeMode
    bool     ruleGame = false;       // navCollisionRule == game
    bool     navigatorDstar = false; // navNavigator == dstar
    uint8_t  corridorState = 0;      // Movement::Nav::RouteState
    bool     mapPending = false;     // RouteCorridor::capturePending
    bool     globalAssist = false;
    // Objective.
    Objective objective = Objective::None;
    int32_t  targetId = 0;
    bool     hasTarget = false;
    Vec2     player{}, target{};
    float    ringInner = 0.f, ringOuter = 0.f;   // 0,0 = no ring (no lock)
    bool     goalActive = false;
    Vec2     goal{};
    // Walk-to follower.
    NavRoute navRoute = NavRoute::None;
    int      navWpts = 0;
    bool     navPartial = false;
    bool     navRouteDelivered = false;   // the worker's nav route replaced the cache this frame
    // Item 1 S4 (navigation finish plan): route commitment. routeId is 0 while no
    // walk-to/lock-approach route is committed and bumps each time a genuinely
    // new one replaces it — stable across ticks that just follow it. rejoin is
    // true on a frame that steered by a detour-then-rejoin point on the
    // committed route (Navigation::Follow found the route reachable well past
    // the old deviation threshold) rather than re-planning. replanReason is why
    // navRouteDelivered/planGoal changed this tick, or None otherwise.
    uint64_t     routeId = 0;
    bool         rejoin = false;
    ReplanReason replanReason = ReplanReason::None;
    // Dodge pathfinder and solver.
    bool     ringApproach = false;   // the snapshot being published asks for a ring approach (PlannerSnapshot::ringApproach)
    Plan     plan = Plan::None;
    bool     planGoalValid = false;  // a committed dodge goal cell exists (g_route.found)
    Vec2     planGoal{};
    Solve    solve = Solve::Hold;
    Source   source = Source::Cached;
    Drive    drive = Drive::None;
    float    clearance = 0.f;
    Vec2     commanded{};            // this frame's MoveTo target minus the player
    // World.
    int      lanes = 0, zones = 0, enemies = 0;
    // ENEMY STANDOFF: distance to the nearest live enemy body, and whether the
    // player is standing inside anybody's band right now. These are the two
    // numbers the owner's 152-hit analysis turned on (54 % of hits had an enemy
    // inside 4 tiles), so a session's log can be scored the same way.
    float    nearEnemy = -1.f;   // tiles; < 0 = no enemy in the map
    bool     inBand = false;
    // The latest worker cycle handed to the game thread.
    float    workerDodgeMs = 0.f, workerNavMs = 0.f, workerTimedMs = 0.f, workerSolveMs = 0.f;
    uint8_t  timedStatus = 0;        // SpacetimeDodge::Status
    bool     timedReused = false, timedBudgetHit = false;
    // The player's own tile this frame is a damaging one (WorldTAB::GetTileDamageLive
    // > 0). Carried on the heartbeat only ([Diag/Ground] has the per-transition detail).
    bool     onHazard = false;
};

inline constexpr uint64_t kHeartbeatMs = 1000;
inline constexpr uint64_t kStateExpiryMs = 2000;   // no sample for this long: start over
inline constexpr size_t   kLineCap = 1024;
// Change lines allowed per second, by the most important thing that changed.
inline constexpr uint16_t kObjectiveLinesPerSec = 8;   // first / objective / target / nav
inline constexpr uint16_t kPlanLinesPerSec      = 3;   // route / plan / replan
inline constexpr uint16_t kStepLinesPerSec      = 1;   // solve / drive / reversal / veto

enum Why : uint32_t {
    kWhyFirst = 1u << 0, kWhyObjective = 1u << 1, kWhyTarget = 1u << 2, kWhyNav = 1u << 3,
    kWhyRoute = 1u << 4, kWhyPlan = 1u << 5, kWhyReplan = 1u << 6,
    kWhySolve = 1u << 7, kWhyDrive = 1u << 8, kWhyReversal = 1u << 9, kWhyVeto = 1u << 10,
    kWhyHeartbeat = 1u << 11,
    kWhyObjectiveClass = kWhyFirst | kWhyObjective | kWhyTarget | kWhyNav,
    kWhyPlanClass = kWhyRoute | kWhyPlan | kWhyReplan,
    kWhyStepClass = kWhySolve | kWhyDrive | kWhyReversal | kWhyVeto,
};

struct Bucket { uint64_t windowStartMs = 0; uint16_t used = 0; };

struct Window {   // since the last heartbeat
    uint32_t frames = 0, holdFrames = 0, vetoes = 0, reversals = 0, replans = 0, changes = 0;
    float    moved = 0.f, radialOut = 0.f, radialIn = 0.f, tangential = 0.f;
};

// Game-thread only. Plain data: `State{}` is the reset.
struct State {
    bool     seen = false;
    uint64_t lastSampleMs = 0, lastHeartbeatMs = 0;
    // The decision key of the previous frame.
    Objective objective = Objective::None;
    int32_t  targetId = 0;
    bool     navigatorDstar = false, mapPending = false, globalAssist = false, ruleGame = false;
    uint8_t  corridorState = 0;
    NavRoute navRoute = NavRoute::None;
    Plan     plan = Plan::None;
    bool     ringApproach = false;
    Solve    solve = Solve::Hold;
    Drive    drive = Drive::None;
    // Replan and reversal memory.
    bool     goalSeen = false;   Vec2 goalCell{};
    bool     navRouteSeen = false;
    bool     headingSeen = false; Vec2 heading{};
    Bucket   objectiveLines{}, planLines{}, stepLines{};
    uint32_t dropped = 0;
    Window   window{};
};

inline const char* Name(Objective v)
{
    switch (v) {
        case Objective::None: return "none";            case Objective::Steer: return "steer";
        case Objective::WalkTo: return "walk_to";        case Objective::Follow: return "follow";
        case Objective::LockApproach: return "lock_approach"; case Objective::Lock: return "lock";
    }
    return "?";
}
inline const char* Name(NavRoute v)
{
    switch (v) {
        case NavRoute::None: return "none";     case NavRoute::Direct: return "direct";
        case NavRoute::Cached: return "cached"; case NavRoute::Waiting: return "waiting";
    }
    return "?";
}
inline const char* Name(Plan v)
{
    switch (v) {
        case Plan::None: return "none";       case Plan::StartIsGoal: return "start_is_goal";
        case Plan::Route: return "route";     case Plan::Partial: return "partial";
        case Plan::TemporalGoal: return "temporal_goal"; case Plan::Stale: return "stale";
        case Plan::RingRoute: return "ring_route";       case Plan::RingTemporal: return "ring_temporal";
    }
    return "?";
}
inline const char* Name(Solve v)
{
    switch (v) {
        case Solve::Hold: return "hold";            case Solve::TimedWait: return "timed_wait";
        case Solve::Surrounded: return "surrounded"; case Solve::NavRoute: return "nav_route";
        case Solve::DodgeRoute: return "dodge_route"; case Solve::Lateral: return "lateral";
        case Solve::Timed: return "timed";          case Solve::Solver: return "solver";
        case Solve::Fallback: return "fallback";       case Solve::RingRoute: return "ring_route";
    }
    return "?";
}
inline const char* Name(Source v)
{
    switch (v) {
        case Source::Cached: return "cached"; case Source::Worker: return "worker";
        case Source::Live: return "live";     case Source::ReflexVeto: return "reflex_veto";
    }
    return "?";
}
inline const char* Name(Drive v)
{
    switch (v) {
        case Drive::None: return "none"; case Drive::Ok: return "ok";
        case Drive::BlockedEnemy: return "blocked_enemy"; case Drive::BlockedPath: return "blocked_path";
        case Drive::Refused: return "refused";
    }
    return "?";
}
inline const char* Name(ReplanReason v)
{
    switch (v) {
        case ReplanReason::None: return "none"; case ReplanReason::Invalidated: return "invalidated";
        case ReplanReason::ObjectiveChanged: return "objective_changed"; case ReplanReason::Arrival: return "arrival";
        case ReplanReason::NoProgress: return "no_progress"; case ReplanReason::GoalMoved: return "goal_moved";
        case ReplanReason::Blocked: return "blocked";
    }
    return "?";
}
inline const char* DodgeModeName(int mode)
{
    static const char* const names[] = { "off", "xdodge", "rollout_grid", "rollout_quad",
                                         "zdodge", "repp", "pjdodge", "unified" };
    return mode >= 0 && mode < 8 ? names[mode] : "?";
}
inline const char* CorridorStateName(uint8_t state)
{
    static const char* const names[] = { "idle", "repairing", "ready", "arrived", "partial", "unreachable" };
    return state < 6 ? names[state] : "?";
}
inline const char* TimedStatusName(uint8_t status)
{
    static const char* const names[] = { "clear", "waiting", "moving", "recovery", "no_plan", "incomplete", "locked" };
    return status < 7 ? names[status] : "?";
}

// Bounded appender over the caller's buffer. Truncates; never overruns.
struct Writer {
    char*  out;
    size_t cap;
    size_t len = 0;
    void Add(const char* fmt, ...)
    {
        if (!out || len + 1 >= cap) return;
        va_list ap;
        va_start(ap, fmt);
        const int n = std::vsnprintf(out + len, cap - len, fmt, ap);
        va_end(ap);
        if (n > 0) len = (static_cast<size_t>(n) >= cap - len) ? cap - 1 : len + static_cast<size_t>(n);
    }
};

inline bool Take(Bucket& bucket, uint64_t nowMs, uint16_t perSecond)
{
    if (nowMs - bucket.windowStartMs >= 1000) { bucket.windowStartMs = nowMs; bucket.used = 0; }
    if (bucket.used >= perSecond) return false;
    ++bucket.used;
    return true;
}

// Same cell as the dodge pathfinder means by it: within half a path cell on both axes.
inline bool SameGoalCell(Vec2 a, Vec2 b)
{
    return std::fabs(a.x - b.x) <= kUPathCellTiles * 0.5f && std::fabs(a.y - b.y) <= kUPathCellTiles * 0.5f;
}

// The commanded step relative to the target. radial: + away from it. tangential: +
// counter-clockwise in world axes. Both are unit components (they square-sum to 1).
inline bool StepComponents(const Sample& s, float& length, float& radial, float& tangential)
{
    length = Len(s.commanded);
    radial = tangential = 0.f;
    if (!s.hasTarget || length <= 1e-4f) return false;
    const Vec2 away = Sub(s.player, s.target);
    const float d = Len(away);
    if (d <= 1e-4f) return false;
    const Vec2 u = Mul(away, 1.f / d), c = Mul(s.commanded, 1.f / length);
    radial = Dot(c, u);
    tangential = u.x * c.y - u.y * c.x;
    return true;
}

inline void WriteWhy(Writer& w, uint32_t why)
{
    static const struct { uint32_t bit; const char* name; } names[] = {
        { kWhyFirst, "first" }, { kWhyObjective, "objective" }, { kWhyTarget, "target" }, { kWhyNav, "nav" },
        { kWhyRoute, "route" }, { kWhyPlan, "plan" }, { kWhyReplan, "replan" }, { kWhySolve, "solve" },
        { kWhyDrive, "drive" }, { kWhyReversal, "reversal" }, { kWhyVeto, "veto" }, { kWhyHeartbeat, "heartbeat" },
    };
    bool any = false;
    for (const auto& n : names)
        if (why & n.bit) { w.Add("%s%s", any ? "," : "", n.name); any = true; }
    if (!any) w.Add("none");
}

inline size_t Format(const Sample& s, uint32_t why, bool replan, bool reversal, const Window* window,
                     uint32_t dropped, char* out, size_t cap)
{
    Writer w{ out, cap };
    if (out && cap) out[0] = '\0';
    w.Add("[Diag/Nav] t=%llu why=", static_cast<unsigned long long>(s.nowMs));
    WriteWhy(w, why);
    w.Add(" mode=%s rule=%s nav=%s corridor=%s map_pending=%d assist=%d",
          DodgeModeName(s.dodgeMode), s.ruleGame ? "game" : "legacy", s.navigatorDstar ? "dstar" : "legacy",
          CorridorStateName(s.corridorState), s.mapPending ? 1 : 0, s.globalAssist ? 1 : 0);
    w.Add(" obj=%s target=%d", Name(s.objective), s.targetId);
    if (s.hasTarget) {
        const Vec2 to = Sub(s.target, s.player);
        float bearing = std::atan2(to.y, to.x) * (180.f / 3.14159265f);
        if (bearing < 0.f) bearing += 360.f;
        const int degrees = static_cast<int>(std::lround(bearing)) % 360;   // 359.6 is 0, not 360
        w.Add(" at=(%.2f,%.2f) dist=%.2f bearing=%d", s.target.x, s.target.y, Len(to), degrees);
    } else {
        w.Add(" at=- dist=- bearing=-");
    }
    if (s.ringOuter > 0.f) w.Add(" ring=[%.2f,%.2f]", s.ringInner, s.ringOuter);
    else w.Add(" ring=-");
    w.Add(" player=(%.2f,%.2f)", s.player.x, s.player.y);
    if (s.goalActive) w.Add(" goal=(%.2f,%.2f)", s.goal.x, s.goal.y);
    else w.Add(" goal=-");
    w.Add(" navroute=%s wpts=%d partial=%d", Name(s.navRoute), s.navWpts, s.navPartial ? 1 : 0);
    w.Add(" ring_approach=%d plan=%s", s.ringApproach ? 1 : 0, Name(s.plan));
    if (s.planGoalValid) w.Add(" plan_goal=(%.2f,%.2f)", s.planGoal.x, s.planGoal.y);
    w.Add(" solve=%s src=%s drive=%s", Name(s.solve), Name(s.source), Name(s.drive));
    if (s.clearance < 1e8f) w.Add(" clr=%.2f", s.clearance);   // kHugeClearance: nothing near
    else w.Add(" clr=inf");
    float length = 0.f, radial = 0.f, tangential = 0.f;
    if (StepComponents(s, length, radial, tangential))
        w.Add(" cmd=%.3f radial=%+.2f tang=%+.2f", length, radial, tangential);
    else
        w.Add(" cmd=%.3f radial=- tang=-", length);
    w.Add(" replan=%d reversal=%d lanes=%d zones=%d enemies=%d", replan ? 1 : 0, reversal ? 1 : 0,
          s.lanes, s.zones, s.enemies);
    // Item 1 S4: route commitment (route_id stable across follow-only frames;
    // rejoin=1 on a detour that rejoined the route instead of re-planning;
    // replan_reason names why this frame's replan flag above is set).
    w.Add(" route_id=%llu rejoin=%d replan_reason=%s",
          static_cast<unsigned long long>(s.routeId), s.rejoin ? 1 : 0, Name(s.replanReason));
    if (s.nearEnemy >= 0.f) w.Add(" near_enemy=%.2f", s.nearEnemy);
    else                    w.Add(" near_enemy=-");
    w.Add(" in_band=%d", s.inBand ? 1 : 0);
    w.Add(" worker_ms=%.2f(dodge=%.2f nav=%.2f timed=%.2f solve=%.2f) timed=%s reused=%d budget_hit=%d",
          s.workerDodgeMs + s.workerNavMs + s.workerTimedMs + s.workerSolveMs,
          s.workerDodgeMs, s.workerNavMs, s.workerTimedMs, s.workerSolveMs,
          TimedStatusName(s.timedStatus), s.timedReused ? 1 : 0, s.timedBudgetHit ? 1 : 0);
    if (window) {
        w.Add(" win{frames=%u moved=%.2f out=%.2f in=%.2f tang=%.2f holds=%u vetoes=%u reversals=%u"
              " replans=%u changes=%u}",
              window->frames, window->moved, window->radialOut, window->radialIn, window->tangential,
              window->holdFrames, window->vetoes, window->reversals, window->replans, window->changes);
        w.Add(" on_hazard=%d", s.onHazard ? 1 : 0);
    }
    w.Add(" dropped=%u", dropped);
    return w.len;
}

// One frame. Returns the length of the line written to `out`, or 0 when this frame
// produces no line. Pure: everything it knows is in `state` and `s`.
inline size_t Step(State& state, const Sample& s, char* out, size_t cap)
{
    if (state.seen && s.nowMs - state.lastSampleMs > kStateExpiryMs) state = State{};

    uint32_t why = 0;
    if (!state.seen) {
        why |= kWhyFirst;
        state.lastHeartbeatMs = s.nowMs;
    } else {
        if (s.objective != state.objective) why |= kWhyObjective;
        if (s.targetId != state.targetId) why |= kWhyTarget;
        if (s.navigatorDstar != state.navigatorDstar || s.mapPending != state.mapPending ||
            s.globalAssist != state.globalAssist || s.corridorState != state.corridorState ||
            s.ruleGame != state.ruleGame) why |= kWhyNav;
        if (s.navRoute != state.navRoute) why |= kWhyRoute;
        if (s.plan != state.plan || s.ringApproach != state.ringApproach) why |= kWhyPlan;
        if (s.solve != state.solve) why |= kWhySolve;
        if (s.drive != state.drive) why |= kWhyDrive;
    }
    // A new objective's first goal and first route are plans, not replans.
    if (why & (kWhyFirst | kWhyObjective | kWhyTarget)) {
        state.goalSeen = false;
        state.navRouteSeen = false;
    }
    bool replan = false;
    if (s.planGoalValid) {
        if (state.goalSeen && !SameGoalCell(s.planGoal, state.goalCell)) replan = true;
        state.goalSeen = true;
        state.goalCell = s.planGoal;
    }
    if (s.navRouteDelivered) {
        if (state.navRouteSeen) replan = true;
        state.navRouteSeen = true;
    }
    if (replan) why |= kWhyReplan;

    float length = 0.f, radial = 0.f, tangential = 0.f;
    const bool relative = StepComponents(s, length, radial, tangential);
    bool reversal = false;
    if (length > 1e-4f) {
        const Vec2 heading = Mul(s.commanded, 1.f / length);
        if (state.headingSeen && Dot(heading, state.heading) < 0.f) reversal = true;
        state.headingSeen = true;
        state.heading = heading;
    }
    if (reversal) why |= kWhyReversal;
    if (s.source == Source::ReflexVeto) why |= kWhyVeto;

    Window& win = state.window;
    ++win.frames;
    win.moved += length;
    if (relative) {
        if (radial > 0.f) win.radialOut += radial * length; else win.radialIn += -radial * length;
        win.tangential += std::fabs(tangential) * length;
    }
    if (length <= 1e-4f) ++win.holdFrames;
    if (s.source == Source::ReflexVeto) ++win.vetoes;
    if (reversal) ++win.reversals;
    if (replan) ++win.replans;
    if (why & ~static_cast<uint32_t>(kWhyFirst)) ++win.changes;

    state.seen = true;
    state.lastSampleMs = s.nowMs;
    state.objective = s.objective;       state.targetId = s.targetId;
    state.navigatorDstar = s.navigatorDstar; state.mapPending = s.mapPending;
    state.globalAssist = s.globalAssist; state.corridorState = s.corridorState;
    state.ruleGame = s.ruleGame;
    state.navRoute = s.navRoute;         state.plan = s.plan;
    state.ringApproach = s.ringApproach;
    state.solve = s.solve;               state.drive = s.drive;

    const bool heartbeat = s.objective != Objective::None && s.nowMs - state.lastHeartbeatMs >= kHeartbeatMs;
    if (s.objective == Objective::None) state.lastHeartbeatMs = s.nowMs;   // the beat starts with the objective

    bool emit = heartbeat;
    if (why != 0 && !emit) {
        if (why & kWhyObjectiveClass)      emit = Take(state.objectiveLines, s.nowMs, kObjectiveLinesPerSec);
        else if (why & kWhyPlanClass)      emit = Take(state.planLines, s.nowMs, kPlanLinesPerSec);
        else                               emit = Take(state.stepLines, s.nowMs, kStepLinesPerSec);
        if (!emit) ++state.dropped;
    }
    if (!emit) return 0;

    if (heartbeat) why |= kWhyHeartbeat;
    const size_t n = Format(s, why, replan, reversal, heartbeat ? &win : nullptr, state.dropped, out, cap);
    state.dropped = 0;
    if (heartbeat) {
        state.lastHeartbeatMs = s.nowMs;
        win = Window{};
    }
    return n;
}

using Sink = void (*)(const char* line);

// One sampled frame: step the state and write the line, if this frame has one. Call
// only while telemetry is on. Allocates nothing.
inline void Emit(State& state, const Sample& sample, Sink sink)
{
    char line[kLineCap];
    if (Step(state, sample, line, sizeof(line)) > 0 && sink) sink(line);
}

// A frame in which UDodge does nothing at all (it returns before deciding), at most
// one line a second: the reason is the whole story. Call only while telemetry is on.
inline void Idle(State& state, uint64_t nowMs, const char* reason, Sink sink)
{
    if (state.seen && nowMs - state.lastHeartbeatMs < kHeartbeatMs && nowMs >= state.lastHeartbeatMs) return;
    state = State{};
    state.seen = true;
    state.lastSampleMs = state.lastHeartbeatMs = nowMs;
    char line[160];
    std::snprintf(line, sizeof(line), "[Diag/Nav] t=%llu why=idle reason=%s",
                  static_cast<unsigned long long>(nowMs), reason ? reason : "?");
    if (sink) sink(line);
}

} } // namespace UDodge::Telemetry
