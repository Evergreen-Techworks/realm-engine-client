#include "UDodgePathfinder.h"
#include "UDodgeNavigation.h"
#include "UDodgeSolver.h"
#include "UDodgeCore.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
using namespace UDodge;
void Check(bool ok, const char* name) {
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}

// ── The result ladder prefers the ring (Tactician Slice 2) ───────────────────
// A boss at lockPos fires one volley of 45 shots, one every 8 degrees, each traced
// from r = 1 to r = 9 tiles where it dies. Every other shot is fast (800 ms to r = 9),
// the ones between are slow (1600 ms), and the player stands at r = 9.6 on the bearing
// of a slow shot, beyond every shot's end. With weapon range 7 the engagement ring is
// [2.45, 6.25]. Measured against whole shot paths (PointSafety) no cell of the ring is
// shot-free, and the ground outside r = 9 is. Measured in time the ring can be entered:
// the fast shots pass either side of the player's bearing 0.9 tiles away and the slow
// shot on it is still 2 tiles short of the ring's outer cells when the player gets there.
// (The plan's first fixture, every shot at 800 ms, is a closed wave: 8 degrees apart the
// shots' arrival boxes overlap out to r = 10.7, so nothing crosses it and the ring can
// only be entered once the volley is dead, which no bounded-wait route expresses.)
namespace Ring {
constexpr float kOuter = 6.25f, kInner = 2.45f;   // LockGeometry for weapon range 7
const Vec2 kLock{ -9.6f, 0.f };                   // the player stands at the origin: r = 9.6, bearing +x

void Volley(Path::PlannerSnapshot& s)
{
    s = Path::PlannerSnapshot{};
    s.lockPos = kLock;
    s.weaponRangeTiles = kOuter;
    s.innerStandoffTiles = kInner;
    s.speed = .005f;
    s.moveBudget = .5f;
    for (int k = -22; k <= 22; ++k) {
        const float a = static_cast<float>(k) * 8.f * kTwoPi / 360.f;
        const Vec2 dir{ std::cos(a), std::sin(a) };
        const float lifeMs = (k % 2 == 0) ? 1600.f : 800.f;   // k = 0, the player's bearing, is slow
        auto& lane = s.map.lanes[s.map.laneCount++];
        lane.hitHalf = .3f;
        lane.pointCount = lane.instantCount = 2;
        lane.points[0] = Add(kLock, Mul(dir, 1.f));
        lane.points[1] = Add(kLock, Mul(dir, 9.f));
        lane.pointTimesMs[1] = lifeMs;
        lane.remainingLifeMs = lifeMs;
        lane.tailAtShotEnd = true;
    }
}

int failures = 0;
void Expect(bool ok, const char* name) {
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); ++failures; }
}

void LadderTests()
{
    static Path::PlannerSnapshot snap{};
    static Path::PlanResult plan{};
    Volley(snap);

    // The fixture's premise, checked against the production safety test.
    MapInput mi{}; mi.player = snap.player; mi.settings = snap.settings; mi.map = &snap.map;
    Check(Core::PointSafety(mi, snap.player) >= kUDurablePocketMargin,
          "fixture: the stand outside the ring is shot-free");
    int ringCells = 0, shotFreeRingCells = 0;
    for (int gy = -kUPathMaxRadCells; gy <= kUPathMaxRadCells; ++gy)
        for (int gx = -kUPathMaxRadCells; gx <= kUPathMaxRadCells; ++gx) {
            const Vec2 w{ gx * kUPathCellTiles, gy * kUPathCellTiles };
            const float r = Len(Sub(w, kLock));
            if (r < kInner || r > kOuter + kUInRangeSlack) continue;
            ++ringCells;
            if (Core::PointSafety(mi, w) >= kUDurablePocketMargin) ++shotFreeRingCells;
        }
    Check(ringCells > 100 && shotFreeRingCells == 0, "fixture: no cell of the ring is shot-free");

    // 1. Approaching a ring, a shot-free stand outside it is not a goal.
    snap.ringApproach = true;
    Path::Compute(snap, plan);
    Expect(!plan.startIsGoal,
           "a shot-free stand outside the ring is not a goal while a ring is being approached");

    // 2. The in-ring time-clear spot wins over the shot-free ground outside the ring.
    Expect(plan.found && plan.ringGoal && !plan.outOfRange,
           "an in-ring time-clear spot outranks the shot-free ground outside the ring");
    Expect(plan.found && plan.tempGoal && !plan.partial,
           "fixture: the ring is entered on the time-aware goal, not a shot-free cell");
    const float goalR = Len(Sub(plan.goalPos, kLock));
    Expect(plan.found && goalR >= kInner && goalR <= kOuter + kUInRangeSlack,
           "the ring goal lies inside the ring");
    Core::Temporal::Ctx time{};
    Core::Temporal::Build(snap.map, snap.settings.hitScale, snap.settings.positionUncertainty,
        snap.player, 20.f, time, Core::ProjectilePlayerHalf(snap.settings));
    Expect(plan.wptCount >= 2, "the way into the ring is a route");
    float arrival = 0.f;
    for (int vertex = 1; vertex < plan.wptCount; ++vertex) {
        const float nextArrival = arrival + Len(Sub(plan.wpts[vertex], plan.wpts[vertex - 1])) / snap.speed;
        Expect(Core::Temporal::EdgeClear(time, plan.wpts[vertex - 1], plan.wpts[vertex], arrival, nextArrival),
               "the way into the ring never crosses a shot");
        arrival = nextArrival;
    }

    // 3. Without a ring, nothing changes: a shot-free stand ends the search.
    snap.ringApproach = false;
    snap.hasLock = false;
    Path::Compute(snap, plan);
    Expect(plan.startIsGoal && !plan.ringGoal, "unlocked play still short-circuits on a shot-free stand");

    if (failures) { std::fprintf(stderr, "Ring ladder tests: %d failures\n", failures); std::exit(1); }
    std::puts("Ring ladder tests passed (ring goal outranks out-of-range ground, start rule, unlocked unchanged).");
}
} // namespace Ring

int main() {
    Check(Navigation::SameRouteRequest(true, 7, 42, 7, 42), "same global request retains local route across corridor refresh");
    Check(!Navigation::SameRouteRequest(true, 8, 42, 7, 42), "scene changes invalidate the old local route");
    Check(!Navigation::SameRouteRequest(true, 7, 43, 7, 42), "new goals invalidate the old local route");
    Check(!Navigation::SameRouteRequest(false, 7, 42, 7, 42), "manual and legacy goal changes never retain stale routes");
    Check(!Navigation::SameRouteRequest(true, 0, 0, 0, 0), "uncorrelated routes cannot be retained");
    Check(Navigation::TravelStepConsumed(true, true, false, true, {1,0}, {1,0}, {4,0}, 0.1f),
          "completed safe travel steps refresh before the next server tick");
    Check(!Navigation::TravelStepConsumed(true, true, false, false, {1,0}, {1,0}, {4,0}, 0.1f),
          "intentional hold and fallback decisions never trigger travel continuation");
    Check(!Navigation::TravelStepConsumed(true, true, true, true, {1,0}, {1,0}, {4,0}, 0.1f),
          "waiting for a verified route never authorizes travel continuation");
    Check(!Navigation::TravelStepConsumed(true, true, false, true, {1,0}, {1,0}, {1,0}, 0.1f),
          "arrived travel does not repeatedly solve");
    Check(!Navigation::TravelStepConsumed(true, true, false, true, {1,0}, {1,0}, {4,0}, 0.f),
          "paralysis cannot trigger travel continuation");
    Check(!Navigation::TravelStepConsumed(true, true, false, true, {1,0}, {1.05f,0}, {4,0}, 0.1f),
          "short corner steps finish before choosing another step");
    static DangerMap emptyMap{};
    MapInput cornerInput{}; cornerInput.map = &emptyMap; cornerInput.speed = 5.f;
    Solver::Goal cornerGoal{}; cornerGoal.active = true; cornerGoal.walkTo = true;
    cornerGoal.pos = {0.25f, 0.f};
    CoreState cornerState{}; Solver::SolveResult cornerResult{};
    Path::PlanResult emptyRoute{};
    Solver::Solve(cornerInput, 0.2f, cornerGoal, emptyRoute, cornerState, cornerResult);
    Check(cornerResult.shouldMove && cornerResult.target.x > 0.f,
          "intermediate bend within half a tile still advances");
    const Vec2 corridorStep{2.f, 0.f};
    auto waiting=Navigation::FinishRefresh(true,false,true,false,{},corridorStep,true,false,false);
    Check(waiting.solve && LenSq(waiting.step)==0.f, "first blocked-route wait requests one hold solve");
    waiting=Navigation::FinishRefresh(true,true,true,false,{},corridorStep,false,false,false);
    Check(!waiting.solve, "unchanged waiting frame does not repeat the full solver");
    waiting=Navigation::FinishRefresh(true,true,true,false,{},corridorStep,true,false,false);
    Check(waiting.solve, "waiting still refreshes on a new map/tick");
    auto arrived=Navigation::FinishRefresh(true,true,false,true,{},corridorStep,false,false,false);
    Check(arrived.solve && LenSq(Sub(arrived.step,corridorStep))==0.f,
          "fresh worker route releases HOLD and immediately steers along its corridor");
    cornerGoal.pos=arrived.step;
    Solver::Solve(cornerInput,0.2f,cornerGoal,emptyRoute,cornerState,cornerResult);
    Check(cornerResult.shouldMove && cornerResult.target.x>0.f,
          "resumed corridor drives the production solver instead of overwriting movement with HOLD");
    Check(Navigation::FinishRefresh(false,false,false,false,{},corridorStep,false,true,false).solve,
          "commitment changes still re-solve manual movement");
    auto redirected=Navigation::FinishRefresh(true,false,false,true,{},corridorStep,
        false,false,false,true);
    Check(redirected.solve, "late worker steering for an old goal is replaced even without a wait transition");
    cornerGoal.pos=redirected.step;
    cornerResult.shouldMove=true; cornerResult.target={0.f,0.2f};
    Solver::Solve(cornerInput,0.2f,cornerGoal,emptyRoute,cornerState,cornerResult);
    Check(cornerResult.target.x>0.f && cornerResult.target.y==0.f,
          "live corridor replaces a safe but wrongly directed worker move");
    Check(!Navigation::FinishRefresh(true,false,false,true,{},corridorStep,
        false,false,false,false).solve, "unchanged corridor avoids redundant live solves");
    Navigation::Progress progress;
    Check(!progress.Stalled({}, 1000), "progress starts with a fresh observation");
    Check(!progress.Stalled({0.1f,0}, 1250), "short nudge does not replan immediately");
    Check(progress.Stalled({}, 1500), "left-right nudges trigger a replan after 500ms");
    Check(!progress.Stalled({-0.4f,0}, 1800), "real motion away from goal still counts as progress");
    Check(!progress.Stalled({-0.4f,0}, 4000, true), "worker waiting time does not count as stuck movement");
    Check(!progress.Stalled({-0.4f,0}, 5000), "fresh route receives a fresh movement-progress window");
    Check(progress.Stalled({-0.4f,0}, 5500), "a real stall after route arrival still triggers recovery");
    MapInput padded{};
    padded.env.canOccupy = [](float, float y, bool) { return y > 0.f; };
    Check(!Navigation::PaddedPathClear(padded, {0,1}, {2,0.1f}), "navigation refuses wall-hugging shortcut");
    Check(Navigation::PaddedPathClear(padded, {0,1}, {2,0.4f}), "route retains a clear wall margin");
    Check(Navigation::PaddedPathClear(padded, {0,0.1f}, {0,1}), "padding never prevents escaping a tight start");
    // A one-cell-wide L corridor: reducing its corners must preserve every leg.
    static Path::PlannerSnapshot snap{};
    snap.navActive = true; snap.navGoal = {4,4}; snap.moveBudget = 3;
    for (auto& f : snap.navGrid.flags) f = 1;
    auto open = [&](int x, int y) {
        snap.navGrid.flags[(y+kUNavRadCells)*kUNavSide+x+kUNavRadCells] = 0;
    };
    for (int x=0; x<=4; ++x) open(x,0);
    for (int y=0; y<=4; ++y) open(4,y);
    static Path::PlanResult plan{};
    Path::Compute(snap, plan);
    Check(plan.navFound && !plan.navPartial, "L corridor found");
    Check(plan.navWptCount == 3, "straight legs compressed to exact corner and endpoint");
    Check(LenSq(Sub(plan.navWpts[1], {4,0})) < 1e-6f, "corner preserved before turn");
    Check(plan.navStepTarget.y == 0, "worker lookahead cannot cut corridor corner");
    MapInput in{};
    in.env.occFlags=snap.navGrid.flags; in.env.occSide=kUNavSide;
    in.env.occRadius=kUNavRadCells; in.env.occCellTiles=1;
    auto clear = [&](Vec2 a, Vec2 b) { return OccupancyPathClear(in,a,b); };
    float dev; bool end;
    // The closest segment is across a tree/wall. Rejoin the visible earlier
    // leg instead of repeatedly aiming at the inaccessible nearby projection.
    Vec2 folded[] = {{0,0}, {0,3}, {1,3}, {1,0}};
    auto wallClear = [](Vec2 a, Vec2 b) {
        for (int i=0; i<=100; ++i) {
            const Vec2 q=Add(a,Mul(Sub(b,a),i/100.f));
            if (q.x>0.7f && q.x<0.9f && q.y<2.5f) return false;
        }
        return true;
    };
    Vec2 rejoin=Navigation::Follow(folded,4,{0.6f,1},6,dev,end,wallClear);
    Check(wallClear({0.6f,1},rejoin) && rejoin.y>1,
          "folded route follows visible leg around wall");
    Vec2 inaccessible[]={{0,0},{2,0}};
    Vec2 hold=Navigation::Follow(inaccessible,2,{0,0},6,dev,end,wallClear);
    Check(wallClear({0,0},hold), "blocked first bend is never returned unchecked");
    Vec2 shortRoute[]={{0,0},{2,0}};
    Navigation::Follow(shortRoute,2,{0,0},6,dev,end,[](Vec2,Vec2){return true;});
    Check(!end, "lookahead reaching the end does not consume a route before arrival");
    Navigation::Follow(shortRoute,2,{1.8f,0},6,dev,end,[](Vec2,Vec2){return true;});
    Check(end, "route is consumed when the player actually reaches its endpoint");
    Vec2 prefix=Navigation::Follow(inaccessible,2,{0,0},6,dev,end,wallClear);
    Check(prefix.x>0.3f && wallClear({0,0},prefix),
          "blocked lookahead still advances along the verified open prefix");
    Vec2 p{};
    for (int frame=0; frame<200 && Len(Sub(p,{4,4}))>0.05f; ++frame) {
        Vec2 next=Navigation::Follow(plan.navWpts,plan.navWptCount,p,6,dev,end,clear);
        Check(clear(p,next), "every follower shortcut stays inside L corridor");
        p=Add(p,Mul(Normalize(Sub(next,p)),std::min(0.1f,Len(Sub(next,p)))));
    }
    Check(Len(Sub(p,{4,4}))<=0.05f, "follower traverses corner without stalling");
    Vec2 target=Navigation::Follow(plan.navWpts,3,{0,0},6,dev,end,
        [](Vec2,Vec2){return true;});
    Check(target.y>0, "open space retains smooth lookahead");
    // Approach a square tree from each cardinal direction; exercise replanning
    // scratch reuse as well as both clockwise and counterclockwise corners.
    for (Vec2 start : {Vec2{-4,0}, Vec2{4,0}, Vec2{0,-4}, Vec2{0,4}}) {
        for (auto& f : snap.navGrid.flags) f=0;
        for (int y=-1; y<=1; ++y)
            for (int x=-1; x<=1; ++x)
                snap.navGrid.flags[(y+kUNavRadCells)*kUNavSide+x+kUNavRadCells]=1;
        snap.player=start; snap.navGoal=Mul(start,-1);
        Path::Compute(snap,plan);
        Check(plan.navFound && !plan.navPartial, "tree detour found");
        p=start;
        for (int frame=0; frame<400 && Len(Sub(p,snap.navGoal))>0.05f; ++frame) {
            Vec2 next=Navigation::Follow(plan.navWpts,plan.navWptCount,p,6,dev,end,clear);
            Check(clear(p,next), "tree shortcut has clear swept footprint");
            p=Add(p,Mul(Normalize(Sub(next,p)),std::min(0.1f,Len(Sub(next,p)))));
        }
        Check(Len(Sub(p,snap.navGoal))<=0.05f, "tree detour completes without stalling");
    }
    snap.player={-4.3f,0.2f}; snap.navGoal={4,0};
    Path::Compute(snap,plan);
    Check(plan.navWptCount>=3 && LenSq(Sub(plan.navWpts[1],{-4,0}))<1e-6f,
          "off-centre start retains tile alignment before compressed first leg");
    for (auto& f : snap.navGrid.flags) f=1;
    snap.player={0,0}; snap.navGoal={4,4}; open(0,0);
    Path::Compute(snap,plan);
    Check(!plan.navArrived && plan.navWptCount==1 && LenSq(plan.navStepTarget)==0.f,
          "boxed-in A* never returns the raw destination as a steering step");
    std::puts("Navigation regressions passed (real A*, corner compression, swept steering, completion).");
    Ring::LadderTests();
}
