#pragma once
#include <algorithm>
#include <cmath>

namespace DodgeRuntime {
// Negative is unavailable. Zero is a valid inability to move, never a fallback.
constexpr float kUnknownSpeed = -1.f;
inline float ResolveTilesPerSec(int clientSpd, float multiplier)
{
    if (!std::isfinite(multiplier) || multiplier < 0.f || multiplier >= 5.f)
        return kUnknownSpeed;
    if (multiplier == 0.f) return 0.f;
    if (clientSpd < 0) return kUnknownSpeed;
    const float spd = std::clamp(static_cast<float>(clientSpd), 0.f, 75.f);
    const float speed = (4.f + 5.6f * spd / 75.f) * multiplier;
    return speed <= 40.f ? speed : kUnknownSpeed;
}

inline float SpeedOrFallback(float speed, float fallback)
{
    return std::isfinite(speed) && speed >= 0.f ? speed : fallback;
}
}
