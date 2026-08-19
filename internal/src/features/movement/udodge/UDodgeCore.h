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

} } // namespace UDodge::Core
