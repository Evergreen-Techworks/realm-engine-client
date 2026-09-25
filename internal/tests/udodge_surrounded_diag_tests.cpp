#include "UDodgeSolver.h"
#include <cstdio>

using namespace UDodge;
static int checks = 0, failures = 0;
static void Check(bool ok, const char* why) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", why); }
}

int main() {
    Solver::SurroundedDiagnosticGate cadence;
    Check(cadence.Ready(0) && !cadence.Ready(1) && !cadence.Ready(1999) && cadence.Ready(2000),
          "failure diagnostic cadence permits at most one snapshot per two seconds");
    // Observed family, not reconstructed live centers: wall west, open terrain
    // east, overlapping containing zones whose outward cones intersect west.
    // It proves the constraint conflict but does not justify crossing a blast.
    static DangerMap map{};
    map.zoneCount = 2;
    map.zones[0].pos = {.5f, 1.f}; map.zones[1].pos = {.5f, -1.f};
    for (int i=0;i<2;++i) { map.zones[i].radius=2.f; map.zones[i].active=true; }
    map.zones[1].enemyKeepout=true;
    MapInput in{}; in.map=&map; in.speed=.005f;
    in.env.canOccupy=[](float x,float,bool) { return x>=0.f; };
    Solver::Goal goal{}; Path::PlanResult route{}; CoreState state{};
    Solver::SolveResult decision{};
    Solver::Solve(in,1.f,goal,route,state,decision);
    Check(decision.kind==Solver::SolveKind::Surrounded && !decision.shouldMove,
          "opposing zone escape cones against wall reproduce stationary deadlock");
    Check(OccupancyPathClear(in,{}, {3.f,0.f}), "east terrain is actually traversable");
    const auto zone=Solver::ExplainSurrounded(in,1.f,goal);
    Check(zone.movingCandidates>0 && zone.terrainEndpoint>0 && zone.zoneEscape>0 && zone.admitted==0,
          "diagnostic identifies terrain plus zone vetoes with no moving survivor");
    Check(zone.movingCandidates==zone.terrainEndpoint+zone.enemyEscape+zone.terrainSweep+zone.zoneEscape+zone.admitted,
          "first-veto counts partition all moving candidates without double counting");
    Check(zone.containingZones==2 && zone.zones[0].index==0 && zone.zones[1].policyOnly &&
          zone.zones[0].effectiveRadius>zone.zones[0].radius,
          "diagnostic retains both containing centers, padded radii and policy distinction");
    const auto before = decision;
    state.Reset();
    Solver::Solve(in,1.f,goal,route,state,decision);
    Check(decision.kind==before.kind && decision.shouldMove==before.shouldMove &&
          LenSq(Sub(decision.target,before.target))==0.f,
          "diagnostic snapshot does not change subsequent solver decision");
    map.zoneCount=1; state.Reset();
    Solver::Solve(in,1.f,goal,route,state,decision);
    Check(decision.shouldMove, "removing conflicting zone restores legal outward escape");

    map.zoneCount=0; map.enemyCount=2;
    for(int i=0;i<2;++i) { map.enemies[i].pos={.5f,i? -1.f:1.f}; map.enemies[i].radius=2.f; }
    const auto body=Solver::ExplainSurrounded(in,1.f,goal);
    Check(body.enemyEscape>0 && body.zoneEscape==0 && body.admitted==0 && body.containingEnemies==2,
          "body escape rejection is distinguished from area danger");

    map.enemyCount=0;
    in.env.canOccupy=[](float x,float,bool) { return x<.3f || x>.7f; };
    const auto sweep=Solver::ExplainSurrounded(in,1.f,goal);
    Check(sweep.terrainSweep>0 && sweep.admitted>0,
          "intermediate terrain rejection is distinguished from endpoint rejection");
    Check(sweep.admitted==sweep.temporalBetter+sweep.temporalEqual+sweep.temporalWorse,
          "geometric survivors report comparative projectile timing rather than implied safety");
    in.movementLocked=true;
    const auto locked=Solver::ExplainSurrounded(in,1.f,goal);
    Check(locked.movementLocked && locked.movingCandidates==0,
          "paralysis is distinguished from geometric surround");
    in.movementLocked=false;
    map.zoneCount=5;
    for(int i=0;i<5;++i) {
        map.zones[i].pos={float(5-i)*.1f,0.f};
        map.zones[i].radius=2.f; map.zones[i].active=true;
    }
    const auto bounded=Solver::ExplainSurrounded(in,1.f,goal);
    Check(bounded.containingZones==5 && bounded.zones[0].index==4 &&
          bounded.zones[2].index==2,
          "containing detail storage is bounded and retains three nearest zones");
    std::printf("Surrounded diagnostics: %d checks, %d failures\n",checks,failures);
    return failures ? 1 : 0;
}
