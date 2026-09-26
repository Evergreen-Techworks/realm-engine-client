#pragma once
// IPC-thread only: formatting allocates, capture producer never calls this.
#include "UDodgeCapture.h"
#include <string>
#include <cstdio>
#include <cmath>
#include <cstring>
namespace UDodgeCapture {
struct Json {
 std::string out;
 void Number(double v){if(!std::isfinite(v)){out+="null";return;}char b[64];std::snprintf(b,sizeof(b),"%.9g",v);out+=b;}
 void Integer(uint64_t v){char b[32];std::snprintf(b,sizeof(b),"%llu",static_cast<unsigned long long>(v));out+=b;}
 void Key(const char* k){out+='"';out+=k;out+="\":";}
 void Num(const char*k,double v){Key(k);Number(v);out+=',';}
 void Int(const char*k,uint64_t v){Key(k);Integer(v);out+=',';}
};
inline void DecisionJson(Json& j,const Decision& d){
 j.out+="{";j.Int("ms",d.ms);j.Int("sequence",d.sequence);j.Int("generation",d.generation);
 j.Num("observationAgeMs",static_cast<double>(d.observationAgeMs));j.Int("trigger",d.trigger);j.Int("tick",d.tick);j.Num("hp",d.hp);j.Num("maxHp",d.maxHp);j.Num("lockId",d.lockId);
 j.Num("mode",d.mode);j.Num("solve",d.solve);j.Num("x",d.x);j.Num("y",d.y);j.Num("goalX",d.goalX);j.Num("goalY",d.goalY);
 j.Num("targetX",d.targetX);j.Num("targetY",d.targetY);j.Num("speed",d.speed);j.Num("range",d.range);j.Num("clearance",d.clearance);
 j.Num("standClearance",d.standClearance);j.Num("lockX",d.lockX);j.Num("lockY",d.lockY);j.Num("rawGoalX",d.rawGoalX);j.Num("rawGoalY",d.rawGoalY);
 j.Int("move",d.move);j.Int("fromLock",d.fromLock);j.Int("lockApproach",d.lockApproach);j.Int("driveAccepted",d.driveAccepted);
 j.Int("dropped",d.dropped);j.Key("suppressed");j.Integer(d.suppressed);j.out+='}';
}
inline Json Envelope(const char* kind,uint32_t pid,uint64_t startUtc,uint64_t anchorMs,uint64_t anchorUtc,uint64_t uncertainty=16){
 Json j;j.out.reserve(std::strcmp(kind,"native_scene")==0?60000:std::strcmp(kind,"native_decision")==0?1200:15000);j.out="{\"type\":\"encounterCapture\",\"version\":1,\"kind\":\"";j.out+=kind;j.out+="\",";
 j.Int("processId",pid);j.Int("processStartUtcMs",startUtc);j.Int("anchorMs",anchorMs);j.Int("anchorUtcMs",anchorUtc);
 j.Int("sceneQueueHighWater",capture.scenes.highWater.load(std::memory_order_relaxed));j.Int("decisionQueueHighWater",capture.decisions.highWater.load(std::memory_order_relaxed));j.Int("terminalQueueHighWater",capture.terminals.highWater.load(std::memory_order_relaxed));j.Int("frameQueueHighWater",frames.queue.highWater.load(std::memory_order_relaxed));
 j.Int("updateQueueHighWater",updates.queue.highWater.load(std::memory_order_relaxed));j.Int("anchorUncertaintyMs",uncertainty);j.Int("memoryBytes",sizeof(Capture)+sizeof(FrameCapture)+sizeof(UpdateCapture)+3*sizeof(Scene)+kCopiedMetadataAllowance);return j;
}
inline std::string Encode(const Decision& d,uint32_t pid,uint64_t startUtc,uint64_t ms,uint64_t utc,uint64_t uncertainty=16){
 auto j=Envelope("native_decision",pid,startUtc,ms,utc,uncertainty);j.Key("decision");DecisionJson(j,d);j.out+='}';return j.out;
}
inline std::string Encode(const Scene& s,uint32_t pid,uint64_t startUtc,uint64_t ms,uint64_t utc,uint64_t uncertainty=16){
 auto j=Envelope("native_scene",pid,startUtc,ms,utc,uncertainty);j.Key("decision");DecisionJson(j,s.decision);j.out+=',';
 j.Int("candidateTick",s.candidateTick);j.Int("terrainTick",s.terrainTick);j.Int("candidatesObserved",s.candidatesObserved);j.out+="\"candidates\":[";
 for(unsigned i=0;i<s.candidateCount;++i){if(i)j.out+=',';const auto&c=s.candidates[i];j.out+='[';const double a[]={c.x,c.y,c.clearance,c.timeToDanger,c.score,double(c.flags)};for(unsigned n=0;n<6;++n){if(n)j.out+=',';j.Number(a[n]);}j.out+=']';}j.out+="],";
 j.Int("flags",s.flags);j.Int("enemiesObserved",s.enemiesObserved);j.Int("enemyEntriesVisited",s.enemyEntriesVisited);
 j.Int("projectilesObserved",s.projectilesObserved);j.Int("zonesObserved",s.zonesObserved);
 j.out+="\"enemies\":[";
 for(unsigned i=0;i<s.enemyCount;++i){if(i)j.out+=',';const auto&e=s.enemies[i];j.out+='[';const double a[]={double(e.id),double(e.type),double(e.hp),double(e.maxHp),e.x,e.y,e.vx,e.vy,double(e.flags)};for(unsigned n=0;n<9;++n){if(n)j.out+=',';j.Number(a[n]);}j.out+=']';}j.out+="],\"projectiles\":[";
 for(unsigned i=0;i<s.projectileCount;++i){if(i)j.out+=',';const auto&p=s.projectiles[i];j.out+='[';const double a[]={double(p.owner),double(p.attacker),double(p.bullet),p.half,p.life,p.damage,double(p.flags),double(p.totalPoints)};for(unsigned n=0;n<8;++n){if(n)j.out+=',';j.Number(a[n]);}j.out+=",[";
 for(unsigned n=0;n<p.count;++n){if(n)j.out+=',';j.out+='[';for(unsigned k=0;k<3;++k){if(k)j.out+=',';j.Number(p.points[n][k]);}j.out+=']';}j.out+="]]";}j.out+="],\"zones\":[";
 for(unsigned i=0;i<s.zoneCount;++i){if(i)j.out+=',';const auto&z=s.zones[i];j.out+='[';j.Number(z.x);j.out+=',';j.Number(z.y);j.out+=',';j.Number(z.radius);j.out+=',';j.Integer(z.flags);j.out+=']';}j.out+="],";
 j.out+="\"enemyDetails\":[";
 for(unsigned i=0;i<s.enemyCount;++i){if(i)j.out+=',';const auto&e=s.enemies[i];j.out+='[';j.Integer(e.observationMs);j.out+=',';j.Integer((e.flags&16)!=0);j.out+=',';j.Integer((e.flags&32)!=0);j.out+=',';j.Integer((e.flags&64)!=0);j.out+=']';}j.out+="],\"zoneDetails\":[";
 for(unsigned i=0;i<s.zoneCount;++i){if(i)j.out+=',';const auto&z=s.zones[i];j.out+='[';j.Number(z.source);j.out+=',';j.Number(z.owner);j.out+=',';j.Integer(z.capturedMs);j.out+=',';j.Integer(z.observationMs);j.out+=',';j.Number(z.landingInMs);j.out+=',';j.Number(z.expiresInMs);j.out+=',';j.Integer(z.observationFlags);j.out+=']';}j.out+="],\"weaponProfile\":";
 if(s.weapon.valid){const auto&w=s.weapon;j.out+='[';j.Integer(w.sequence);j.out+=',';j.Integer(w.ms);j.out+=',';j.Number(w.source);j.out+=',';j.Number(w.projId);j.out+=',';j.Number(w.speed);j.out+=',';j.Number(w.life);j.out+=',';j.Number(w.range);j.out+=',';j.Number(w.speedMul);j.out+=',';j.Number(w.lifeMul);j.out+=',';j.Number(w.rangeMul);j.out+=',';j.Integer(w.generation);j.out+=']';}else j.out+="null";j.out+=',';
 j.Num("cellX",s.cellX);j.Num("cellY",s.cellY);j.Num("cellStep",s.cellStep);j.out+="\"cells\":[";
 for(unsigned i=0;i<kCells;++i){if(i)j.out+=',';j.Integer(s.cells[i]);}j.out+="]}";return j.out;
}
inline std::string EncodeFrames(const Frame* f,unsigned count,uint32_t pid,uint64_t startUtc,uint64_t ms,uint64_t utc,uint64_t uncertainty,uint64_t frequency,uint64_t dropped){
 auto j=Envelope("native_present_interarrival",pid,startUtc,ms,utc,uncertainty);j.Int("qpcFrequency",frequency);j.Int("dropped",dropped);j.out+="\"frames\":[";
 for(unsigned i=0;i<count;++i){if(i)j.out+=',';j.out+='[';j.Integer(f[i].sequence);j.out+=',';j.Integer(f[i].epoch);j.out+=',';j.Integer(f[i].threadId);j.out+=',';j.Integer(f[i].ms);j.out+=',';j.Integer(f[i].qpc);j.out+=']';}j.out+="]}";return j.out;
}
inline std::string EncodeUpdates(const UpdateTiming* u,unsigned count,uint32_t pid,uint64_t startUtc,uint64_t ms,uint64_t utc,uint64_t uncertainty,uint64_t dropped){
 auto j=Envelope("native_update_timing",pid,startUtc,ms,utc,uncertainty);j.Int("dropped",dropped);j.out+="\"updates\":[";
 for(unsigned i=0;i<count;++i){if(i)j.out+=',';j.out+='[';j.Integer(u[i].sequence);j.out+=',';j.Integer(u[i].epoch);j.out+=',';j.Integer(u[i].threadId);j.out+=',';j.Integer(u[i].ms);j.out+=',';
 char precise[64];std::snprintf(precise,sizeof(precise),"%.17g",u[i].entryQpcMs);j.out+=precise;j.out+=',';j.Number(u[i].originalMs);j.out+=',';j.Number(u[i].dodgeMs);j.out+=',';j.Integer(u[i].sceneEnabled);j.out+=']';}
 j.out+="]}";return j.out;
}
} // namespace UDodgeCapture
