#pragma once
#include "UDodgeTypes.h"

// UDodge core — the pure instantaneous controller. Scores spatial step
// candidates against the tick-synced DangerMap (clearance-lexicographic,
// tick-locked hysteresis) with the 35th "field escape" candidate as the
// general fallback. Host-independent: everything it knows about the world
// arrives through MapInput (danger map + env probe), everything it decides
// leaves through CoreOutput. No IL2CPP, no globals.
namespace UDodge { namespace Core {

// Pure decision function (game-update thread): scores candidates against the
// tick-synced DangerMap. No time dimension — candidate step segments are
// evaluated against danger lanes / zones at their CURRENT positions.
void Evaluate(const MapInput& in, CoreState& state, CoreOutput& out);

// "Could the player stand at `pos` right now?" — on standable ground
// (walls always block; hazard blocks when safeWalk), outside every danger
// lane (Chebyshev > hitHalf × hitScale) and outside every ACTIVE zone.
// Pending (not-yet-landed) zones do NOT block — they are cost-only.
// Enemy bodies deliberately NOT checked (score-only in this engine).
bool PointClear(const MapInput& in, Vec2 pos);

} } // namespace UDodge::Core
