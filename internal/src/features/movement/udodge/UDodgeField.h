#pragma once
#include "UDodgeTypes.h"

// UDodge field escape (port of RePP's wall-aware Dijkstra pocket search). A
// short-horizon Dijkstra over a local grid that routes AROUND walls to the
// nearest safe-to-stand pocket — the cure for "boxed in a confined room",
// which straight-line candidates can't solve.
namespace UDodge { namespace Field {

struct EscapeResult {
    bool found = false;
    Vec2 target{};     // pocket cell (world)
    Vec2 firstDir{};   // unit direction of the first step
};

// Dijkstra over a 21x21 half-tile grid centered on the player. Goal = first
// popped non-start cell where Core::PointDwellClear(in, cell, arrivalMs,
// kHoldMs) holds. Walls block; diagonal steps require both orthogonal
// neighbors open (no corner-cutting); hazard cells cost extra but are
// traversable. speedTilesPerMs converts accumulated distance to arrival time.
// Game-update thread only (static scratch).
EscapeResult FindEscape(const CoreInput& in, float speedTilesPerMs);

// Instantaneous overload (plan 46): same 21×21 half-tile Dijkstra, goal =
// first popped non-start cell where Core::PointClear holds. No arrival
// times; hazard cells cost extra, pending zones and danger lanes cost more
// but stay traversable (transit through danger may be the only way out of a
// boxed-in room — the endpoint itself must be clear).
EscapeResult FindEscape(const MapInput& in);

} } // namespace UDodge::Field
