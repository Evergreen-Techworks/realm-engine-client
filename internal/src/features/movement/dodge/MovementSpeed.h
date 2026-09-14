#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

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

// ── The speed the game itself moves the player at ───────────────────────────
// The game's MoveTo does NOT clamp distance (86ad651b LKHPPBEGNOM::DGLCONCOIBO:
// square lookup, position set, tile/collision update, return true). The step the
// dodge commands is therefore the speed the server sees, and it has to follow the
// game's own rules rather than the SPD curve alone.
//
// FKALGHJIADI::GAFGPNKFMOJ (the game's move speed, tiles per ms):
//   Slowed                  -> MIN_MOVE_SPEED (0.004) x square speed, SPD ignored
//   otherwise               -> lerp(0.004, 0.0096, SPD / 75)
//                              x 1.5 when Speedy or NinjaSpeedy
//                              x a per-player factor while condition bit 63 is set
//                              x square speed (CalcMoveSpeed, sinking included)
// Paralyzed, Stasis and Petrified stop movement in the move update itself.
//
// Condition bits, from the game's own mask table (the static constructor writing
// the masks the condition checks test): word 0 holds bits 0-31, word 1 holds bits
// 32 and up. IsSlowed tests word0 & 0x8, IsSpeedy word0 & 0x4000, IsNinjaSpeedy
// word0 & 0x10000000, and the bit-63 check word1 & 0x80000000.
constexpr uint32_t kCondSlowed      = 1u << 3;
constexpr uint32_t kCondParalyzed   = 1u << 13;
constexpr uint32_t kCondSpeedy      = 1u << 14;
constexpr uint32_t kCondStasis      = 1u << 21;
constexpr uint32_t kCondNinjaSpeedy = 1u << 28;
constexpr uint32_t kCond1Petrified  = 1u << (34 - 32);

constexpr int   kFallbackSpd       = 50;
constexpr float kSpeedyFactor      = 1.5f;
// Plausible band for the game's getter, in tiles per ms: MAX_MOVE_SPEED x Speedy
// x the fastest square is far below this; a tiles-per-second value is far above.
constexpr float kMaxGameTilesPerMs = 0.04f;

struct SpeedSample {
    int      clientSpd       = -1;             // server SPD (base + bonus); < 0 unknown
    float    tileMultiplier  = kUnknownSpeed;  // CalcMoveSpeed (GCFKGLKAPND); < 0 unknown
    bool     conditionsKnown = false;          // cond0 / cond1 were read from the live player
    uint32_t cond0 = 0, cond1 = 0;
    float    gameTilesPerMs  = kUnknownSpeed;  // the game's GAFGPNKFMOJ; < 0 unknown
};

// One effective speed (tiles/s) for every native mover and planner. The SPD curve
// with the conditions applied is the ceiling; the game's own getter, when it can be
// called, is authoritative below it, so anything slowing the player that this model
// does not name (sinking, the bit-63 factor, a forced speed) still applies. Speedy
// widens the ceiling only when the game's getter confirms it. Never negative.
inline float EffectiveTilesPerSec(const SpeedSample& s)
{
    const float tile = (std::isfinite(s.tileMultiplier) && s.tileMultiplier >= 0.f && s.tileMultiplier < 5.f)
        ? s.tileMultiplier : 1.f;
    if (s.conditionsKnown &&
        ((s.cond0 & (kCondParalyzed | kCondStasis)) != 0 || (s.cond1 & kCond1Petrified) != 0))
        return 0.f;
    const bool slowed = s.conditionsKnown && (s.cond0 & kCondSlowed) != 0;
    float model = ResolveTilesPerSec(slowed ? 0 : (s.clientSpd >= 0 ? s.clientSpd : kFallbackSpd), tile);
    if (model < 0.f) model = ResolveTilesPerSec(slowed ? 0 : kFallbackSpd, 1.f) * tile;

    const float game = s.gameTilesPerMs;
    if (std::isfinite(game) && game >= 0.f && game <= kMaxGameTilesPerMs) {
        const bool speedy = s.conditionsKnown && !slowed &&
                            (s.cond0 & (kCondSpeedy | kCondNinjaSpeedy)) != 0;
        return std::min(game * 1000.f, model * (speedy ? kSpeedyFactor : 1.f));
    }
    return model;
}
}
