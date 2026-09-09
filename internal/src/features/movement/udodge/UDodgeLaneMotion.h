#pragma once
#include "UDodgeTypes.h"
#include <cmath>

namespace UDodge { namespace LaneMotion {

// Is this traced polyline VERIFIABLY a straight line travelled at constant
// speed, and if so at what velocity (tiles/ms)?
//
// The temporal layer normally refuses to say anything about a lane past the last
// sample its trace reached (the unknown-tail floor in UDodgeCore.cpp): freezing
// the bullet there would under-count danger and extrapolating a guess would paint
// ghost lanes. A shot whose OBSERVED samples are exactly collinear and evenly
// paced is the one case where continuing the line is a measurement rather than a
// guess, so a consumer may project it past the trace.
//
// Deliberately strict, because the whole value of the flag is that it cannot be
// wrong: any bend, any speed change, any non-advancing or non-finite sample
// answers false and the consumer falls back to the honest floor. Curved shot
// models and packet-time recovery lanes therefore never qualify.
inline bool DetectLinear(const Vec2* points, const float* timesMs, int count, Vec2& velocity)
{
    velocity = {};
    if (!points || !timesMs || count < 2) return false;
    for (int i = 0; i < count; ++i) {
        if (!std::isfinite(points[i].x) || !std::isfinite(points[i].y) ||
            !std::isfinite(timesMs[i])) return false;
        if (i && !(timesMs[i] > timesMs[i - 1])) return false;   // clock must advance
    }
    const float span = timesMs[count - 1] - timesMs[0];
    if (!(span > 0.f)) return false;
    const Vec2 v = Mul(Sub(points[count - 1], points[0]), 1.f / span);
    if (!std::isfinite(v.x) || !std::isfinite(v.y)) return false;
    // Every interior sample must sit on the constant-velocity line through the
    // endpoints. The tolerance is far below the hit geometry it feeds, so a shot
    // that merely LOOKS straight over a short trace cannot pass.
    for (int i = 1; i + 1 < count; ++i) {
        const Vec2 expected = Add(points[0], Mul(v, timesMs[i] - timesMs[0]));
        if (Len(Sub(points[i], expected)) > 0.002f) return false;
    }
    velocity = v;
    return true;
}

} } // namespace UDodge::LaneMotion
