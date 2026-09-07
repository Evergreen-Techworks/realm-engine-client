#include "UDodgePathfinder.h"
#include "UDodgeNavigation.h"
#include "UDodgeSolver.h"
#include <cstdio>
#include <cstdlib>
using namespace UDodge;
void Check(bool ok, const char* name) {
    if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}
int main() {
    static DangerMap emptyMap{};
    MapInput cornerInput{}; cornerInput.map = &emptyMap; cornerInput.speed = 5.f;
    Solver::Goal cornerGoal{}; cornerGoal.active = true; cornerGoal.walkTo = true;
    cornerGoal.pos = {0.25f, 0.f};
    CoreState cornerState{}; Solver::SolveResult cornerResult{};
    Path::PlanResult emptyRoute{};
    Solver::Solve(cornerInput, 0.2f, cornerGoal, emptyRoute, cornerState, cornerResult);
    Check(cornerResult.shouldMove && cornerResult.target.x > 0.f,
          "intermediate bend within half a tile still advances");
    Navigation::Progress progress;
    Check(!progress.Stalled({}, 1000), "progress starts with a fresh observation");
    Check(!progress.Stalled({0.1f,0}, 1250), "short nudge does not replan immediately");
    Check(progress.Stalled({}, 1500), "left-right nudges trigger a replan after 500ms");
    Check(!progress.Stalled({-0.4f,0}, 1800), "real motion away from goal still counts as progress");
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
    std::puts("Navigation regressions passed (real A*, corner compression, swept steering, completion).");
}
