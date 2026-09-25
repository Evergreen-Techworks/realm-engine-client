#include "UDodgeSolver.h"
#include <cstdio>
#include <cmath>
using namespace UDodge;
int main(){int n=0,f=0;auto ck=[&](bool x,const char*m){++n;if(!x){++f;std::printf("FAIL %s\n",m);}};
static DangerMap map;MapInput in;in.map=&map;in.speed=.005f;in.tickId=42;
Solver::Goal goal;Path::PlanResult route;
for(int scenario=0;scenario<4;++scenario){
 map=DangerMap{};goal=Solver::Goal{};
 if(scenario==1){map.zoneCount=1;map.zones[0].active=true;map.zones[0].radius=1;}
 if(scenario==2){map.laneCount=1;auto&p=map.lanes[0];p.pointCount=p.instantCount=2;p.points[0]={-1,0};p.points[1]={1,0};p.pointTimesMs[1]=300;p.hitHalf=.3f;}
 if(scenario==3){goal.active=goal.fromLock=true;goal.lockPos={3,0};goal.pos={2,0};goal.maxRange=2;}
 CoreState a,b;Solver::SolveResult off,on;UDodgeCapture::capture.enabled=false;Solver::Solve(in,1,goal,route,a,off);
 UDodgeCapture::capture.enabled=true;Solver::Solve(in,1,goal,route,b,on);
 ck(off.kind==on.kind&&off.target.x==on.target.x&&off.target.y==on.target.y&&off.shouldMove==on.shouldMove&&off.clearance==on.clearance&&off.followedRoute==on.followedRoute,"capture leaves solver outcome identical");
 ck(off.captureCount==0,"disabled solver does not export alternatives");
 ck(on.captureCount>0&&on.captureCount<=8&&(on.captureCandidates[0].flags&1)&&on.captureTick==42,"actual bounded alternatives include stand and input tick");
}
UDodgeCapture::capture.enabled=false;std::printf("capture solver: %d checks %d failures\n",n,f);return f?1:0;}
