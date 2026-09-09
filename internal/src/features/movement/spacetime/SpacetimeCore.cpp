#include "pch-il2cpp.h"
#include "SpacetimeCore.h"
#include "../udodge/UDodgeCore.h"
#include <algorithm>
#include <cmath>
#include <queue>
#include <unordered_map>
#include <vector>
#include <chrono>

namespace SpacetimeDodge {
namespace {
using namespace UDodge;
namespace Temporal = UDodge::Core::Temporal;
constexpr float kEps = 0.0001f;
constexpr int kMaxNodes = 30000;

// Euclidean distance to a relative-motion segment (used for bodies and AoEs).
float MinDistOnSegment(float x0,float y0,float x1,float y1) {
    const float dx=x1-x0,dy=y1-y0,lengthSq=dx*dx+dy*dy;
    const float t=lengthSq>1e-9f?std::clamp(-(x0*dx+y0*dy)/lengthSq,0.f,1.f):0.f;
    return std::hypot(x0+t*dx,y0+t*dy);
}

bool IntentChanged(const Input& in,Vec2 previous) {
    // World float rounding perturbs a held direction slightly. A retained
    // route is still checked against every current threat and the actual
    // command chord; this only avoids restarting its search for that noise.
    return Len(Sub(previous,in.nominal))>std::max(1e-6f,in.world.speed*.001f);
}

float SegmentSeparation(Vec2 a, Vec2 b, Vec2 p, Vec2 q) {
    const Vec2 u = Sub(b,a), v = Sub(q,p), w = Sub(p,a);
    const auto cross = [](Vec2 x, Vec2 y) { return x.x*y.y-x.y*y.x; };
    const float den = cross(u,v);
    if (std::fabs(den)>1e-8f) {
        const float s=cross(w,v)/den, t=cross(w,u)/den;
        if(s>=0.f && s<=1.f && t>=0.f && t<=1.f) return 0.f;
    }
    const auto point = [](Vec2 x, Vec2 y, Vec2 z) {
        return MinDistOnSegment(y.x-x.x,y.y-x.y,z.x-x.x,z.y-x.y);
    };
    return std::min({point(a,p,q),point(b,p,q),point(p,a,b),point(q,a,b)});
}

struct Check {
    const Input& in;
    Diagnostics* stats = nullptr;
    mutable int lastLane = -1;
    bool Contact(Vec2 a,Vec2 b,float half,float* entry=nullptr,float* leave=nullptr) const {
        const bool hit=SweptProjectileContact(a,b,half,entry,leave);
        if(hit && stats && MinDistOnSegment(a.x,a.y,b.x,b.y)>half) ++stats->cornerRejects;
        return hit;
    }
    struct Bounds { Vec2 lo{},hi{}; float half=0.f, expiry=0.f; bool relevant=false; };
    std::array<Bounds,UDodge::kMaxProjectiles> bounds{};
    explicit Check(const Input& input, Diagnostics* diagnostics = nullptr) : in(input), stats(diagnostics) {
        for(int i=0;i<in.world.map->laneCount;i++) {
            const auto& lane=in.world.map->lanes[i]; auto& box=bounds[i];
            box.relevant=LaneInLookRange(in,lane);
            if(!box.relevant) continue;
            box.lo=box.hi=lane.points[0];
            for(int j=1;j<lane.pointCount;j++) {
                const auto p=lane.points[j];
                box.lo.x=std::min(box.lo.x,p.x); box.lo.y=std::min(box.lo.y,p.y);
                box.hi.x=std::max(box.hi.x,p.x); box.hi.y=std::max(box.hi.y,p.y);
            }
            // The player is a point. Ordinary projectile contact uses the
            // game's per-axis threshold, not an inscribed circular radius.
            box.half=ProjectileRadius(lane,in.world.settings);
            const float life=lane.remainingLifeMs>=0.f?lane.remainingLifeMs:
                (lane.tailAtShotEnd?lane.pointTimesMs[lane.pointCount-1]:1e9f);
            box.expiry=life;
            Vec2 future{};
            if(ProjectLinearTail(lane,std::min(in.settings.horizonMs,life),future)) {
                box.lo.x=std::min(box.lo.x,future.x); box.lo.y=std::min(box.lo.y,future.y);
                box.hi.x=std::max(box.hi.x,future.x); box.hi.y=std::max(box.hi.y,future.y);
            }
        }
    }
    bool Bullets(Vec2 a,Vec2 b,float ta,float tb,int only=-1,float* exposure=nullptr) const {
        bool hit=false;
        const auto contact=[&](Vec2 p,Vec2 q,float half,float lo,float hi) {
            float entry=0.f,leave=0.f;
            if(!Contact(p,q,half,&entry,&leave)) return false;
            hit=true;
            if(exposure) *exposure+=std::max(0.f,hi-lo)*(leave-entry);
            return !exposure; // boolean checks can stop at their first contact
        };
        const auto at=[&](float t) {return tb>ta?Add(a,Mul(Sub(b,a),(t-ta)/(tb-ta))):a;};
        for(int i=only<0?0:only;i<(only<0?in.world.map->laneCount:only+1);i++) {
            const auto& lane=in.world.map->lanes[i]; const auto& box=bounds[i];
            if(!box.relevant) continue;
            const float end=std::min(tb,box.expiry), half=box.half;
            if(ta>=box.expiry) continue;
            if(std::max(a.x,b.x)<box.lo.x-half || std::min(a.x,b.x)>box.hi.x+half ||
               std::max(a.y,b.y)<box.lo.y-half || std::min(a.y,b.y)>box.hi.y+half) continue;
            lastLane=i;
            if(lane.beam) {
                if(SegmentSeparation(a,at(end),lane.points[0],lane.points[lane.pointCount-1])<=half) {
                    hit=true;
                    if(!exposure) return false;
                    *exposure+=std::max(0.f,end-ta);
                }
                continue;
            }
            for(int j=1;j<lane.pointCount;j++) {
                const float t0=lane.pointTimesMs[j-1],t1=lane.pointTimesMs[j];
                const float lo=std::max(ta,t0),hi=std::min(end,t1);
                if(hi<lo || t1<=t0) continue;
                const auto shot=[&](float t){return Add(lane.points[j-1],Mul(Sub(lane.points[j],lane.points[j-1]),(t-t0)/(t1-t0)));};
                const Vec2 p=Sub(shot(lo),at(lo)),q=Sub(shot(hi),at(hi));
                if(contact(p,q,half,lo,hi)) return false;
            }
            const float traced=lane.pointTimesMs[lane.pointCount-1];
            if(end>traced) {
                const Vec2 from=at(std::max(ta,traced));
                Vec2 startShot{},endShot{};
                if(ProjectLinearTail(lane,std::max(ta,traced),startShot) && ProjectLinearTail(lane,end,endShot)) {
                    const Vec2 p=Sub(startShot,from),q=Sub(endShot,at(end));
                    if(contact(p,q,half,std::max(ta,traced),end)) return false;
                } else if(lane.tailAtShotEnd || (lane.remainingLifeMs>=0.f && traced>=lane.remainingLifeMs)) {
                    const Vec2 p=Sub(lane.points[lane.pointCount-1],from),q=Sub(lane.points[lane.pointCount-1],at(end));
                    if(contact(p,q,half,std::max(ta,traced),end)) return false;
                } else {
                    // Missing future samples are not evidence of an expired shot.
                    if(stats) ++stats->unknownTailChecks;
                    bool tailHit=false;
                    for(int j=1;j<lane.pointCount;j++) {
                        const Vec2 shotA=lane.points[j-1],shotB=lane.points[j],to=at(end);
                        if(SegmentSeparation(from,to,shotA,shotB)==0.f ||
                           SweptProjectileContact(Sub(shotA,from),Sub(shotB,from),half) ||
                           SweptProjectileContact(Sub(shotA,to),Sub(shotB,to),half) ||
                           SweptProjectileContact(Sub(from,shotA),Sub(to,shotA),half) ||
                           SweptProjectileContact(Sub(from,shotB),Sub(to,shotB),half)) { tailHit=true; break; }
                    }
                    if(lane.pointCount==1 && SweptProjectileContact(Sub(lane.points[0],from),Sub(lane.points[0],at(end)),half)) tailHit=true;
                    if(tailHit) {
                        hit=true;
                        if(!exposure) return false;
                        // Unknown timing remains conservative, counted once.
                        *exposure+=std::max(0.f,end-std::max(ta,traced));
                    }
                }
            }
        }
        return !hit;
    }
    bool Edge(Vec2 a, Vec2 b, float ta, float tb,bool threatsOnly=false) const {
        if(stats) ++stats->edges;
        if (!std::isfinite(a.x) || !std::isfinite(a.y) ||
            !std::isfinite(b.x) || !std::isfinite(b.y) || tb < ta) return false;
        if (Len(Sub(b, a)) > in.world.speed * (tb - ta) + kEps) { if(stats) ++stats->speedRejects; return false; }
        if (!threatsOnly && !OccupancyPathClear(in.world, a, b)) { if(stats) ++stats->terrainRejects; return false; }
        if (!EnemyPathClear(in.world, a, b,threatsOnly)) { if(stats) ++stats->enemyRejects; return false; }
        if (!Bullets(a, b, ta, tb)) { if(stats) ++stats->projectileRejects; return false; }
        // A telegraph blocks at its activation time. Escaping one zone never
        // exempts any other zone.
        for (int i = 0; i < in.zoneCount; ++i) {
            const auto& z = in.zones[i];
            const float lo = std::max(ta, z.startsMs), hi = std::min(tb, z.endsMs);
            if (hi < lo) continue;
            const auto at = [&](float t) {
                return tb > ta ? Add(a, Mul(Sub(b, a), (t - ta) / (tb - ta))) : a;
            };
            const Vec2 p = Sub(at(lo), z.center), q = Sub(at(hi), z.center);
            const Vec2 delta = Sub(q, p);
            const float fraction = LenSq(delta) > 1e-10f ? std::clamp(-Dot(p, delta) / LenSq(delta), 0.f, 1.f) : 0.f;
            if (Len(Add(p, Mul(delta, fraction))) <= z.radius) { if(stats) ++stats->zoneRejects; return false; }
        }
        // Hosts which do not supply timed zones still retain active-zone safety.
        if (in.zoneCount == 0) {
            for(int i=0;i<in.world.map->zoneCount;i++) {
                const auto& z=in.world.map->zones[i];
                const Vec2 p=Sub(a,z.pos),q=Sub(b,z.pos);
                if(z.active && MinDistOnSegment(p.x,p.y,q.x,q.y)<=z.radius) {
                    if(stats) ++stats->zoneRejects;
                    return false;
                }
            }
        }
        return true;
    }
    bool Tail(Vec2 p, float t) const {
        // A route cannot finish inside a body, including a partially completed
        // escape while keys are held.
        const Vec2 end=Add(p,Mul(in.nominal,in.settings.horizonMs-t));
        if(Core::EnemyBlocked(in.world,end)) return false;
        return Edge(p, end,
                    t, in.settings.horizonMs);
    }
};

bool ValidInput(const Input& in) {
    if (!(in.world.map && !in.world.map->projectileSourceUnavailable &&
        !in.world.map->limited && std::isfinite(in.world.speed) && in.world.speed >= 0.f &&
        std::isfinite(in.world.player.x) && std::isfinite(in.world.player.y) &&
        std::isfinite(in.nowMs) && std::isfinite(in.nominal.x) && std::isfinite(in.nominal.y) &&
        Len(in.nominal) <= in.world.speed + kEps &&
        in.zoneCount >= 0 && in.zoneCount <= kMaxTimedZones &&
        in.settings.stepMs >= 10.f && in.settings.horizonMs <= kMaxZoneHorizonMs &&
        in.settings.horizonMs > in.settings.leadMs + in.settings.dwellMs &&
        in.settings.leadMs >= 0.f && in.settings.dwellMs >= 0.f &&
        std::isfinite(in.actuationMs) && in.actuationMs >= 0.f &&
        std::isfinite(in.maxCorrectionSpeed) && in.maxCorrectionSpeed>=0.f &&
        std::isfinite(in.frameMs) && in.frameMs > 0.f &&
        std::isfinite(in.settings.maxDistance) && in.settings.maxDistance>0.f &&
        std::isfinite(in.settings.lookRange) && in.settings.lookRange>0.f &&
        in.world.map->laneCount>=0 && in.world.map->laneCount<=UDodge::kMaxProjectiles &&
        in.world.map->enemyCount>=0 && in.world.map->enemyCount<=UDodge::kMaxEnemies &&
        in.world.map->zoneCount>=0 && in.world.map->zoneCount<=UDodge::kMaxAoes)) return false;
    for(int i=0;i<in.world.map->laneCount;i++) {
        const auto& lane=in.world.map->lanes[i];
        if(lane.pointCount<1 || lane.pointCount>kMaxLanePoints ||
           !std::isfinite(lane.hitHalf) || lane.hitHalf<0.f) return false;
        if(lane.hasLinearMotion && (!std::isfinite(lane.linearVelocity.x) ||
           !std::isfinite(lane.linearVelocity.y))) return false;
        for(int j=0;j<lane.pointCount;j++) {
            if(!std::isfinite(lane.points[j].x) || !std::isfinite(lane.points[j].y) ||
               !std::isfinite(lane.pointTimesMs[j]) ||
               (j && !lane.beam && lane.pointTimesMs[j]<=lane.pointTimesMs[j-1])) return false;
        }
    }
    for(int i=0;i<in.zoneCount;i++) {
        const auto& z=in.zones[i];
        if(!std::isfinite(z.center.x) || !std::isfinite(z.center.y) || !std::isfinite(z.radius) ||
           !std::isfinite(z.startsMs) || !std::isfinite(z.endsMs) || z.radius<=0.f || z.endsMs<z.startsMs) return false;
    }
    return true;
}

bool ValidateWith(const Input& in, const Plan& plan, const Check& check) {
    if (plan.count < 2 || plan.count > kMaxPlanPoints) return false;
    if (std::fabs(plan.speed - in.world.speed) > 1e-6f ||
        IntentChanged(in,plan.nominal)) return false;
    const float age = static_cast<float>(in.nowMs - plan.epochMs);
    if (age < 0.f || age > plan.points[plan.count - 1].timeMs) return false;
    if (Len(Sub(PositionAt(plan, age), in.world.player)) >
        std::max(.08f,in.world.speed*in.settings.stepMs+.03f)) return false;
    Vec2 prev = Add(in.world.player,Mul(in.nominal,in.settings.leadMs));
    float time = in.settings.leadMs;
    if(!check.Edge(in.world.player,prev,0.f,time)) return false;
    for (int i = 1; i < plan.count; ++i) {
        const float next = plan.points[i].timeMs - age;
        if (next <= time) continue;
        if (next > in.settings.horizonMs) break;
        if (!check.Edge(prev, plan.points[i].pos, time, next)) return false;
        prev = plan.points[i].pos;
        time = next;
    }
    return check.Tail(prev, time);
}

bool Describe(const Input& in, const Plan& plan, const Check& check, Output& out) {
    out.plan = plan;
    const float age = static_cast<float>(in.nowMs - plan.epochMs);
    // Lead is already represented in the path. Issue the slice that will take
    // effect after that lead; never pull departure forward with a slack test.
    const float t = age + in.settings.leadMs;
    const Vec2 a = Add(in.world.player,Mul(in.nominal,in.settings.leadMs));
    const Vec2 b = PositionAt(plan, t + in.frameMs);
    out.velocity = Mul(Sub(b, a), 1.f / std::max(1.f, in.frameMs));
    out.waitMs = std::max(0.f, plan.departureMs - t);
    // Execute a partial stroke on the last command interval that contains its
    // departure. Waiting for the next render frame can miss the absolute time.
    if(out.waitMs>=in.frameMs) out.velocity=in.nominal;
    // A frame may span a short stroke or a turn. The host issues one straight
    // command, so validate that actual chord too, not only its source segments.
    if(!check.Edge(a,Add(a,Mul(out.velocity,in.frameMs)),in.settings.leadMs,
                   in.settings.leadMs+in.frameMs)) {
        out.velocity=in.nominal; out.status=Status::Incomplete; out.reason=Reason::CommandBlocked; return false;
    }
    out.status = Len(Sub(out.velocity, in.nominal)) > 1e-6f ? Status::Moving : Status::Waiting;
    return true;
}

struct Node {
    Vec2 pos{}, mid{};
    float cost = 0.f, departure = 1e9f, turns = 0.f, motionMs = 0.f;
    Vec2 heading{};
    int layer = 0, parent = -1;
};
struct Entry { float cost, departure, turns; int index; };
struct Later {
    bool operator()(const Entry& a, const Entry& b) const {
        if (a.departure != b.departure) return a.departure < b.departure;
        if (a.cost != b.cost) return a.cost > b.cost;
        if (a.turns != b.turns) return a.turns > b.turns;
        return a.index > b.index;
    }
};
// Spatial merging bounds a control-space search; coordinates remain continuous
// and every accepted edge uses its real endpoints. This is approximate search,
// not a claim of SIPP completeness or global minimum distance.
uint64_t Key(Vec2 p, Vec2 origin, int layer, float resolution) {
    const int x = static_cast<int>(std::lround((p.x - origin.x) / resolution));
    const int y = static_cast<int>(std::lround((p.y - origin.y) / resolution));
    return (static_cast<uint64_t>(layer) << 32) |
        (static_cast<uint64_t>(static_cast<uint16_t>(x)) << 16) | static_cast<uint16_t>(y);
}
}

Vec2 PositionAt(const Plan& plan, float t) {
    if (plan.count == 0) return {};
    if (t <= plan.points[0].timeMs) return plan.points[0].pos;
    for (int i = 1; i < plan.count; ++i) {
        if (t <= plan.points[i].timeMs) {
            const auto& a = plan.points[i - 1]; const auto& b = plan.points[i];
            return Add(a.pos, Mul(Sub(b.pos, a.pos), (t - a.timeMs) / std::max(kEps, b.timeMs - a.timeMs)));
        }
    }
    return Add(plan.points[plan.count - 1].pos,
               Mul(plan.nominal, t - plan.points[plan.count - 1].timeMs));
}

// Per-shot contact half. Sourced from the SAME model UDodge's authoritative
// floors use (Core::ProjectilePlayerHalf + the position-uncertainty pad), so a
// plan this planner calls safe is not then rejected by the gate for disagreeing
// about the hit box. Under the default point-player model the player half is
// zero and this is exactly the game's per-axis threshold T.
float ProjectileRadius(const UDodge::LaneThreat& lane,const UDodge::Settings& settings) {
    return std::clamp(lane.hitHalf, 0.05f, 2.5f) * std::clamp(settings.hitScale, 0.25f, 2.5f)
         + UDodge::Core::ProjectilePlayerHalf(settings)
         + std::clamp(settings.positionUncertainty, 0.f, 0.35f);
}

bool EnemyPathClear(const UDodge::MapInput& in,Vec2 from,Vec2 to,bool ignoreScenery) {
    if(!in.map) return false;
    for(int i=0;i<in.map->enemyCount;i++) {
        const auto& e=in.map->enemies[i];
        if(ignoreScenery && e.passiveScenery) continue;
        const Vec2 a=UDodge::Sub(from,e.pos),b=UDodge::Sub(to,e.pos),delta=UDodge::Sub(b,a);
        const float radius=UDodge::EnemyAvoidanceRadius(e,in.settings);
        if(UDodge::Len(a)<radius) {
            // Existing penetration can only stay level during a command gate,
            // or decrease monotonically. Never cross the centre to the far side.
            if(UDodge::Dot(a,delta)<-1e-6f || UDodge::LenSq(b)<UDodge::LenSq(a)-1e-6f) return false;
        } else if(MinDistOnSegment(a.x,a.y,b.x,b.y)<radius) return false;
    }
    return true;
}

bool ProjectLinearTail(const UDodge::LaneThreat& lane,float time,Vec2& position) {
    if(!lane.hasLinearMotion || lane.beam || lane.pointCount<1 || lane.pointCount>UDodge::kMaxLanePoints ||
       !std::isfinite(time) || !std::isfinite(lane.linearVelocity.x) || !std::isfinite(lane.linearVelocity.y)) return false;
    const int last=lane.pointCount-1;
    const float traced=lane.pointTimesMs[last];
    const float expiry=lane.remainingLifeMs>=0.f?lane.remainingLifeMs:lane.tailAtShotEnd?traced:1e9f;
    if(time<traced || time>expiry) return false;
    position=UDodge::Add(lane.points[last],UDodge::Mul(lane.linearVelocity,time-traced));
    return std::isfinite(position.x) && std::isfinite(position.y);
}

SampleStatus SampleProjectile(const UDodge::LaneThreat& lane,float time,Vec2& position) {
    if(lane.pointCount<1 || !std::isfinite(time) || time<0.f) return SampleStatus::Unknown;
    position=lane.points[0];
    const float end=lane.pointTimesMs[lane.pointCount-1];
    const float expiry=lane.remainingLifeMs>=0.f?lane.remainingLifeMs:lane.tailAtShotEnd?end:1e9f;
    if(time>=expiry) return SampleStatus::Expired;
    if(lane.beam) return SampleStatus::Known;
    for(int i=1;i<lane.pointCount;i++) {
        if(time<=lane.pointTimesMs[i]) {
            const float span=lane.pointTimesMs[i]-lane.pointTimesMs[i-1];
            if(span<=0.f) return SampleStatus::Unknown;
            position=UDodge::Add(lane.points[i-1],UDodge::Mul(UDodge::Sub(lane.points[i],lane.points[i-1]),
                std::clamp((time-lane.pointTimesMs[i-1])/span,0.f,1.f)));
            return SampleStatus::Known;
        }
    }
    position=lane.points[lane.pointCount-1];
    return time<=end || ProjectLinearTail(lane,time,position)?SampleStatus::Known:SampleStatus::Unknown;
}

bool LaneInLookRange(const Input& in,const UDodge::LaneThreat& lane) {
    if(lane.pointCount<1) return false;
    const float reach=in.settings.lookRange+ProjectileRadius(lane,in.world.settings)*(lane.beam?1.f:1.414214f);
    const float until=std::min(in.settings.horizonMs,lane.remainingLifeMs>=0.f?lane.remainingLifeMs:in.settings.horizonMs);
    if(until<=0.f) return false;
    const auto close=[&](Vec2 a,Vec2 b) {
        a=UDodge::Sub(a,in.world.player); b=UDodge::Sub(b,in.world.player);
        return MinDistOnSegment(a.x,a.y,b.x,b.y)<=reach;
    };
    if(lane.beam) return close(lane.points[0],lane.points[lane.pointCount-1]);
    if(close(lane.points[0],lane.points[0])) return true;
    for(int i=1;i<lane.pointCount;i++) {
        const float t0=lane.pointTimesMs[i-1],t1=lane.pointTimesMs[i];
        if(t0>until) break;
        Vec2 end=lane.points[i];
        if(t1>until && t1>t0) end=UDodge::Add(lane.points[i-1],UDodge::Mul(
            UDodge::Sub(end,lane.points[i-1]),(until-t0)/(t1-t0)));
        if(close(lane.points[i-1],end)) return true;
    }
    Vec2 projected{};
    const float expiry=lane.remainingLifeMs>=0.f?lane.remainingLifeMs:
        lane.tailAtShotEnd?lane.pointTimesMs[lane.pointCount-1]:until;
    if(ProjectLinearTail(lane,std::min(until,expiry),projected) &&
       close(lane.points[lane.pointCount-1],projected)) return true;
    return false;
}

bool Validate(const Input& in, const Plan& plan) {
    if (!ValidInput(in)) return false;
    Check check(in);
    return ValidateWith(in, plan, check);
}

bool EvaluateTrajectory(const Input& in, const Plan& plan, Output& out) {
    if (!ValidInput(in) || in.world.movementLocked || in.world.speed <= 0.f) return false;
    Check check(in);
    Output candidate{};
    if (!ValidateWith(in, plan, check) || !Describe(in, plan, check, candidate)) return false;
    out = candidate;
    return true;
}

bool KeyboardIntentSafe(const Input& in) {
    if(!ValidInput(in) || in.world.movementLocked || in.world.playerOnHazard) return false;
    const Vec2 start=in.world.player,end=Add(start,Mul(in.nominal,in.settings.horizonMs));
    // Ground damage is separate from physical occupancy. Water/slow tiles
    // don't count as damage. Check the same footprint used by live sensors.
    const auto harmful=[&](Vec2 p) {
        if(in.world.env.isHazard) return in.world.env.isHazard(p.x,p.y);
        MapInput physical=in.world,protectedGround=in.world;
        physical.settings.safeWalk=false; protectedGround.settings.safeWalk=true;
        return CanOccupyAt(physical,p) && !CanOccupyAt(protectedGround,p);
    };
    const int steps=std::max(1,static_cast<int>(std::ceil(Len(Sub(end,start))/.2f)));
    for(int i=0;i<=steps;i++) {
        const Vec2 p=Add(start,Mul(Sub(end,start),float(i)/steps));
        const float h=kUOccPlayerHalfEdge;
        if(harmful(p) || harmful(Add(p,{-h,-h})) || harmful(Add(p,{h,-h})) ||
            harmful(Add(p,{-h,h})) || harmful(Add(p,{h,h}))) return false;
    }
    Check check(in);
    if(!check.Edge(start,end,0.f,in.settings.horizonMs,true)) return false;
    // A solid may stop native movement. Do not assume walking through that
    // solid avoids a bullet: also test the predicted stopping point in time.
    MapInput physical=in.world; physical.settings.safeWalk=false;
    Vec2 previous=start;
    for(int i=1;i<=steps;i++) {
        const float t=in.settings.horizonMs*float(i)/steps;
        const Vec2 p=Add(start,Mul(in.nominal,t));
        if(!OccupancyPathClear(physical,previous,p) || !EnemyPathClear(physical,previous,p)) {
            const float stoppedAt=in.settings.horizonMs*float(i-1)/steps;
            return check.Edge(previous,previous,stoppedAt,in.settings.horizonMs,true);
        }
        previous=p;
    }
    return true;
}

// Insert more unchanged input before the correction, preserving its speed,
// command cadence and shape. Shift its positions by the input traveled during
// that wait. The caller checks the entire new route, including the new tail.
static bool DelayPlan(const Input& in,const Plan& source,float delay,Plan& result) {
    float lastCorrection=0.f;
    for(int i=1;i<source.count;i++) {
        const auto a=source.points[i-1],b=source.points[i];
        if(Len(Sub(Sub(b.pos,a.pos),Mul(in.nominal,b.timeMs-a.timeMs)))>kEps)
            lastCorrection=b.timeMs;
    }
    const float tail=std::min(in.settings.dwellMs,in.settings.horizonMs-lastCorrection);
    if(lastCorrection+delay+tail>in.settings.horizonMs || source.count+1>kMaxPlanPoints) return false;
    result=source; result.count=0; result.departureMs+=delay;
    result.points[result.count++]={in.world.player,0.f};
    const Vec2 shift=Mul(in.nominal,delay);
    result.points[result.count++]={Add(in.world.player,shift),delay};
    for(int i=1;i<source.count;i++) {
        const auto p=source.points[i];
        if(p.timeMs+delay>=in.settings.horizonMs) break;
        result.points[result.count++]={Add(p.pos,shift),p.timeMs+delay};
    }
    result.points[result.count++]={Add(PositionAt(source,in.settings.horizonMs-delay),shift),in.settings.horizonMs};
    return true;
}

void ApplyZonePlanningLimits(Input& in) {
    if(!std::isfinite(in.world.speed) || in.world.speed<=0.f ||
       in.zoneCount<0 || in.zoneCount>kMaxTimedZones) return;
    const float ordinaryHorizon=in.settings.horizonMs;
    const float duty=in.actuationMs>0.f?std::min(1.f,in.actuationMs/in.settings.stepMs):1.f;
    const float executableSpeed=in.world.speed*std::max(.01f,duty);
    for(int i=0;i<in.zoneCount;i++) {
        const auto& z=in.zones[i];
        if(z.endsMs<0.f || z.startsMs>kMaxZoneHorizonMs || !std::isfinite(z.radius) || z.radius<=0.f) continue;
        const float distance=Len(Sub(in.world.player,z.center));
        const float exit=std::max(0.f,z.radius-distance);
        // Do not inflate lookahead for unrelated bombs elsewhere in the room.
        if(exit<=0.f) continue;
        const float required=exit/executableSpeed+in.settings.stepMs+in.settings.leadMs;
        if(z.startsMs>required+ordinaryHorizon) continue;
        const float horizon=std::min(kMaxZoneHorizonMs,std::max(ordinaryHorizon,
            z.startsMs+std::max(in.settings.dwellMs,in.settings.stepMs)));
        // A micro-dodge preference must not prohibit crossing a wider blast.
        // Extra path budget also permits routing around an intervening wall.
        const float budget=std::max(in.settings.maxDistance,exit*2.f+in.world.speed*in.settings.stepMs);
        if(horizon>in.settings.horizonMs || budget>in.settings.maxDistance) in.expandedForZones=true;
        in.settings.horizonMs=std::max(in.settings.horizonMs,horizon);
        in.settings.maxDistance=budget;
    }
}

// A wide blast can require dozens of full-speed command periods. Seed the
// bounded search with swept, timed straight escapes so its expansion budget
// isn't exhausted enumerating tiny strokes while a clear exit exists.
static bool WideZoneEscape(const Input& in,const Check& check,Plan& best) {
    if(!in.expandedForZones || in.settings.maxExpansions<=0) return false;
    const auto began=std::chrono::steady_clock::now();
    const float step=in.settings.stepMs,lead=in.settings.leadMs;
    const float duration=in.actuationMs>0.f?std::min(step,in.actuationMs):step;
    const auto timedOut=[&] {
        return in.settings.maxSearchMs>0.f && std::chrono::duration<float,std::milli>(
            std::chrono::steady_clock::now()-began).count()>in.settings.maxSearchMs*.4f;
    };
    for(int heading=0;heading<16;heading++) {
        if(timedOut()) break;
        const float angle=kTwoPi*heading/16.f;
        const Vec2 velocity={std::cos(angle)*in.world.speed,std::sin(angle)*in.world.speed};
        if(in.actuationMs>0.f && Len(Sub(velocity,in.nominal))>
           (in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed)+kEps) continue;
        Plan route{}; route.epochMs=in.nowMs; route.speed=in.world.speed; route.nominal=in.nominal;
        route.departureMs=lead; route.points[route.count++]={in.world.player,0.f};
        Vec2 p=Add(in.world.player,Mul(in.nominal,lead));
        if(!check.Edge(in.world.player,p,0.f,lead)) continue;
        if(lead>0.f) route.points[route.count++]={p,lead};
        for(float time=lead;time+step+in.settings.dwellMs<=in.settings.horizonMs;time+=step) {
            if(timedOut() || route.count+4>=kMaxPlanPoints) break;
            const Vec2 mid=Add(p,Mul(velocity,duration));
            const Vec2 end=Add(mid,Mul(in.nominal,step-duration));
            route.intervention+=Len(Sub(velocity,in.nominal))*duration;
            if(route.intervention>in.settings.maxDistance ||
               !check.Edge(p,mid,time,time+duration) || !check.Edge(mid,end,time+duration,time+step)) break;
            route.points[route.count++]={mid,time+duration};
            if(duration<step) route.points[route.count++]={end,time+step};
            p=end;
            if(!check.Tail(p,time+step)) continue;
            route.points[route.count++]={Add(p,Mul(in.nominal,in.settings.horizonMs-time-step)),in.settings.horizonMs};
            if(!ValidateWith(in,route,check)) break;
            Plan candidate=route;
            // Descending deadlines retain the latest fully validated departure.
            for(float delay=std::floor((in.settings.horizonMs-time-step-in.settings.dwellMs)/step)*step;
                delay>=step;delay-=step) {
                if(timedOut()) break;
                Plan delayed{};
                if(DelayPlan(in,route,delay,delayed) && ValidateWith(in,delayed,check)) { candidate=delayed; break; }
            }
            if(best.count==0 || candidate.departureMs>best.departureMs ||
               (candidate.departureMs==best.departureMs && candidate.intervention<best.intervention)) best=candidate;
            break;
        }
    }
    return best.count>0;
}

// An anytime seed: check complete full-speed strokes at useful distances
// before a fine control search spends its budget on short partial corrections.
// Every proposal includes resumed input, all threats, and the actual command.
static bool QuickEscape(const Input& in,const Check& check,Plan& seed) {
    if(in.settings.maxExpansions<=0) return false;
    const auto began=std::chrono::steady_clock::now();
    const auto timedOut=[&] { return in.settings.maxSearchMs>0.f &&
        std::chrono::duration<float,std::milli>(std::chrono::steady_clock::now()-began).count()>
            in.settings.maxSearchMs*.25f; };
    const float step=in.settings.stepMs,lead=in.settings.leadMs;
    // Only continuously executable controls qualify for this seed.
    if(in.actuationMs>0.f && in.actuationMs<step-.001f) return false;
    for(float factor:{1.f,2.f,4.f,6.f,8.f,12.f,16.f}) {
        const float duration=step*factor;
        if(lead+duration+in.settings.dwellMs>in.settings.horizonMs) break;
        for(int heading=0;heading<17;heading++) {
            if(timedOut()) return seed.count>0;
            const float angle=kTwoPi*heading/16.f;
            const Vec2 velocity=heading==16?Vec2{}:Vec2{std::cos(angle)*in.world.speed,std::sin(angle)*in.world.speed};
            const float correction=Len(Sub(velocity,in.nominal));
            if(correction<1e-6f || correction*duration>in.settings.maxDistance ||
               (in.actuationMs>0.f && correction>(in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed)+kEps)) continue;
            Plan p{}; p.speed=in.world.speed; p.nominal=in.nominal; p.epochMs=in.nowMs;
            p.intervention=correction*duration; p.departureMs=lead;
            p.points[p.count++]={in.world.player,0.f};
            const Vec2 start=Add(in.world.player,Mul(in.nominal,lead));
            if(lead>0.f) p.points[p.count++]={start,lead};
            const Vec2 end=Add(start,Mul(velocity,duration));
            p.points[p.count++]={end,lead+duration};
            p.points[p.count++]={Add(end,Mul(in.nominal,in.settings.horizonMs-lead-duration)),in.settings.horizonMs};
            Output executable{};
            if(!ValidateWith(in,p,check) || !Describe(in,p,check,executable)) continue;
            seed=p;
            for(float delay=std::floor((in.settings.horizonMs-lead-duration-in.settings.dwellMs)/step)*step;
                delay>=step;delay-=step) {
                if(timedOut()) break;
                Plan delayed{}; Output delayedOutput{};
                if(DelayPlan(in,p,delay,delayed) && ValidateWith(in,delayed,check) && Describe(in,delayed,check,delayedOutput)) {
                    seed=delayed; break;
                }
            }
            return true;
        }
    }
    return false;
}

static void EvaluateSafe(const Input& in, State& state, Output& out) {
    const auto began=std::chrono::steady_clock::now();
    out = Output{}; out.velocity = in.nominal;
    if (!ValidInput(in)) {
        out.reason=!in.world.map?Reason::MissingMap:
            in.world.map->projectileSourceUnavailable?Reason::CaptureUnavailable:
            in.world.map->limited?Reason::Truncated:Reason::InvalidInput;
        state.Reset(); return;
    }
    if (in.world.movementLocked || in.world.speed == 0.f) {
        state.Reset(); out.status = Status::Locked; out.velocity = {}; return;
    }
    Check check(in,in.collectDiagnostics?&out.diagnostics:nullptr);
    if (check.Tail(in.world.player, 0.f)) {
        state.Reset(); out.status = Status::Clear; return;
    }
    // First unsafe interval on the baseline, for the diagnostic HUD only.
    // This is a conservative 10 ms bracket, not an exact collision timestamp.
    for(float t=0.f;in.collectDiagnostics && t<in.settings.horizonMs;t+=10.f) {
        const float end=std::min(in.settings.horizonMs,t+10.f);
        const int rejected=out.diagnostics.projectileRejects;
        if(!check.Edge(Add(in.world.player,Mul(in.nominal,t)),
            Add(in.world.player,Mul(in.nominal,end)),t,end)) {
            out.diagnostics.baselineHitMs=t;
            if(out.diagnostics.projectileRejects>rejected) out.diagnostics.threatLane=check.lastLane;
            break;
        }
    }
    if (state.valid && ValidateWith(in, state.plan, check)) {
        if(Describe(in, state.plan, check, out)) { out.reused = true; return; }
    }
    if(state.valid) {
        out.replanReason=std::fabs(state.plan.speed-in.world.speed)>1e-6f?Reason::SpeedChanged:
            IntentChanged(in,state.plan.nominal)?Reason::IntentChanged:
            Len(Sub(PositionAt(state.plan,static_cast<float>(in.nowMs-state.plan.epochMs)),in.world.player))>
                .08f?Reason::PositionDrift:Reason::RouteBlocked;
    }
    state.Reset();
    const float lead = in.settings.leadMs, step = in.settings.stepMs;
    const Vec2 start = Add(in.world.player, Mul(in.nominal, lead));
    if (!check.Edge(in.world.player, start, 0.f, lead)) { out.status = Status::NoPlan; out.reason=Reason::LeadBlocked; return; }

    Plan wideEscape{};
    if(WideZoneEscape(in,check,wideEscape) && Describe(in,wideEscape,check,out)) {
        state.plan=wideEscape; state.valid=true; return;
    }
    Plan seed{};
    QuickEscape(in,check,seed);
    out.diagnostics.seedAvailable=seed.count>0;

    std::vector<Node> nodes; nodes.reserve(kMaxNodes);
    std::priority_queue<Entry, std::vector<Entry>, Later> open;
    std::unordered_map<uint64_t, int> best; best.reserve(8192);
    Node root{}; root.pos = root.mid = start;
    nodes.push_back(root); open.push({0.f, 1e9f, 0.f, 0});
    const float resolution = std::max(0.025f, in.world.speed * step * 0.3f);
    const int layers = std::min((kMaxPlanPoints-4)/2, static_cast<int>((in.settings.horizonMs - lead - in.settings.dwellMs) / step));
    int goal = -1;
    const auto searchStart=began;
    const auto goalBetter=[&](const Node& candidate) {
        if(goal<0) return true;
        const auto& prior=nodes[goal];
        return candidate.departure>prior.departure || (candidate.departure==prior.departure &&
            (candidate.cost<prior.cost-kEps ||
             (std::fabs(candidate.cost-prior.cost)<=kEps && candidate.turns<prior.turns)));
    };
    while (!open.empty()) {
        const int index = open.top().index; open.pop();
        const Node n = nodes[index];
        if(goal>=0 && (n.departure<nodes[goal].departure ||
            (n.departure==nodes[goal].departure && n.cost>nodes[goal].cost+kEps))) break;
        const auto key = Key(n.pos, start, n.layer, resolution);
        const auto existing = best.find(key);
        if (existing != best.end() && existing->second != index) continue;
        const float time = lead + n.layer * step;
        if (check.Tail(n.pos, time)) { if(goalBetter(n)) goal=index; continue; }
        if (out.expansions++ >= in.settings.maxExpansions || nodes.size() + 35 >= kMaxNodes) {
            out.budgetHit = true; break;
        }
        if(in.settings.maxSearchMs>0.f && (out.expansions%16)==0 &&
           std::chrono::duration<float,std::milli>(std::chrono::steady_clock::now()-searchStart).count()>=in.settings.maxSearchMs*.75f) {
            out.budgetHit=true; break;
        }
        if (n.layer >= layers) continue;
        // Preserve intent, stop, then sixteen full-speed headings. Short strokes
        // run at full speed for half the actuation window, then resume intent.
        for (int action = 0; action < 35; ++action) {
            Vec2 velocity{};
            float duration = step;
            if (action == 0) velocity = in.nominal;
            else {
                duration = in.actuationMs > 0.f ? std::min(step, in.actuationMs) : step;
                if (action >= 2) {
                    const int dir = (action - 2) % 16;
                    const float angle = kTwoPi * static_cast<float>(dir) / 16.f;
                    velocity = {std::cos(angle) * in.world.speed, std::sin(angle) * in.world.speed};
                    if (action >= 18) duration *= 0.5f;
                }
                if (action == 34) continue;
            }
            // The existing native host compensates keyboard movement with a
            // bounded correction. Do not propose a correction it would clamp.
            if (in.actuationMs > 0.f && Len(Sub(velocity, in.nominal)) >
                (in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed) + kEps) continue;
            Node next{};
            next.mid = Add(n.pos, Mul(velocity, duration));
            next.pos = Add(next.mid, Mul(in.nominal, step - duration));
            if(Core::EnemyBlocked(in.world,n.pos) && LenSq(Sub(next.pos,n.pos))<1e-10f) continue;
            next.layer = n.layer + 1; next.parent = index; next.motionMs = duration;
            const float added = Len(Sub(velocity, in.nominal)) * duration;
            next.cost = n.cost + added;
            if (next.cost > in.settings.maxDistance || Len(Sub(next.pos, start)) >
                in.settings.maxDistance + Len(in.nominal) * (time + step)) continue;
            next.departure = added > kEps ? std::min(n.departure, time) : n.departure;
            if(goal>=0 && (next.departure<nodes[goal].departure ||
                (next.departure==nodes[goal].departure && next.cost>nodes[goal].cost+kEps))) continue;
            next.heading = added > kEps ? Normalize(Sub(velocity, in.nominal)) : n.heading;
            next.turns = n.turns + (added > kEps && LenSq(n.heading) > 0.f ? 1.f - Dot(n.heading, next.heading) : 0.f);
            const auto nextKey = Key(next.pos, start, next.layer, resolution);
            const auto old = best.find(nextKey);
            if (old != best.end()) {
                const auto& prior = nodes[old->second];
                if (prior.departure>next.departure || (prior.departure==next.departure &&
                    (prior.cost<next.cost-kEps ||
                     (std::fabs(prior.cost-next.cost)<=kEps && prior.turns<=next.turns)))) continue;
            }
            if (!check.Edge(n.pos, next.mid, time, time + duration) ||
                !check.Edge(next.mid, next.pos, time + duration, time + step)) continue;
            const int ni = static_cast<int>(nodes.size());
            nodes.push_back(next); best[nextKey] = ni;
            // An anytime result is safe even if optimizing it later exhausts the
            // budget. Retain only fully checked paths with a safe terminal dwell.
            if(goalBetter(next) && check.Tail(next.pos,time+step)) goal=ni;
            // Quantize only the priority cost, avoiding floating-point direction
            // roundoff defeating latest-departure tie breaking.
            open.push({std::round(next.cost * 10000.f) / 10000.f, next.departure, next.turns, ni});
        }
    }
    if (goal < 0) {
        if(seed.count>0 && Describe(in,seed,check,out)) {
            state.plan=seed; state.valid=true; out.reason=Reason::None; return;
        }
        out.status = out.budgetHit ? Status::Incomplete : Status::NoPlan;
        out.reason=out.budgetHit?Reason::SearchBudget:Reason::NoRoute; return;
    }
    Plan plan{}; plan.epochMs = in.nowMs; plan.speed = in.world.speed; plan.nominal = in.nominal;
    plan.intervention = nodes[goal].cost; plan.departureMs = nodes[goal].departure;
    std::vector<int> chain;
    for (int i = goal; nodes[i].parent >= 0; i = nodes[i].parent) chain.push_back(i);
    std::reverse(chain.begin(), chain.end());
    plan.points[plan.count++] = {in.world.player, 0.f};
    if (lead > 0.f) plan.points[plan.count++] = {start, lead};
    for (int i : chain) {
        const auto& n = nodes[i]; const float time = lead + (n.layer - 1) * step;
        plan.points[plan.count++] = {n.mid, time + n.motionMs};
        if (n.motionMs < step) plan.points[plan.count++] = {n.pos, time + step};
    }
    plan.points[plan.count++] = {Add(nodes[goal].pos, Mul(in.nominal,
        in.settings.horizonMs - lead - nodes[goal].layer * step)), in.settings.horizonMs};
    if (!ValidateWith(in, plan, check)) { out.status = Status::Incomplete; out.reason=Reason::RouteBlocked; return; }
    // A budget-limited search can find an early safe route before exploring its
    // later equivalent. Reserve time to postpone that complete route as well.
    if(!Core::EnemyBlocked(in.world,in.world.player)) {
        const Plan original=plan;
        for(float delay=std::floor((in.settings.horizonMs-lead)/step)*step;delay>=step;delay-=step) {
            if(in.settings.maxSearchMs>0.f && std::chrono::duration<float,std::milli>(
                std::chrono::steady_clock::now()-searchStart).count()>in.settings.maxSearchMs) break;
            Plan candidate{};
            if(DelayPlan(in,original,delay,candidate) && ValidateWith(in,candidate,check)) {
                plan=candidate; break;
            }
        }
    }
    out.reason=Reason::None;
    if(Describe(in, plan, check, out)) { state.plan = plan; state.valid = true; }
    else if(seed.count>0 && Describe(in,seed,check,out)) {
        // A turn spanning the native frame can invalidate the fine search's
        // command chord. Preserve the independently executable seed.
        state.plan=seed; state.valid=true; out.reason=Reason::None;
    }
}

namespace {
struct Risk {
    float damage=0.f,exposure=0.f;
    int hits=0;
    bool valid=true,unknown=false;
};

Risk MeasureRisk(const Input& in,const Check& check,const Plan& plan,float unknownDamage) {
    Risk risk{};
    if(Core::EnemyBlocked(in.world,plan.points[plan.count-1].pos)) { risk.valid=false; return risk; }
    for(int j=1;j<plan.count;j++) {
        const auto a=plan.points[j-1],b=plan.points[j];
        if(!OccupancyPathClear(in.world,a.pos,b.pos) || !EnemyPathClear(in.world,a.pos,b.pos)) {
            risk.valid=false; return risk;
        }
    }
    const auto zoneExposure=[&](Vec2 center,float radius,float start,float end) {
        float exposure=0.f;
        for(float t=std::max(0.f,start);t<std::min(end,in.settings.horizonMs);t+=10.f) {
            const float next=std::min(t+10.f,std::min(end,in.settings.horizonMs));
            const Vec2 a=Sub(PositionAt(plan,t),center),b=Sub(PositionAt(plan,next),center);
            if(MinDistOnSegment(a.x,a.y,b.x,b.y)<=radius) exposure+=next-t;
        }
        return exposure;
    };
    for(int i=0;i<in.world.map->laneCount;i++) {
        if(!check.bounds[i].relevant) continue;
        const auto& lane=in.world.map->lanes[i]; bool touched=false; float residence=0.f;
        for(int j=1;j<plan.count;j++) {
            const auto a=plan.points[j-1],b=plan.points[j];
            if(!check.Bullets(a.pos,b.pos,a.timeMs,b.timeMs,i,lane.beam?nullptr:&residence)) {
                touched=true;
            }
        }
        if(touched) {
            // Ordinary contact entry/exit supplies exact residence in the same
            // continuous pass. Do not scan 80 extra time bins per hit bullet.
            risk.exposure+=residence;
            // Beam capsules retain their existing bounded residence estimate.
            const float until=std::min(in.settings.horizonMs,check.bounds[i].expiry);
            for(float t=0.f;lane.beam && t<until;t+=10.f) {
                const float end=std::min(t+10.f,until);
                if(!check.Bullets(PositionAt(plan,t),PositionAt(plan,end),t,end,i)) risk.exposure+=end-t;
            }
            const bool known=std::isfinite(lane.damageEstimate) && lane.damageEstimate>0.f;
            risk.damage+=known?lane.damageEstimate:unknownDamage;
            risk.unknown=risk.unknown || !known; ++risk.hits;
        }
    }
    for(int i=0;i<in.zoneCount;i++) {
        const auto& z=in.zones[i]; bool touched=false;
        for(int j=1;j<plan.count;j++) {
            const auto a=plan.points[j-1],b=plan.points[j];
            const float lo=std::max(a.timeMs,z.startsMs),hi=std::min(b.timeMs,z.endsMs);
            if(hi<lo) continue;
            const Vec2 p=Sub(PositionAt(plan,lo),z.center),q=Sub(PositionAt(plan,hi),z.center);
            if(MinDistOnSegment(p.x,p.y,q.x,q.y)<=z.radius) {
                touched=true;
            }
        }
        if(touched) {
            risk.damage+=unknownDamage; ++risk.hits; risk.unknown=true;
            risk.exposure+=zoneExposure(z.center,z.radius,z.startsMs,z.endsMs);
        }
    }
    // Non-timed active-zone captures are still real hazards.
    if(in.zoneCount==0) for(int i=0;i<in.world.map->zoneCount;i++) {
        const auto& z=in.world.map->zones[i]; if(!z.active) continue;
        bool touched=false;
        for(int j=1;j<plan.count;j++) {
            const Vec2 a=Sub(plan.points[j-1].pos,z.pos),b=Sub(plan.points[j].pos,z.pos);
            if(MinDistOnSegment(a.x,a.y,b.x,b.y)<=z.radius) {
                touched=true;
            }
        }
        if(touched) {
            risk.damage+=unknownDamage; ++risk.hits; risk.unknown=true;
            risk.exposure+=zoneExposure(z.pos,z.radius,0.f,in.settings.horizonMs);
        }
    }
    return risk;
}

void Recover(const Input& in,State& state,Output& out,Vec2 priorDirection) {
    Check check(in);
    float unknownDamage=1000.f;
    for(int i=0;i<in.world.map->laneCount;i++) {
        const float known=in.world.map->lanes[i].damageEstimate;
        if(std::isfinite(known)) unknownDamage=std::max(unknownDamage,known+1.f);
    }
    Plan best{}; best.epochMs=in.nowMs; best.speed=in.world.speed; best.nominal=in.nominal;
    best.points[best.count++]={in.world.player,0.f};
    best.points[best.count++]={Add(in.world.player,Mul(in.nominal,in.settings.horizonMs)),in.settings.horizonMs};
    Risk bestRisk=MeasureRisk(in,check,best,unknownDamage);
    bool found=bestRisk.valid;
    // A stationary hold can span the prediction window without consuming the
    // movement distance budget.
    // Seed the unrestricted hold only when this command needs intervention;
    // otherwise its long stationary tail would force an unnecessarily early stop.
    if(LenSq(in.nominal)>1e-12f && !check.Edge(in.world.player,
        Add(in.world.player,Mul(in.nominal,in.settings.leadMs+in.frameMs)),0.f,
        in.settings.leadMs+in.frameMs) && (in.actuationMs==0.f ||
        (in.actuationMs>=in.settings.stepMs && Len(in.nominal)<=
            (in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed)+kEps))) {
        Plan halt{}; halt.epochMs=in.nowMs; halt.speed=in.world.speed; halt.nominal=in.nominal;
        halt.departureMs=in.settings.leadMs;
        halt.points[halt.count++]={in.world.player,0.f};
        const Vec2 stopped=Add(in.world.player,Mul(in.nominal,in.settings.leadMs));
        if(in.settings.leadMs>0.f) halt.points[halt.count++]={stopped,in.settings.leadMs};
        halt.points[halt.count++]={stopped,in.settings.horizonMs};
        const Risk risk=MeasureRisk(in,check,halt,unknownDamage);
        if(risk.valid && (!bestRisk.valid || risk.damage<bestRisk.damage-kEps ||
            (std::fabs(risk.damage-bestRisk.damage)<=kEps && risk.exposure<bestRisk.exposure-.01f))) {
            best=halt; bestRisk=risk; found=true;
        }
    }
    const float step=in.settings.stepMs,lead=in.settings.leadMs;
    const int layers=std::min((kMaxPlanPoints-4)/2,static_cast<int>((in.settings.horizonMs-lead)/step));
    const auto begin=std::chrono::steady_clock::now();
    // Compare every heading at short distances before spending the remaining
    // time on longer escapes. A deadline must not bias recovery to +X simply
    // because that heading appears first in the action list.
    std::array<Plan,17> candidates{};
    std::array<bool,17> stopped{};
    // Cover meaningful escape distances before refining every intermediate
    // stroke. Dense fields otherwise exhaust recovery on tiny moves which
    // all remain inside the same incoming wall of projectiles.
    for(int pass=0;pass<2;pass++) {
    candidates.fill(Plan{}); stopped.fill(false);
    for(int layer=0;layer<layers;layer++) for(int action=0;action<17;action++) {
        if(in.settings.recoveryBudgetMs>0.f && std::chrono::duration<float,std::milli>(
            std::chrono::steady_clock::now()-begin).count()>in.settings.recoveryBudgetMs*.75f) goto finished;
        if(stopped[action]) continue;
        const float angle=kTwoPi*(action-1)/16.f;
        const Vec2 velocity=action==0?Vec2{}:Vec2{std::cos(angle)*in.world.speed,std::sin(angle)*in.world.speed};
        const float correction=Len(Sub(velocity,in.nominal));
        if(correction<1e-6f || (in.actuationMs>0.f && correction>
            (in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed)+kEps)) continue;
        Plan& p=candidates[action];
        if(layer==0) {
            p.epochMs=in.nowMs; p.speed=in.world.speed; p.nominal=in.nominal; p.departureMs=lead;
            p.points[p.count++]={in.world.player,0.f};
            if(lead>0.f) p.points[p.count++]={Add(in.world.player,Mul(in.nominal,lead)),lead};
        }
        Vec2 pos=p.points[p.count-1].pos;
        const float time=lead+layer*step;
        const float duration=in.actuationMs>0.f?std::min(step,in.actuationMs):step;
        const Vec2 mid=Add(pos,Mul(velocity,duration)),end=Add(mid,Mul(in.nominal,step-duration));
        p.intervention+=correction*duration;
        if(p.intervention>in.settings.maxDistance || p.count+3>=kMaxPlanPoints) { stopped[action]=true; continue; }
        if(!OccupancyPathClear(in.world,pos,mid) || !OccupancyPathClear(in.world,mid,end) ||
           !EnemyPathClear(in.world,pos,mid) || !EnemyPathClear(in.world,mid,end)) { stopped[action]=true; continue; }
        p.points[p.count++]={mid,time+duration};
        if(duration<step) p.points[p.count++]={end,time+step};
        pos=end;
        const bool coarse=layer==0 || layer==2 || layer==5 || layer==11 || layer==23 || layer==layers-1;
        if((pass==0)!=coarse) continue;
        const int count=p.count;
        p.points[p.count++]={Add(pos,Mul(in.nominal,in.settings.horizonMs-time-step)),in.settings.horizonMs};
        // The host issues a single chord for this render interval. Score
        // that exact first slice, including when it spans a short stroke.
        Plan executable=p;
        const float commandEnd=std::min(lead+in.frameMs,in.settings.horizonMs);
        const Vec2 commandTarget=PositionAt(p,commandEnd);
        int countBefore=0;
        while(countBefore<executable.count && executable.points[countBefore].timeMs<=lead) ++countBefore;
        executable.count=countBefore;
        executable.points[executable.count++]={commandTarget,commandEnd};
        for(int j=countBefore;j<p.count;j++) if(p.points[j].timeMs>commandEnd)
            executable.points[executable.count++]=p.points[j];
        ++out.diagnostics.recoveryCandidates;
        const Risk risk=MeasureRisk(in,check,executable,unknownDamage);
        const Vec2 direction=Normalize(Sub(velocity,in.nominal));
        const Vec2 bestDirection=Normalize(Sub(PositionAt(best,lead+in.frameMs),PositionAt(best,lead)));
        const bool better=risk.valid && (!bestRisk.valid || risk.damage<bestRisk.damage-kEps ||
            (std::fabs(risk.damage-bestRisk.damage)<=kEps &&
             (risk.exposure<bestRisk.exposure-.01f ||
              (std::fabs(risk.exposure-bestRisk.exposure)<=.01f &&
               (p.intervention<best.intervention-kEps ||
                (std::fabs(p.intervention-best.intervention)<=kEps && Dot(direction,priorDirection)>Dot(bestDirection,priorDirection)))))));
        if(better) { best=executable; bestRisk=risk; found=true; }
        p.count=count;
    }
    }
finished:
    if(!found) return;
    // A recovery search finding a distant problem does not authorize moving
    // immediately. Postpone its complete correction when doing so adds no
    // damage or exposure. Existing enemy overlap still requires immediate exit.
    if(!Core::EnemyBlocked(in.world,in.world.player)) {
        const Plan original=best;
        for(float delay=std::floor((in.settings.horizonMs-lead)/step)*step;delay>=step;delay-=step) {
            if(in.settings.recoveryBudgetMs>0.f && std::chrono::duration<float,std::milli>(
                std::chrono::steady_clock::now()-begin).count()>in.settings.recoveryBudgetMs) break;
            Plan candidate{};
            if(!DelayPlan(in,original,delay,candidate)) continue;
            const Risk risk=MeasureRisk(in,check,candidate,unknownDamage);
            if(risk.valid && risk.damage<=bestRisk.damage+kEps && risk.hits<=bestRisk.hits &&
                risk.exposure<=bestRisk.exposure+.01f && (!risk.unknown || bestRisk.unknown)) {
                best=candidate; bestRisk=risk; break;
            }
        }
    }
    out.plan=best; out.waitMs=std::max(0.f,best.departureMs-lead);
    out.velocity=Mul(Sub(PositionAt(best,lead+in.frameMs),PositionAt(best,lead)),1.f/in.frameMs);
    out.status=bestRisk.hits?Status::Recovery:
        Len(Sub(out.velocity,in.nominal))>1e-6f?Status::Moving:Status::Waiting;
    if(!bestRisk.hits) out.reason=Reason::None;
    out.estimatedDamage=bestRisk.damage; out.expectedHits=bestRisk.hits; out.unknownDamage=bestRisk.unknown;
    state.plan=best; state.valid=true;
}
}

bool ProtectImmediateStep(const Input& in,Output& out,bool retainControl) {
    if((out.status!=Status::NoPlan && out.status!=Status::Incomplete) || !ValidInput(in) ||
       in.world.movementLocked || in.world.speed<=0.f ||
       (in.actuationMs>0.f && in.actuationMs<in.settings.stepMs)) return false;
    const float lead=in.settings.leadMs,end=lead+in.frameMs;
    const Vec2 start=Add(in.world.player,Mul(in.nominal,lead));
    Check full(in);
    // Acquiring control is driven by contact, not a distant threat. An owner
    // whose route failed must select a new command rather than leak raw keys.
    if(!retainControl && full.Edge(start,Add(start,Mul(in.nominal,in.frameMs)),lead,end)) return false;
    Input prefix=in;
    prefix.settings.horizonMs=std::min(in.settings.horizonMs,end+std::max(20.f,in.frameMs));
    prefix.settings.dwellMs=0.f;
    Check check(prefix);
    float unknownDamage=1000.f;
    for(int i=0;i<in.world.map->laneCount;i++)
        if(std::isfinite(in.world.map->lanes[i].damageEstimate))
            unknownDamage=std::max(unknownDamage,in.world.map->lanes[i].damageEstimate+1.f);
    bool found=false; Risk bestRisk{}; float bestCost=0.f; Vec2 best{}; Plan bestPlan{};
    // Include the exact requested direction, a hold, and full-speed headings.
    // Compare contact even when already overlapping; an existing hit must not
    // disable protection against the next bullet. Never enlarge hitboxes.
    for(int action=0;action<18;action++) {
        const float angle=6.28318530718f*(action-2)/16.f;
        const Vec2 v=action==0?in.nominal:action==1?Vec2{}:
            Vec2{std::cos(angle)*in.world.speed,std::sin(angle)*in.world.speed};
        if(in.actuationMs>0.f && Len(Sub(v,in.nominal))>
            (in.maxCorrectionSpeed>0.f?in.maxCorrectionSpeed:in.world.speed)+kEps) continue;
        Plan plan{}; plan.epochMs=in.nowMs; plan.speed=in.world.speed; plan.nominal=in.nominal;
        plan.departureMs=lead; plan.points[plan.count++]={in.world.player,0.f};
        if(lead>0.f) plan.points[plan.count++]={start,lead};
        plan.points[plan.count++]={Add(start,Mul(v,prefix.settings.horizonMs-lead)),prefix.settings.horizonMs};
        const Risk risk=MeasureRisk(prefix,check,plan,unknownDamage);
        if(!risk.valid) continue;
        const float cost=Len(Sub(v,in.nominal))+(retainControl?Len(Sub(v,out.velocity)):0.f);
        if(!found || risk.damage<bestRisk.damage-kEps ||
           (std::fabs(risk.damage-bestRisk.damage)<=kEps &&
            (risk.exposure<bestRisk.exposure-.01f ||
             (std::fabs(risk.exposure-bestRisk.exposure)<=.01f && cost<bestCost)))) {
            found=true; best=v; bestRisk=risk; bestCost=cost; bestPlan=plan;
        }
    }
    if(!found) {
        // No physically admissible step exists. Hold instead of pushing raw
        // input into a wall/body; this is not advertised as a safe route.
        best={}; bestPlan={}; bestPlan.epochMs=in.nowMs; bestPlan.speed=in.world.speed;
        bestPlan.nominal=in.nominal; bestPlan.count=2;
        bestPlan.points[0]={in.world.player,0.f}; bestPlan.points[1]={in.world.player,end};
    }
    out.velocity=best; out.plan=bestPlan; out.status=Status::Recovery;
    out.reason=Reason::CommandBlocked; out.waitMs=0.f; out.reused=false;
    out.estimatedDamage=bestRisk.damage; out.expectedHits=bestRisk.hits;
    out.unknownDamage=true; // only this finite prefix was evaluated
    return true;
}

namespace {
// A single timed search scores complete continuations, including their final
// dwell. Waypoints are guidance; neither they nor recovery own an actuator.
void EvaluateGuided(const Input& in,State& state,Output& out) {
    const auto began=std::chrono::steady_clock::now();
    out={}; out.velocity=in.nominal;
    if(!ValidInput(in) || in.guidance.count<=0 || in.guidance.count>128) {
        state.Reset(); out.reason=Reason::InvalidInput; return;
    }
    for(int i=0;i<in.guidance.count;i++) if(!std::isfinite(in.guidance.points[i].x) ||
        !std::isfinite(in.guidance.points[i].y)) { state.Reset(); out.reason=Reason::InvalidInput; return; }
    if(in.world.movementLocked || in.world.speed<=0.f) {
        state.Reset(); out.status=Status::Locked; out.velocity={}; return;
    }
    Check check(in,in.collectDiagnostics?&out.diagnostics:nullptr);
    const float lead=in.settings.leadMs,horizon=in.settings.horizonMs;
    const float step=std::max(in.settings.stepMs,in.frameMs);
    const Vec2 destination=in.guidance.points[in.guidance.count-1];
    const Vec2 desired=in.guidance.manual?Normalize(in.nominal):
        Normalize(Sub(in.guidance.points[0],in.world.player));
    const auto remaining=[&](Vec2 p,int next) {
        float distance=next<in.guidance.count?Len(Sub(in.guidance.points[next],p)):0.f;
        for(int i=next+1;i<in.guidance.count;i++) distance+=Len(Sub(in.guidance.points[i],in.guidance.points[i-1]));
        return distance;
    };
    const auto expired=[&] { return in.settings.maxSearchMs>0.f &&
        std::chrono::duration<float,std::milli>(std::chrono::steady_clock::now()-began).count()>=in.settings.maxSearchMs; };
    float unknownDamage=1000.f;
    for(int i=0;i<in.world.map->laneCount;i++) if(std::isfinite(in.world.map->lanes[i].damageEstimate))
        unknownDamage=std::max(unknownDamage,in.world.map->lanes[i].damageEstimate+1.f);
    Plan chosen{}; Risk chosenRisk{}; float chosenRemaining=1e9f,chosenLength=1e9f,chosenArrival=1e9f,chosenIdle=1e9f,chosenReverse=1e9f;
    bool found=false,safeFound=false;
    const auto publish=[&](const Plan& plan,bool reused,const Risk& risk) {
        Output described{};
        if(!risk.hits && ValidateWith(in,plan,check) && Describe(in,plan,check,described)) {
            out.plan=plan; out.velocity=described.velocity; out.waitMs=described.waitMs;
            out.status=described.status; out.reason=Reason::None;
        } else {
            out.plan=plan; out.waitMs=std::max(0.f,plan.departureMs-lead);
            out.velocity=Mul(Sub(PositionAt(plan,lead+in.frameMs),PositionAt(plan,lead)),1.f/in.frameMs);
            out.status=Status::Recovery; out.reason=Reason::NoRoute;
        }
        out.reused=reused; out.estimatedDamage=risk.damage; out.expectedHits=risk.hits; out.unknownDamage=risk.unknown;
        state.plan=out.plan; state.valid=true; state.goalIdentity=in.guidance.identity; state.goal=destination;
    };
    const auto consider=[&](Plan plan,int next) {
        if(plan.count<2) return false;
        plan.departureMs=horizon;
        for(int i=1;i<plan.count;i++) if(Len(Sub(Sub(plan.points[i].pos,plan.points[i-1].pos),
            Mul(in.nominal,plan.points[i].timeMs-plan.points[i-1].timeMs)))>1e-5f) {
            plan.departureMs=plan.points[i-1].timeMs; break;
        }
        // Evaluate exactly the single chord the host can execute this update.
        const float commandEnd=lead+in.frameMs;
        Plan executable{}; executable=plan; executable.count=0;
        executable.points[executable.count++]={in.world.player,0.f};
        if(lead>0.f) executable.points[executable.count++]={Add(in.world.player,Mul(in.nominal,lead)),lead};
        executable.points[executable.count++]={PositionAt(plan,commandEnd),commandEnd};
        for(int i=1;i<plan.count;i++) if(plan.points[i].timeMs>commandEnd && executable.count<kMaxPlanPoints)
            executable.points[executable.count++]=plan.points[i];
        plan=executable;
        Output validated{};
        const bool safe=ValidateWith(in,plan,check) && Describe(in,plan,check,validated);
        Risk risk{};
        if(!safe) {
            if(safeFound) return false;
            risk=MeasureRisk(in,check,plan,unknownDamage);
            if(!risk.valid) return false;
            if(!risk.hits) { risk.hits=1; risk.damage=unknownDamage; risk.unknown=true; }
        }
        const Vec2 endpoint=plan.points[plan.count-1].pos;
        // A keyboard direction is not an arrival circle. Reward all projected
        // progress, including beyond the temporary navigation anchor. Otherwise
        // reaching that anchor and stopping ties with continuing through it.
        const float distance=in.guidance.manual?-Dot(Sub(endpoint,in.world.player),desired):remaining(endpoint,next);
        float length=0.f,arrival=0.f,idle=0.f,pendingIdle=0.f,reverse=0.f;
        for(int i=1;i<plan.count;i++) {
            const float d=Len(Sub(plan.points[i].pos,plan.points[i-1].pos));
            length+=d;
            reverse+=std::max(0.f,-Dot(Sub(plan.points[i].pos,plan.points[i-1].pos),desired));
            if(d>1e-6f) { arrival=plan.points[i].timeMs; idle+=pendingIdle; pendingIdle=0.f; }
            else pendingIdle+=plan.points[i].timeMs-plan.points[i-1].timeMs;
        }
        const bool better=!found || (safe && !safeFound) ||
            (safe==safeFound && (risk.damage<chosenRisk.damage-kEps ||
             (std::fabs(risk.damage-chosenRisk.damage)<=kEps &&
              (risk.exposure<chosenRisk.exposure-.01f || (std::fabs(risk.exposure-chosenRisk.exposure)<=.01f &&
               (distance<chosenRemaining-.005f || (std::fabs(distance-chosenRemaining)<=.005f &&
                (reverse<chosenReverse-.005f || (std::fabs(reverse-chosenReverse)<=.005f &&
                 (idle<chosenIdle-.01f || (std::fabs(idle-chosenIdle)<=.01f &&
                  (arrival<chosenArrival-.01f || (std::fabs(arrival-chosenArrival)<=.01f && length<chosenLength)))))))))))));
        if(better) { chosen=plan; chosenRisk=risk; chosenRemaining=distance; chosenLength=length;
            chosenArrival=arrival; chosenIdle=idle; chosenReverse=reverse; found=true; safeFound=safe; }
        return safe;
    };
    const auto finish=[&](Plan plan,Vec2 position,float time,int next,bool follow) {
        const float end=std::max(time,horizon-(in.guidance.manual?0.f:in.settings.dwellMs));
        if(follow) while(next<in.guidance.count && time<end && plan.count<kMaxPlanPoints-2) {
            const Vec2 delta=Sub(in.guidance.points[next],position);
            const float distance=Len(delta);
            if(distance<1e-5f) { ++next; continue; }
            const float duration=std::min(distance/in.world.speed,end-time);
            position=Add(position,Mul(Normalize(delta),in.world.speed*duration)); time+=duration;
            plan.points[plan.count++]={position,time};
            if(duration>=distance/in.world.speed-.001f) ++next;
        }
        if(plan.count>=kMaxPlanPoints) return false;
        if(follow && in.guidance.manual && next>=in.guidance.count)
            position=Add(position,Mul(in.nominal,horizon-time));
        plan.points[plan.count++]={position,horizon};
        return consider(plan,next);
    };
    Plan root{}; root.epochMs=in.nowMs; root.speed=in.world.speed; root.nominal=in.nominal;
    root.departureMs=lead; root.points[root.count++]={in.world.player,0.f};
    const Vec2 start=Add(in.world.player,Mul(in.nominal,lead));
    if(lead>0.f) root.points[root.count++]={start,lead};
    // Following the requested route is optimal when its whole continuation is
    // safe. This also prevents a cached escape from blocking a safe retreat.
    if(state.valid && (state.goalIdentity==0 ||
        (state.goalIdentity==in.guidance.identity && Len(Sub(state.goal,destination))<.35f))) {
        Output retained{};
        bool pendingProgress=false;
        const float age=static_cast<float>(in.nowMs-state.plan.epochMs);
        for(int i=1;i<state.plan.count;i++) if(state.plan.points[i].timeMs>age &&
            LenSq(Sub(state.plan.points[i].pos,state.plan.points[i-1].pos))>1e-10f) pendingProgress=true;
        if(ValidateWith(in,state.plan,check) && Describe(in,state.plan,check,retained) && (Len(retained.velocity)>1e-6f ||
            (state.goalIdentity!=0 && (retained.waitMs>0.f || pendingProgress)))) {
            // A safe complete forward continuation can end a hold immediately.
            // Keep absolute deadlines when the opening still requires waiting.
            if(Len(retained.velocity)<=1e-6f && finish(root,start,lead,0,true)) {
                publish(chosen,false,chosenRisk); return;
            }
            out=retained; out.reused=true; return;
        }
    }
    if(finish(root,start,lead,0,true)) { publish(chosen,false,chosenRisk); return; }
    finish(root,start,lead,0,false);
    // Cheap complete escape shapes seed the same candidate comparison. They
    // do not own movement or bypass the requested-direction objective.
    Plan seed{};
    if(in.expandedForZones && WideZoneEscape(in,check,seed)) consider(seed,0);
    seed={}; QuickEscape(in,check,seed);
    if(seed.count>0) { consider(seed,0); out.diagnostics.seedAvailable=true; }
    const bool initiallySafe=check.Edge(start,start,lead,lead);
    struct SearchNode { Vec2 position{}; int parent=-1,next=0,layer=0; float cost=0.f; };
    std::vector<SearchNode> nodes; nodes.reserve(4096); nodes.push_back({start,-1,0,0,0.f});
    std::vector<int> frontier{0};
    const int layers=std::min((kMaxPlanPoints-4)/2,static_cast<int>((horizon-lead-in.settings.dwellMs)/step));
    const auto prefix=[&](int index) {
        Plan p=root; std::vector<int> chain;
        for(int i=index;nodes[i].parent>=0;i=nodes[i].parent) chain.push_back(i);
        for(auto i=chain.rbegin();i!=chain.rend();++i)
            p.points[p.count++]={nodes[*i].position,lead+nodes[*i].layer*step};
        // Departure means deviation from intended movement, not the first
        // waypoint. Retained absolute times do not slide as frames advance.
        p.departureMs=horizon;
        for(int i=1;i<p.count;i++) if(Len(Sub(Sub(p.points[i].pos,p.points[i-1].pos),
            Mul(in.nominal,p.points[i].timeMs-p.points[i-1].timeMs)))>1e-5f) {
            p.departureMs=p.points[i-1].timeMs; break;
        }
        return p;
    };
    for(int layer=0;layer<layers && !frontier.empty();layer++) {
        std::vector<int> nextFrontier;
        for(int index:frontier) {
            const SearchNode n=nodes[index]; const float time=lead+layer*step;
            if(out.expansions++>=in.settings.maxExpansions || expired()) { out.budgetHit=true; goto complete; }
            const Vec2 forward=n.next<in.guidance.count?Normalize(Sub(in.guidance.points[n.next],n.position)):Vec2{};
            for(int action=0;action<18;action++) {
                // Search relative to the requested route first. Fixed world-axis
                // ordering exhausted short budgets before some forward diagonals.
                const int offset=(action-1)/2*(action%2==0?1:-1);
                const float angle=std::atan2(forward.y,forward.x)+kTwoPi*offset/16.f;
                Vec2 velocity=action==0?Mul(forward,in.world.speed):action==1?Vec2{}:
                    Vec2{std::cos(angle)*in.world.speed,std::sin(angle)*in.world.speed};
                Vec2 destinationStep=Add(n.position,Mul(velocity,step));
                if(action==0 && n.next<in.guidance.count && Len(Sub(in.guidance.points[n.next],n.position))<in.world.speed*step)
                    destinationStep=in.guidance.points[n.next];
                const float correction=Len(Sub(Sub(destinationStep,n.position),Mul(in.nominal,step)));
                // The distance setting limits deviation, not ordinary progress
                // along a dungeon route or the duration of a necessary hold.
                const float extra=action<=1?0.f:
                    Len(Sub(Sub(destinationStep,n.position),Mul(forward,in.world.speed*step)));
                if(action>1 && n.cost+extra>in.settings.maxDistance) continue;
                if(!OccupancyPathClear(in.world,n.position,destinationStep) || !EnemyPathClear(in.world,n.position,destinationStep)) continue;
                const bool edgeSafe=check.Edge(n.position,destinationStep,time,time+step);
                if((safeFound || initiallySafe) && !edgeSafe) continue;
                int next=n.next;
                while(next<in.guidance.count && Len(Sub(destinationStep,in.guidance.points[next]))<.005f) ++next;
                const int id=static_cast<int>(nodes.size());
                nodes.push_back({destinationStep,index,next,layer+1,n.cost+extra});
                Plan p=prefix(id); p.intervention=n.cost+correction;
                const bool continuation=finish(p,destinationStep,time+step,next,true);
                // A distant blocked continuation need not prohibit getting
                // closer now. Compare advancing to a safe stop against holding
                // here, even when a stationary safe incumbent already exists.
                if(!continuation || action==1) finish(p,destinationStep,time+step,next,false);
                nextFrontier.push_back(id);
                if(expired() || nodes.size()>=kMaxNodes) { out.budgetHit=true; goto complete; }
            }
        }
        std::sort(nextFrontier.begin(),nextFrontier.end(),[&](int a,int b) {
            return remaining(nodes[a].position,nodes[a].next)+nodes[a].cost*.05f <
                remaining(nodes[b].position,nodes[b].next)+nodes[b].cost*.05f;
        });
        frontier.clear();
        for(int id:nextFrontier) {
            bool duplicate=false;
            for(int kept:frontier) if(nodes[id].next==nodes[kept].next && Len(Sub(nodes[id].position,nodes[kept].position))<.015f) { duplicate=true; break; }
            if(!duplicate) frontier.push_back(id);
            if(frontier.size()>=24) break;
        }
    }
complete:
    if(!found) { state.Reset(); out.status=Status::NoPlan; out.reason=Reason::NoRoute; return; }
    if(safeFound && in.guidance.manual && LenSq(in.nominal)>1e-12f) {
        const Plan original=chosen;
        for(float delay=std::floor((horizon-lead)/step)*step;delay>=step;delay-=step) {
            if(expired()) break;
            Plan candidate{};
            candidate=original; candidate.count=0; candidate.departureMs+=delay;
            const Vec2 shift=Mul(in.nominal,delay);
            candidate.points[candidate.count++]={in.world.player,0.f};
            candidate.points[candidate.count++]={Add(in.world.player,shift),delay};
            for(int i=1;i<original.count && candidate.count<kMaxPlanPoints-1;i++)
                if(original.points[i].timeMs+delay<horizon)
                    candidate.points[candidate.count++]={Add(original.points[i].pos,shift),original.points[i].timeMs+delay};
            candidate.points[candidate.count++]={Add(PositionAt(original,horizon-delay),shift),horizon};
            if(Validate(in,candidate)) { chosen=candidate; break; }
        }
    }
    publish(chosen,false,chosenRisk);
}
}

void Evaluate(const Input& in,State& state,Output& out) {
    if(in.guidance.manual && !in.settings.avoidHarmlessBlocks && KeyboardIntentSafe(in)) {
        state.Reset(); out={}; out.status=Status::Clear; out.velocity=in.nominal; return;
    }
    if(in.guidance.active) { EvaluateGuided(in,state,out); return; }

    Vec2 prior{};
    if(state.valid) prior=Normalize(Sub(PositionAt(state.plan,static_cast<float>(in.nowMs-state.plan.epochMs)+in.frameMs),in.world.player));
    EvaluateSafe(in,state,out);
    if((out.status==Status::NoPlan || out.status==Status::Incomplete) && ValidInput(in) &&
       in.world.speed>0.f && !in.world.movementLocked && in.settings.maxExpansions>0)
        Recover(in,state,out,prior);
}

const char* StatusName(Status s) {
    switch (s) {
    case Status::Clear: return "Clear - preserving input";
    case Status::Waiting: return "Waiting for departure";
    case Status::Moving: return "Dodging";
    case Status::Recovery: return "Recovery / limited safe plan";
    case Status::NoPlan: return "No safe route found";
    case Status::Incomplete: return "Incomplete prediction/search";
    case Status::Locked: return "Movement restricted";
    }
    return "Unknown";
}
const char* ReasonName(Reason r) {
    switch(r) {
    case Reason::None:return "none";
    case Reason::MissingMap:return "no sensor snapshot";
    case Reason::CaptureUnavailable:return "projectile capture unavailable";
    case Reason::Truncated:return "snapshot capacity exceeded";
    case Reason::InvalidInput:return "invalid speed/geometry/timing";
    case Reason::SpeedChanged:return "live speed changed";
    case Reason::IntentChanged:return "keyboard intent changed";
    case Reason::PositionDrift:return "player diverged from route";
    case Reason::RouteBlocked:return "route no longer reachable/safe";
    case Reason::LeadBlocked:return "collision before next available command";
    case Reason::SearchBudget:return "search budget exhausted without escape";
    case Reason::NoRoute:return "no route within local horizon";
    case Reason::CommandBlocked:return "actual command chord is unsafe";
    }
    return "unknown";
}
}
