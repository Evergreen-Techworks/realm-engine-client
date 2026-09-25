#pragma once
// Diagnostic-only, single game-thread producer / single IPC-thread consumer.
// No allocation, waiting, I/O, or managed pointers in this module.
#include <atomic>
#include <cstdint>
#include <cstddef>
#include <type_traits>
namespace UDodgeCapture {
constexpr unsigned kHistory=31, kQueue=128, kTerminalQueue=16;
constexpr unsigned kEnemies=64, kProjectiles=128, kZones=64, kPoints=8, kCells=289;
enum Trigger : uint32_t { HpDrop=1, Death=2, GoalChange=4, Reversal=8, NoProgress=16, MapEnd=32, ExternalTerminal=64 };
struct Decision {
    uint64_t ms=0, sequence=0, generation=0;
    uint32_t trigger=0, tick=0;
    int32_t hp=-1,maxHp=-1,lockId=0,mode=0,solve=0;
    float x=0,y=0,goalX=0,goalY=0,targetX=0,targetY=0,speed=0,range=0,clearance=0,standClearance=0,lockX=0,lockY=0,rawGoalX=0,rawGoalY=0;
    bool move=false, fromLock=false, lockApproach=false, driveAccepted=false;
    uint64_t dropped=0,suppressed=0;
};
struct Enemy { int32_t id=0,type=0,hp=0,maxHp=0; float x=0,y=0,vx=0,vy=0; uint32_t flags=0; };
struct Projectile {
    int32_t owner=0,attacker=0,bullet=0,totalPoints=0;
    float half=0,life=0,damage=0;
    uint32_t flags=0,count=0;
    float points[kPoints][3]{};
};
struct Zone { float x=0,y=0,radius=0; uint32_t flags=0; };
struct Candidate { float x=0,y=0,clearance=0,timeToDanger=-1,score=0; uint32_t flags=0; };
struct Scene {
    Decision decision{};
    uint32_t enemyCount=0,projectileCount=0,zoneCount=0;
    uint32_t enemiesObserved=0,projectilesObserved=0,zonesObserved=0,enemyEntriesVisited=0;
    uint32_t candidateCount=0,candidatesObserved=0,candidateTick=0,terrainTick=0; Candidate candidates[8]{};
    uint32_t flags=0; // 1 projectile-source-unavailable, 2 source limited, 4 terrain unavailable
    Enemy enemies[kEnemies]{}; Projectile projectiles[kProjectiles]{}; Zone zones[kZones]{};
    // Local occupancy flags at 0.5 tile resolution, 17x17; 255 = unobserved.
    float cellX=0,cellY=0,cellStep=.5f;
    uint8_t cells[kCells]{};
};
template<class T,unsigned N> struct Queue {
    T items[N]{};
    std::atomic<uint32_t> read{0},write{0},highWater{0};
    bool Push(const T& value) {
        const auto w=write.load(std::memory_order_relaxed);
        const auto depth=w-read.load(std::memory_order_acquire);
        if(depth>=N)return false;
        if(depth+1>highWater.load(std::memory_order_relaxed))highWater.store(depth+1,std::memory_order_relaxed);
        items[w%N]=value;write.store(w+1,std::memory_order_release);return true;
    }
    bool Pop(T& value) {
        const auto r=read.load(std::memory_order_relaxed);
        if(r==write.load(std::memory_order_acquire))return false;
        value=items[r%N];read.store(r+1,std::memory_order_release);return true;
    }
};
struct Capture {
    std::atomic<bool> enabled{false};
    std::atomic<uint32_t> externalTriggers{0};
    std::atomic<uint64_t> transportDropped{0};
    Queue<Scene,kQueue> scenes{};
    Queue<Decision,kTerminalQueue> decisions{};
    // Separate terminal queue preserves metadata when ordinary scenes overflow.
    Queue<Decision,kTerminalQueue> terminals{};
    Scene history[kHistory]{};
    unsigned next=0,count=0,windows=0,reversals=0;
    uint64_t sequence=0,generation=0,lastSample=0,windowStart=0,windowEnd=0,minuteStart=0;
    uint64_t dropped=0,suppressed=0,lastProgress=0,lastTrigger=0;
    Decision previous{};
    float progressX=0,progressY=0;
    bool havePrevious=false,sampled=false;
    bool Due(uint64_t now) const {return enabled.load(std::memory_order_relaxed)&&(!sampled||now-lastSample>=100);}
    void NewMap() {
        if(enabled.load(std::memory_order_relaxed)&&havePrevious){auto d=previous;TriggerEvent(d,MapEnd|externalTriggers.exchange(0,std::memory_order_relaxed));}
        ++generation;count=next=0;sampled=false;windowStart=windowEnd=0;havePrevious=false;reversals=0;lastProgress=0;
    }
    void Stamp(Decision& d) {d.sequence=++sequence;d.generation=generation;d.dropped=dropped+transportDropped.load(std::memory_order_relaxed);d.suppressed=suppressed;}
    void Enqueue(const Scene& s) {if(!scenes.Push(s))++dropped;}
    void TriggerEvent(Decision d,uint32_t reason) {
        if(!enabled.load(std::memory_order_relaxed))return;
        d.trigger=reason;Stamp(d);
        const bool terminal=(reason&(Death|MapEnd|ExternalTerminal))!=0;
        if(!(terminal?terminals.Push(d):decisions.Push(d)))++dropped;
        if(windowEnd&&d.ms<=windowEnd){ // merge overlap, bounded to five seconds total
            const auto desired=d.ms+2000;
            windowEnd=desired<windowStart+5000?desired:windowStart+5000;return;
        }
        if(d.ms-minuteStart>=60000){minuteStart=d.ms;windows=0;}
        if(windows>=6){++suppressed;return;}
        ++windows;windowStart=d.ms;windowEnd=d.ms+2000;
        for(unsigned i=0;i<count;++i){const auto& s=history[(next+kHistory-count+i)%kHistory];if(d.ms>=s.decision.ms&&d.ms-s.decision.ms<=3000)Enqueue(s);}
    }
    void Observe(Decision d) {
        if(!enabled.load(std::memory_order_relaxed)){havePrevious=false;count=next=0;sampled=false;windowEnd=0;externalTriggers.exchange(0,std::memory_order_relaxed);return;}
        uint32_t reason=externalTriggers.exchange(0,std::memory_order_relaxed);
        if(havePrevious){
            if(d.maxHp>0&&d.maxHp==previous.maxHp&&d.hp<previous.hp)reason|=HpDrop;
            if(d.hp==0&&previous.hp>0)reason|=Death;
            if(d.lockId!=previous.lockId||d.mode!=previous.mode)reason|=GoalChange;
            const float ax=previous.targetX-previous.x,ay=previous.targetY-previous.y;
            const float bx=d.targetX-d.x,by=d.targetY-d.y;
            if(previous.move&&d.move&&ax*bx+ay*by<-.01f&&++reversals>=3){reason|=Reversal;reversals=0;}
            const float dx=d.x-progressX,dy=d.y-progressY;
            if(dx*dx+dy*dy>.25f||!d.move){lastProgress=d.ms;progressX=d.x;progressY=d.y;}
            else if(d.move&&d.ms-lastProgress>=2000){reason|=NoProgress;lastProgress=d.ms;}
        }else{lastProgress=d.ms;progressX=d.x;progressY=d.y;reason|=GoalChange;}
        // Exact already-computed decision, not a second solver invocation.
        if(reason)TriggerEvent(d,reason);
        previous=d;havePrevious=true;
    }
    void Sample(Scene& s) {
        if(!Due(s.decision.ms))return;
        lastSample=s.decision.ms;sampled=true;Stamp(s.decision);
        history[next]=s;next=(next+1)%kHistory;if(count<kHistory)++count;
        if(windowEnd&&s.decision.ms<=windowEnd)Enqueue(s);
    }
};
static_assert(std::is_trivially_copyable<Scene>::value,"capture owns only copied scalar data");
static_assert(sizeof(Capture)<4*1024*1024,"fixed capture memory budget exceeded");
inline Capture capture{};
struct Frame { uint64_t ms=0,qpc=0; uint32_t sequence=0,threadId=0,epoch=0; };
struct FrameCapture {
    std::atomic<bool> enabled{false};
    Queue<Frame,2048> queue{};
    std::atomic_flag producing=ATOMIC_FLAG_INIT;
    std::atomic<uint64_t> dropped{0};
    uint32_t sequence=0,epoch=0; bool active=false;
    void Observe(bool enabled,uint64_t ms,uint64_t qpc,uint32_t threadId) {
        // Present normally has one producer; fail without waiting if that changes.
        if(producing.test_and_set(std::memory_order_acquire)){dropped.fetch_add(1,std::memory_order_relaxed);return;}
        if(!enabled){active=false;producing.clear(std::memory_order_release);return;}
        if(!active){++epoch;active=true;}
        if(!queue.Push({ms,qpc,++sequence,threadId,epoch}))dropped.fetch_add(1,std::memory_order_relaxed);
        producing.clear(std::memory_order_release);
    }
};
inline FrameCapture frames{};
static_assert(sizeof(Capture)+sizeof(FrameCapture)+3*sizeof(Scene)<4*1024*1024,"capture plus scratch and renderer budget");
} // namespace UDodgeCapture
