#pragma once
#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "../spacetime/SpacetimeCore.h"
#include <algorithm>
#include <cmath>

// Adapter between UDodge's worker snapshot and the bounded temporal planner
// (SpacetimeCore). Pure plain-data math, so it runs on the worker thread and is
// exercised directly by the host regression suite.
//
// The planner is an ADVISOR — see Solver::TimedAdvice and
// internal/docs/udodge-timed-escape-design.md. Everything here is about handing
// it a faithful picture of UDodge's world and collapsing its answer down to the
// one thing the solver will accept: a step target for this tick.
namespace UDodge { namespace Timed {

// Search bounds. Defaults are the worker's: a few thousand expansions and a few
// milliseconds, which is affordable off the game thread and small enough that a
// budget-exhausted search simply publishes nothing.
struct Budget {
    int   maxExpansions    = 4000;
    float maxSearchMs      = 4.f;
    float maxDistanceTiles = 3.f;   // how far a plan may deviate from standing still
};

// Command lead: the planner's model of how long before an issued command takes
// effect. UDodge re-issues MoveTo every frame, but the advice itself is a worker
// result consumed a tick later, so a small non-zero lead is the honest value.
inline constexpr float kTimedLeadMs = 40.f;
// Control resolution of the search. Finer than the 100 ms temporal march, which
// is the point: it is what lets a plan turn and depart between march samples.
inline constexpr float kTimedStepMs = 40.f;
// Projectile paths entering this radius of the player are searched against.
// At least the temporal cull radius, so the planner never sees LESS than the
// floors that will judge its answer.
inline constexpr float kTimedLookRangeTiles = 12.f;
static_assert(kTimedLookRangeTiles >= kUTemporalCullTiles,
              "the planner must not be blind to a lane the solver's floors will test");

// Build the planner input from a worker snapshot's MapInput.
//
// `nominal` is ZERO on purpose. It models movement the host would perform
// anyway; UDodge owns movement outright (it drives MoveTo toward its own target
// every frame), so the honest baseline is "the player stays put". That also
// makes the planner's tail test — is standing here safe to the horizon? —
// identical in meaning to the solver's own stand-durability gate.
//
// No timed zones are supplied: UDodge's DangerMap carries active/pending discs
// without arm timing, and the planner's own active-zone fallback then matches
// Core::ZonePathClear exactly. Inventing timings the sensors never measured
// would be a guess with a blast radius.
inline void BuildInput(const MapInput& world, double nowMs, float frameMs,
                       const Budget& budget, SpacetimeDodge::Input& out)
{
    out = SpacetimeDodge::Input{};
    out.world   = world;
    out.nominal = {};
    out.nowMs   = nowMs;
    out.frameMs = std::isfinite(frameMs) && frameMs > 0.f ? frameMs : 16.7f;
    out.actuationMs        = 0.f;   // UDodge steers continuously; no throttled actuator
    out.maxCorrectionSpeed = 0.f;   // zero means "the player's own speed"
    out.collectDiagnostics = false;
    out.zoneCount          = 0;

    out.settings.horizonMs     = Core::Temporal::kHorizonMs;   // agree with the march
    out.settings.dwellMs       = kUDwellMs;                    // agree with admission
    out.settings.leadMs        = kTimedLeadMs;
    out.settings.stepMs        = kTimedStepMs;
    out.settings.lookRange     = kTimedLookRangeTiles;
    out.settings.maxDistance   = budget.maxDistanceTiles > 0.f ? budget.maxDistanceTiles : 3.f;
    out.settings.maxExpansions = budget.maxExpansions;
    out.settings.maxSearchMs   = budget.maxSearchMs;
}

// Collapse a planner result to the solver's advice.
//
// Only two statuses are a certified route. `Moving` yields the position the plan
// occupies one server tick from now — UDodge's own commitment quantum — clamped
// to the move budget. `Waiting` yields a hold. Everything else, INCLUDING
// `Recovery`, advises nothing: recovery is explicitly a least-damage prefix
// rather than a safe route, and UDodge already has a least-bad fallback that the
// solver reaches on its own. `Clear` also advises nothing, because a stand the
// planner calls safe is a stand the solver's own hold already covers.
inline Solver::TimedAdvice ToAdvice(const SpacetimeDodge::Output& out, Vec2 player,
                                    float moveBudgetTiles,
                                    float tickMs = kServerTickSec * 1000.f)
{
    Solver::TimedAdvice advice{};
    if (out.status == SpacetimeDodge::Status::Waiting) {
        advice.valid = true;
        advice.waiting = true;
        advice.departureMs = out.waitMs;
        advice.stepTarget = player;
        return advice;
    }
    if (out.status != SpacetimeDodge::Status::Moving || out.plan.count < 2) return advice;

    const Vec2 at = SpacetimeDodge::PositionAt(out.plan, tickMs);
    if (!std::isfinite(at.x) || !std::isfinite(at.y)) return advice;
    const Vec2  to = Sub(at, player);
    const float d  = Len(to);
    if (!(d > 1e-3f)) return advice;   // "moving" that does not move is not a step

    const float budget = std::max(moveBudgetTiles, 1e-3f);
    advice.valid = true;
    advice.moves = true;
    advice.stepTarget = Add(player, Mul(Mul(to, 1.f / d), std::min(d, budget)));
    advice.departureMs = out.waitMs;
    return advice;
}

} } // namespace UDodge::Timed
