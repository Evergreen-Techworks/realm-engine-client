#pragma once
#include "UDodgeTypes.h"

// UDodge core — the pure controller (port of PJDodge's predictive engine,
// extended with lingering AoE zones and the 35th "field escape" candidate).
// Host-independent: everything it knows about the world arrives through
// CoreInput (snapshot + env probe), everything it decides leaves through
// CoreOutput. No IL2CPP, no globals.
namespace UDodge { namespace Core {

// Pure decision function (game-update thread). Reads the snapshot + env
// probes in `in`, updates hysteresis state, writes the full output.
void Evaluate(const CoreInput& in, CoreState& state, CoreOutput& out);

// "Could the player stand at `pos`, arriving at arrivalMs, for holdMs, and
// not be hit / be on a wall or hazard?" Used by the field search as its goal
// probe. Walls+hazard via in.env (hazard always blocks — a pocket endpoint
// must be clean ground); projectiles via point-vs-polyline within the
// [arrivalMs - pad, arrivalMs + holdMs + pad] window; AoE landings and
// active zones inside that window. Enemy bodies deliberately NOT checked
// (they are score-only in this engine).
bool PointDwellClear(const CoreInput& in, Vec2 pos, float arrivalMs, float holdMs);

// Instantaneous engine (plan 46): scores candidates against the tick-synced
// DangerMap. No time dimension — candidate step segments are evaluated
// against danger lanes / zones at their CURRENT positions.
void Evaluate(const MapInput& in, CoreState& state, CoreOutput& out);

// "Could the player stand at `pos` right now?" — on standable ground
// (walls always block; hazard blocks when safeWalk), outside every danger
// lane (Chebyshev > hitHalf × hitScale) and outside every ACTIVE zone.
// Pending (not-yet-landed) zones do NOT block — they are cost-only.
// Enemy bodies deliberately NOT checked (score-only in this engine).
bool PointClear(const MapInput& in, Vec2 pos);

} } // namespace UDodge::Core
