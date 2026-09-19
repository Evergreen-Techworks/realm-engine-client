#pragma once
// Contact — ONE projectile-vs-player rule, shared by udodge/, spacetime/ and the
// offline scenario harness. Plain data: no IL2CPP, no globals, no game headers,
// safe on the worker thread and in a host test.
//
// WHY THIS EXISTS (contact-model-study.md, 2026-09-18). For one aimed shot the
// layers believed half-widths of 0.2275, 0.2775, 0.4075 and 0.6075 tiles against
// a ground truth of 0.35: the timed planner departed on a box the solver's floor
// then refused, and an aimed triple 0.9 tiles apart read as one solid 3.0-tile
// wall. The game's own rule is PROVEN from 86ad651b:
//
//     |dx| <= R && |dy| <= R,  R = T * target.ObjectProperties.collisionRadiusMultiplier
//
// with T read from the projectile (+0x1D4) and the PLAYER A POINT — there is no
// player half anywhere in the binary. That rule is TruthHalf + Hit below.
//
// POLICY. `Policy::Tactician` routes every planning layer through this header;
// `Policy::Classic` keeps the pre-Slice-3 formulas byte for byte (the dashboard
// setting "Planner", feature command `udodgePlanner`). The policy is captured
// once at snapshot publish so one snapshot is planned under one policy.
#include <algorithm>
#include <cmath>

namespace Contact {

// udodgePlanner. Classic = every formula exactly as it was before Slice 3.
enum class Policy : unsigned char { Classic = 0, Tactician = 1 };

inline Policy PolicyFromText(const char* text)
{
    return (text && text[0] == 'c') ? Policy::Classic : Policy::Tactician;
}
inline const char* PolicyName(Policy p) { return p == Policy::Classic ? "classic" : "tactician"; }

// The runtime T accepted from a projectile (ProjectileRuntimeReader) tops out at
// 16 tiles; two planning sites still clamped at 2.5 and silently disagreed with
// every other layer about a big shot (S3.4 fixes both).
constexpr float kMaxHalfTiles = 16.f;
constexpr float kMinHalfTiles = 0.05f;

// Cross-track COMFORT over the true box. Not a timing term: timing moves a shot
// along its own velocity (see kAlongPadMs), never sideways.
constexpr float kComfortTiles = 0.10f;

// Along-track timing uncertainty: GetTickCount64 resolution (~15.6 ms) plus one
// 60 fps frame between solve and move (~16.7 ms), rounded up. Applied by
// stretching the shot ALONG its velocity, in both directions, never sideways.
constexpr float kAlongPadMs = 35.f;

// The game's box for one shot: its own threshold scaled by the LIVE
// collisionRadiusMultiplier of the local player (1.0 when unreadable or the
// collider offset is untrusted — the game default, and the larger box).
inline float TruthHalf(float T, float targetScale)
{
    return std::clamp(T, kMinHalfTiles, kMaxHalfTiles) * (targetScale > 0.f ? targetScale : 1.f);
}

// What every PLANNING layer measures against: the truth box plus cross-track
// comfort. Callers add their own preferences (kUDurablePocketMargin,
// kULatencyPad) as thresholds ON this number; they are not a second opinion
// about how big the shot is.
inline float PlanHalf(float T, float targetScale, float extraTiles = 0.f)
{
    return TruthHalf(T, targetScale) + kComfortTiles + (extraTiles > 0.f ? extraTiles : 0.f);
}

// The game's hit test (P1-P5): per-axis, non-strict, player a point.
inline bool Hit(float relX, float relY, float half)
{
    return std::fabs(relX) <= half && std::fabs(relY) <= half;
}

} // namespace Contact
