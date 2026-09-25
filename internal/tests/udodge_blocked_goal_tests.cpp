#include "UDodgePathfinder.h"
#include "UDodgePartialRoute.h"
#include "UDodgeSolver.h"
#include <cstdio>
using namespace UDodge;
static int checks=0,failures=0;
static void Check(bool ok,const char* label){++checks;if(!ok){++failures;std::fprintf(stderr,"FAIL: %s\n",label);}}
static int Index(int x,int y){return (y+kUNavRadCells)*kUNavSide+x+kUNavRadCells;}
int main(){
 static Path::PlannerSnapshot s{}; Path::PlanResult p{};
 s.navActive=true;s.speed=.005f;s.moveBudget=.5f;s.navGoal={4,0};
 // Known open room with an unknown frontier far behind the nearby blocked goal.
 for(auto& f:s.navGrid.flags)f=9;
 for(int y=-8;y<=8;++y)for(int x=-8;x<=8;++x)s.navGrid.flags[Index(x,y)]=0;
 s.navGrid.flags[Index(4,0)]=1;
 for(auto rule:{Movement::Collision::Rule::Legacy,Movement::Collision::Rule::Game}){
  s.collisionRule=rule; Path::Compute(s,p);
  Check(p.navFound&&p.navPartial&&!p.navArrived&&Len(Sub(p.navGoalCell,s.navGoal))<=1.01f,"known blocked nearby goal approaches reachable neighbor, not frontier");
 }
 s.player={3,0}; Path::Compute(s,p);
 Check(p.navFound&&p.navPartial&&!p.navArrived&&p.navWptCount==1&&LenSq(Sub(p.navStepTarget,s.player))==0,"at closest reachable cell retain partial hold without false arrival");
 s.navGrid.flags[Index(4,0)]=0; Path::Compute(s,p);
 Check(p.navFound&&!p.navPartial,"opening goal resumes complete path");
 s.player={0,0};for(int y=-8;y<=8;++y)for(int x=3;x<=8;++x)s.navGrid.flags[Index(x,y)]=9;Path::Compute(s,p);
 Check(p.navPartial&&!p.navBlockedGoalApproach&&Len(Sub(p.navGoalCell,s.navGoal))>1.01f,"unknown goal preserves exploration");
 for(int y=-8;y<=8;++y)for(int x=3;x<=8;++x)s.navGrid.flags[Index(x,y)]=0;
 for(int y=-8;y<=8;++y)s.navGrid.flags[Index(2,y)]=1;
 Path::Compute(s,p);
 Check(p.navPartial&&!p.navBlockedGoalApproach&&Len(Sub(p.navGoalCell,s.navGoal))>4,"clear unreachable goal preserves frontier search");
 for(int y=-8;y<=8;++y)s.navGrid.flags[Index(2,y)]=0;
 s.navGoal={40,0};s.navGrid.flags[Index(40,0)]=1;Path::Compute(s,p);
 Check(p.navPartial&&!p.navBlockedGoalApproach&&p.navGoalCell.x>=7,"far blocked goal preserves frontier search");
 s.navGoal={4,0};s.navGrid.flags[Index(4,0)]=1;s.navGoalRadius=2;
 Path::Compute(s,p);Check(p.navFound&&!p.navPartial,"combat goal disk still reaches safe surrounding cell");

 Check(Navigation::PauseBlockedGoalRetry(true,true,1500,1000)&&
       !Navigation::PauseBlockedGoalRetry(true,true,2000,1000)&&
       !Navigation::PauseBlockedGoalRetry(true,false,1500,1000)&&
       !Navigation::PauseBlockedGoalRetry(false,true,1500,1000),
       "only settled blocked approach pauses retry, for at most one second");
 // Waiting affects only strategic replans: immediate projectile dodge still runs.
 static DangerMap danger{}; auto& lane=danger.lanes[danger.laneCount++];
 lane.hitHalf=.05f;lane.pointCount=2;lane.instantCount=1;lane.tailAtShotEnd=true;
 lane.points[0]={1,0};lane.points[1]={0,0};lane.pointTimesMs[1]=100;
 MapInput input{};input.map=&danger;input.speed=.005f;
 Solver::Goal wait{};wait.active=true;wait.walkTo=true;wait.pos={};
 CoreState state{};Solver::SolveResult decision{};Path::PlanResult noRoute{};
 Solver::Solve(input,1.f,wait,noRoute,state,decision);
 Check(decision.shouldMove,"projectile threatening waiting player still triggers reflex movement");
 std::printf("Blocked goal: %d checks, %d failures\n",checks,failures);return failures?1:0;
}
