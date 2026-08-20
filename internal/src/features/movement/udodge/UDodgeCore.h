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

// Hard bullet clearance (tiles) at `pos`: the minimum, over every danger lane
// (Chebyshev distance − hitHalf×hitScale) and every ACTIVE zone (Euclidean −
// radius), of how far `pos` sits OUTSIDE the danger. Large positive = far from
// all bullets; ≤ 0 = inside a lane/zone. Walls/hazard are NOT considered here —
// the caller probes occupancy separately. Used by path-following (auto-walk) to
// refuse advancing the route toward a cell inside/near a bullet lane.
float PointClearance(const MapInput& in, Vec2 pos);

// Server-accurate clearance (tiles) at `pos`: the minimum over every lane
// (Cheb − (hitHalf·hitScale + kUPlayerHalf)) and every ACTIVE zone
// (Euclid − (radius + kUPlayerHalf)). >0 ⇒ pos is OUTSIDE the server hit
// region of all shots; ≤0 ⇒ pos would be hit. Walls/hazard NOT considered
// (caller probes occupancy). Pending zones are cost-only, excluded here.
// This is PointClearance folded with the player half-extent (plan 64) — the
// safety test the solver requires (the raw PointClearance omits it, so its
// "safe" is ~0.21 tiles too optimistic).
float PointSafety(const MapInput& in, Vec2 pos);

// Hard safety predicate used by the solver: occupancy-clear AND
// PointSafety(pos) >= pad. `pad` lets the solver require the latency margin.
bool PointSafe(const MapInput& in, Vec2 pos, float pad);

} } // namespace UDodge::Core
