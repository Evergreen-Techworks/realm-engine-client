#pragma once
#include "../udodge/UDodgeTypes.h"
#include <algorithm>
#include <cmath>

namespace SpacetimeDodge {
// Installed game's ordinary projectile test: |dx| < T && |dy| < T.
// Relative endpoints must describe the SAME time interval for player and shot.
// Slab clipping is continuous; fast shots cannot pass between samples.
inline bool SweptProjectileContact(UDodge::Vec2 a,UDodge::Vec2 b,float half,float* entry=nullptr,float* leave=nullptr) {
    if(!std::isfinite(half) || half<=0.f) return false;
    float lo=0.f,hi=1.f;
    const auto axis=[&](float start,float end) {
        const float delta=end-start;
        if(std::fabs(delta)<1e-12f) return std::fabs(start)<half;
        float u=(-half-start)/delta,v=(half-start)/delta;
        if(u>v) std::swap(u,v);
        lo=std::max(lo,u); hi=std::min(hi,v);
        return lo<hi;
    };
    if(!axis(a.x,b.x) || !axis(a.y,b.y)) return false;
    if(entry) *entry=lo;
    if(leave) *leave=hi;
    return true;
}
}
