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
// popped non-start cell where the spatial Core::PointClear goal test holds
// (standable ground, outside every danger lane and active zone). Walls
// block; diagonal steps require both orthogonal neighbors open (no
// corner-cutting); hazard cells cost extra but are traversable, and pending
// zones / danger lanes cost more but stay traversable (transit through
// danger may be the only way out of a boxed-in room — the endpoint itself
// must be clear). Game-update thread only (static scratch).
EscapeResult FindEscape(const MapInput& in);

} } // namespace UDodge::Field
