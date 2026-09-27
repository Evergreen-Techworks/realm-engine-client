#pragma once

#include <cmath>
#include <cstdint>

namespace AutoNexusDodgePolicy {

constexpr uint64_t kStaleBudgetMs = 100ULL;

enum class ScanMode : uint8_t {
    Committed,
    Conservative,
};

struct SafetySample {
    bool enabled = false;
    bool exposed = false;
    uint32_t tickId = 0;
    float moveVx = 0.f;
    float moveVy = 0.f;
};

struct Decision {
    ScanMode mode = ScanMode::Conservative;
    float committedVx = 0.f;
    float committedVy = 0.f;
};

struct SelectedVelocities {
    float localVx = 0.f;
    float localVy = 0.f;
    float anchorVx = 0.f;
    float anchorVy = 0.f;
};

class Tracker {
public:
    Decision Evaluate(const SafetySample& sample, uint64_t nowMs)
    {
        if (!sample.enabled) {
            Reset();
            return {};
        }

        if (!seen_ || sample.tickId != lastTickId_ || nowMs < lastAdvanceMs_) {
            seen_ = true;
            lastTickId_ = sample.tickId;
            lastAdvanceMs_ = nowMs;
        }

        const bool fresh = nowMs - lastAdvanceMs_ <= kStaleBudgetMs;
        const bool finiteMotion = std::isfinite(sample.moveVx) && std::isfinite(sample.moveVy);
        if (!fresh || sample.exposed || !finiteMotion) return {};

        Decision out{};
        out.mode = ScanMode::Committed;
        out.committedVx = sample.moveVx;
        out.committedVy = sample.moveVy;
        return out;
    }

    void Reset()
    {
        seen_ = false;
        lastTickId_ = 0;
        lastAdvanceMs_ = 0;
    }

private:
    bool seen_ = false;
    uint32_t lastTickId_ = 0;
    uint64_t lastAdvanceMs_ = 0;
};

inline SelectedVelocities SelectVelocities(const Decision& decision,
                                           float observedVx, float observedVy)
{
    SelectedVelocities out{};
    if (decision.mode == ScanMode::Committed) {
        out.localVx = decision.committedVx;
        out.localVy = decision.committedVy;
        out.anchorVx = decision.committedVx;
        out.anchorVy = decision.committedVy;
    } else {
        out.localVx = observedVx;
        out.localVy = observedVy;
        // The conservative server anchor remains stationary, matching the
        // pre-dodge-aware backstop.
        out.anchorVx = 0.f;
        out.anchorVy = 0.f;
    }
    return out;
}

// Player tracks the projectile forecast scans. Only the live local track: the
// game client detects bullet collisions at its own position and reports them
// (PLAYERHIT). The last outbound MOVE point lags that position by up to a
// server tick; scanning it reported bullets crossing where the player had
// already been. Run 004614, 00:53:02Z: the MOVE point was 125 ms / 0.86 tiles
// behind, five Maze Minotaur bullets were "hitting" it in 14-114 ms, none hit
// and HP rose 558 -> 560 (recorded false escape at 91% HP).
struct Track {
    float x = 0.f, y = 0.f;
    float vx = 0.f, vy = 0.f;   // tiles per millisecond
};

struct ProjectileTrackSet {
    Track tracks[1];
    int   count = 0;
};

inline ProjectileTrackSet ProjectileTracks(const Track& local)
{
    ProjectileTrackSet out;
    out.tracks[0] = local;
    out.count = 1;
    return out;
}

} // namespace AutoNexusDodgePolicy

