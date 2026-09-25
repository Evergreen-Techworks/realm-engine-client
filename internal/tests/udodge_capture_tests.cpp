#include "features/movement/udodge/UDodgeCapture.h"
#include <cstdio>
#include <memory>
#include "features/movement/udodge/UDodgeCaptureWire.h"
using namespace UDodgeCapture;
int main(){int n=0,f=0;auto ck=[&](bool x,const char*m){++n;if(!x){++f;std::printf("FAIL %s\n",m);}};
auto c=std::make_unique<Capture>();Scene s;Decision d;d.hp=100;d.maxHp=100;d.ms=1000;
c->Observe(d);c->Sample(s);ck(c->count==0&&!c->Due(1000),"disabled does no history work");
c->enabled=true;c->NewMap();
 s.decision.ms=100;c->Sample(s);ck(!c->Due(199)&&c->Due(200),"scene sampling never exceeds ten Hz");
 c->NewMap(); // independent history fixture

for(int i=0;i<40;++i){s.decision.ms=1000+i*100;c->Sample(s);}ck(c->count==31,"history fixed at 31 scenes");
d.ms=5000;c->TriggerEvent(d,HpDrop);ck(c->scenes.write==30,"three seconds pre-event retained");
Decision event;ck(c->decisions.Pop(event)&&event.trigger==HpDrop,"exact event captured");
s.decision.ms=5100;s.enemies[0].x=7;c->Sample(s);s.enemies[0].x=99;Scene out;while(c->scenes.Pop(out)){}ck(out.enemies[0].x==7,"queue owns values independent of caller lifetime");
c->TriggerEvent(d,HpDrop);ck(c->windows==1,"overlapping trigger merges");
for(int i=0;i<200;++i){s.decision.ms=5200+i*100;c->Sample(s);c->TriggerEvent(s.decision,HpDrop);}ck(c->scenes.write-c->scenes.read<=128&&c->dropped>0,"storm overflow bounded and counted");
ck(c->windows<=6,"six ordinary windows per minute cap");
d.ms=26000;c->TriggerEvent(d,Death);ck(c->terminals.Pop(event)&&event.trigger==Death,"reserved terminal survives scene overflow");
c->Observe(d);c->NewMap();ck(c->count==0&&c->generation==3,"map reset clears entity history");ck(c->terminals.Pop(event)&&event.generation==2,"pending old map terminal keeps identity");
ck(sizeof(Capture)<4*1024*1024,"total storage under four MiB");
 auto frames=std::make_unique<FrameCapture>();frames->Observe(false,0,0,1);ck(frames->queue.write==0,"disabled frame queue unchanged");
 frames->Observe(true,1,100,1);frames->Observe(true,2,200,1);Frame frame;frames->queue.Pop(frame);const auto epoch=frame.epoch;
 ck(frame.sequence==1&&frame.qpc==100,"renderer raw timestamp and sequence retained");
 frames->Observe(false,0,0,0);frames->Observe(true,4,400,1);frames->queue.Pop(frame);frames->queue.Pop(frame);
 ck(frame.epoch==epoch+1,"disabled interval creates new cadence epoch");
 for(int i=0;i<3000;++i)frames->Observe(true,5+i,500+i,1);
 ck(frames->dropped>0&&frames->queue.write-frames->queue.read<=2048,"frame storm drops instead of growing");
 const auto json=Encode(out,1,2,3,4,17);ck(json.find("\"anchorUncertaintyMs\":17")!=std::string::npos,"clock bracket uncertainty serialized");
 c->enabled=false;c->Observe(d);ck(c->count==0,"disable clears history before re-enable");
 while(c->terminals.Pop(event)){}
 c->enabled=true;c->externalTriggers=ExternalTerminal;d.ms=27000;c->Observe(d);ck(c->terminals.Pop(event)&&(event.trigger&ExternalTerminal)!=0,"external terminal request consumed by producer");

 auto limits=std::make_unique<Capture>();limits->enabled=true;
 for(int i=0;i<8;++i){d.ms=1000+i*6000;limits->TriggerEvent(d,GoalChange);}
 ck(limits->windows==6&&limits->suppressed==2,"seventh and eighth nonoverlapping windows suppressed");
 d.ms=61000;limits->TriggerEvent(d,GoalChange);ck(limits->windows==1,"ordinary window allowance resets after minute");
 auto queue=std::make_unique<Queue<Scene,2>>();ck(queue->Push(s)&&queue->Push(s)&&!queue->Push(s),"queue refuses exact capacity overflow");
 ck(queue->Pop(out)&&queue->Push(s),"consumer frees bounded queue slot");
 std::printf("capture: %d checks %d failures; bytes=%zu\n",n,f,sizeof(Capture));return f?1:0;}
