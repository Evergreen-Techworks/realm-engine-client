#pragma once
#include <algorithm>
#include <cmath>

namespace DodgeRuntime {

// ONE local-movement allowance per game update.
//
// The game's own update moves the local player from input, and the dodge then
// issues its own MoveTo inside the SAME update (DangerPlanner runs the dodge
// tick after the original update returns). Nothing previously reconciled the
// two, so a player holding a direction could travel a full frame from input
// plus a full frame from the dodge — up to twice their real speed for that
// frame. That breaks the contract the solver validated against: it planned a
// step of `speed × frameMs`, and something else happened.
//
// This is the accounting that makes the plan and the motion agree. An update
// gets an allowance equal to its own measured duration; native movement inside
// that update consumes it outright (never add on top of the game's own step);
// and the allowance is never banked across updates, so a hitch or a paused
// window cannot buy a teleport on the next frame.
//
// Pure data and arithmetic — no game types — so the policy is exercised by the
// host regression suite rather than only in-game.
struct MovementFrameBudget {
    // Longest single-update allowance (ms). A frame longer than this is a hitch
    // or a stall, not travel the player is owed.
    static constexpr float kMaxFrameMs = 50.f;

    double previousMs   = -1.;   // when the previous update began
    double lastNativeMs = -1.;   // when the game last moved the player itself
    float  frameMs = 0.f;        // this update's allowance
    bool   active  = false;      // inside an update
    bool   spent   = false;      // allowance already consumed this update

    // Start an update. `fallbackDeltaMs` is used only for the very first one,
    // where there is no previous timestamp to measure against.
    void Begin(double nowMs, float fallbackDeltaMs)
    {
        const double elapsed = previousMs >= 0. ? nowMs - previousMs
                                                : static_cast<double>(fallbackDeltaMs);
        previousMs = nowMs;
        frameMs = std::isfinite(elapsed)
            ? static_cast<float>(std::clamp(elapsed, 0., static_cast<double>(kMaxFrameMs)))
            : 0.f;
        active = true;
        spent  = false;
    }

    void End() { active = false; }

    // Charge travel already performed this update by something other than us —
    // the game's own input step, or a server correction. PARTIAL on purpose: a
    // player holding a direction consumes part of the allowance, and the dodge
    // must still be able to spend what is left. Erasing the whole allowance
    // instead would leave the dodge unable to steer at all while a key is held,
    // which is precisely when it is most needed.
    void Charge(float ms)
    {
        if (!std::isfinite(ms) || ms <= 0.f) return;
        frameMs = std::max(0.f, frameMs - ms);
    }

    // The game moved the player and we could not measure by how much. Without a
    // measurement the only safe assumption is a full step, so the allowance goes
    // to zero for this update. Prefer Charge() whenever the distance is known.
    void Native(double nowMs)
    {
        lastNativeMs = nowMs;
        if (active) spent = true;
    }

    // Remaining travel time (ms) the automated mover may still command.
    float Available(double) const { return (!active || spent) ? 0.f : frameMs; }

    // Reserve `durationMs` of travel. All-or-nothing: a refused claim leaves the
    // allowance untouched so the caller can fall back without side effects.
    bool Claim(double nowMs, float durationMs)
    {
        if (!std::isfinite(durationMs) || durationMs <= 0.f) return false;
        if (durationMs > Available(nowMs) + 0.001f) return false;
        spent = true;
        return true;
    }
};

} // namespace DodgeRuntime
