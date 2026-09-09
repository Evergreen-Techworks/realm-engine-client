#pragma once
#include "UDodgeTypes.h"
#include <cmath>

namespace UDodge {

// Fractional phase on a sampled trajectory. The sensors cache a curved shot's
// path at fixed sample times; the live shot is usually BETWEEN two samples.
// Snapping the anchor to the nearest sample and translating the whole polyline
// onto the live position shifts every future point by up to half a sample step
// in time and by the matching arc distance in space. Interpolating the phase
// instead keeps the rebased lane on the shot's true clock.
//
// Returns false (caller keeps the sample-snapped anchor) unless `time` lies in
// [times[0], times[count-1]) on a strictly increasing, finite clock. `index` is
// the segment start (times[index] <= time < times[index+1]) so the caller can
// continue the trace from index + 1.
inline bool FractionalPathAnchor(const float* times, const float* xs, const float* ys,
                                 int count, float time, int& index, Vec2& position)
{
    index = -1; position = {};
    if (count < 2 || !std::isfinite(time)) return false;
    if (!std::isfinite(times[0]) || time < times[0]) return false;
    for (int i = 0; i + 1 < count; ++i) {
        const float a = times[i], b = times[i + 1];
        if (!std::isfinite(a) || !std::isfinite(b) || b <= a) return false;   // clock must advance
        if (time < a || time >= b) continue;
        const float f = (time - a) / (b - a);
        position = { xs[i] + (xs[i + 1] - xs[i]) * f, ys[i] + (ys[i + 1] - ys[i]) * f };
        if (!std::isfinite(position.x) || !std::isfinite(position.y)) return false;
        index = i;
        return true;
    }
    return false;   // at or past the final sample: no forward segment
}

} // namespace UDodge
