#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>

// Capture rules shared by the runtime hooks and host-side regression tests.
namespace AoeCapturePolicy {
// SHOWEFFECT Throw: TargetObjectId identifies the thrower and Pos1 is the
// LANDING position. Pos2 is effect-specific auxiliary data (often absent or
// (0,0)) and is not the destination. Adopted from the Spacetime dodge (PR 60);
// the previous decode (pos1 = source, pos2 = landing, drop when pos2 absent)
// dropped bombs whose packet carried no pos2.
inline bool ThrowLanding(float p1x, float p1y, float& x, float& y)
{
    x = p1x; y = p1y;
    return std::isfinite(x) && std::isfinite(y);
}
// SHOWEFFECT duration field: <= 120 is seconds, otherwise already ms. Absent or
// out-of-range: a thrown bomb defaults to a 1.5 s flight, other effects to 2 s.
inline float ShowEffectDurationMs(float duration, bool thrown)
{
    if (std::isfinite(duration) && duration > 0.f && duration <= 120000.f)
        return duration <= 120.f ? duration * 1000.f : duration;
    return thrown ? 1500.f : 2000.f;
}
inline float DurationMs(float ms, float fallback = 3000.f)
{
    // Short flights are real. Replacing a 50 ms bomb with a 3 s countdown hides
    // the imminent blast from consumers that arm danger near the deadline.
    return std::isfinite(ms) && ms > 0.f && ms < 120000.f ? ms : fallback;
}

inline bool DecodePosition(int64_t packed, float& x, float& y)
{
    const uint64_t bits = static_cast<uint64_t>(packed);
    const uint32_t lo = static_cast<uint32_t>(bits);
    const uint32_t hi = static_cast<uint32_t>(bits >> 32);
    std::memcpy(&x, &lo, sizeof(x));
    std::memcpy(&y, &hi, sizeof(y));
    return std::isfinite(x) && std::isfinite(y);
}

// 0=unknown, 1=enemy, 2=friendly. Nearby objects cannot establish friendly
// ownership: a player or the throwable itself can overlap the enemy's origin.
inline int ResolveOwner(bool idIsOwner, int byId, int byPosition)
{
    if (idIsOwner && byId != 0) return byId;
    return byPosition == 1 ? 1 : 0;
}
}
