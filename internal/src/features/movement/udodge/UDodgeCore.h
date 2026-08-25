#pragma once
#include "UDodgeTypes.h"

// UDodge core (plan 64) — the pure spatial safety primitives the per-tick
// solver uses. Host-independent: everything it knows about the world arrives
// through MapInput (danger map + env probe). No IL2CPP, no globals. The old
// 35-candidate reactive controller was retired; the solver in UDodgeSolver now
// chooses among reachable points using these tests.
namespace UDodge { namespace Core {

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

// True when `pos` is outside every ACTIVE AoE disc (endpoint test, player half
// folded in). Core::Temporal is lane-only and cannot see zones, so any admission
// path gated on Temporal::PathClear MUST also clear this or it will happily
// thread a live blast. See the comment on the definition for why endpoint-only.
bool ZoneClear(const MapInput& in, Vec2 pos);

// Hard safety predicate used by the solver: occupancy-clear AND
// PointSafety(pos) >= pad. `pad` lets the solver require the latency margin.
bool PointSafe(const MapInput& in, Vec2 pos, float pad);

// Min server-accurate clearance (tiles) of the player-swept segment A→B against
// all lanes/active zones (folds kUPlayerHalf). >= pad ⇒ the whole straight move
// is clear, not just the endpoint — a thin lane CROSSING between A and B cannot
// clip the player mid-step. The min over lanes of (min-Chebyshev between segment
// A→B and each lane polyline segment) − (bulletHalf·scale + kUPlayerHalf), and
// over active zones of (min Euclidean distance from the zone center to A→B) −
// (radius + kUPlayerHalf). Reuses MinChebOnSegment (plan 78, Fix B). Walls/hazard
// NOT considered (caller probes occupancy); pending zones are cost-only.
float SegmentSafety(const MapInput& in, Vec2 a, Vec2 b);

// True when `pos` sits inside ANY enemy body (+ the player half-extent). Running
// onto a mob is never acceptable, so this is a HARD exclusion (treated like a
// wall). Reads EnemyBlocker.radius from the danger map's enemy list — the one
// radius source shared by the immediate solver and the grid pathfinder. Exposed
// so the game thread can RE-VALIDATE the actual movement step against the CURRENT
// (re-anchored) enemy positions every frame, not only at solve time.
bool EnemyBlocked(const MapInput& in, Vec2 pos);

// ── Shared arrival-time bullet-prediction model (plan 72) ────────────────────
// The one home for the temporal lookahead the immediate solver AND the worker
// pathfinder both use: sample each danger lane's spacetime polyline over a
// bounded horizon (kUTemporalSteps × kUTemporalStepMs), then answer "is the
// player clear of every relevant bullet AT THE MOMENT it is actually there?"
// using a swept-segment check so a fast bullet cannot tunnel between samples.
// Everything is pure, plain-data, IL2CPP-free, and safe on the worker thread —
// the caller owns the Ctx storage (stack in the solver, worker-static in the
// pathfinder); no globals, single-writer per instance.
namespace Temporal {

constexpr int   kSamples   = kUTemporalSteps + 1;                 // incl. t = 0
constexpr float kHorizonMs = kUTemporalSteps * kUTemporalStepMs;  // bounded horizon (ms)

// Culled arrival-time context: for each RELEVANT lane, the predicted bullet
// position at each march sample plus its effective hit half (bullet half·scale
// + kUPlayerHalf). Fixed-size, no heap; the caller owns the storage.
struct Ctx {
    int   count = 0;
    Vec2  pos[kMaxProjectiles][kSamples];   // bullet position at t = k·stepMs
    float half[kMaxProjectiles];            // hitHalf·scale + kUPlayerHalf
    // Fast-lane refinement (kUTemporalMaxSweepTiles): for lanes whose per-step
    // travel is long enough that the straight chord between two march samples can
    // hide a crossing, `mid[i][k]` is the lane's TRUE position at the half-step
    // t = (k + ½)·stepMs, so the queries follow two sub-segments per step instead
    // of one chord. Only valid where sub[i]; slow lanes never read it.
    Vec2  mid[kMaxProjectiles][kUTemporalSteps];
    bool  sub[kMaxProjectiles];             // this lane needs the half-step samples
};

// Sample one lane's spacetime polyline at each march time (clamp past the traced
// horizon — never invents "safe"). outPos must hold kSamples entries.
void SampleLane(const LaneThreat& L, Vec2* outPos);

// Build the context from a danger map: predict each lane once, cull lanes whose
// whole traced path stays > cullTiles from cullCenter over the horizon.
// cullCenter/cullTiles are PARAMETERS — the solver culls relative to the player
// (kUTemporalCullTiles), the pathfinder relative to the grid center (window
// extent + margin) so a far-side-of-disk lane survives (see plan 72).
void Build(const DangerMap& map, float hitScale, Vec2 cullCenter,
           float cullTiles, Ctx& out);

// Bullet position at arbitrary t within the march grid (clamped to [0,horizon]).
Vec2 BulletPosAt(const Ctx& c, int li, float tMs);

// Query A (solver): the player walks STRAIGHT from `player` to P at `speed`
// (tiles/ms), arriving at tArrive, then holds at P; clear at every march step?
// TRANSIT is always checked over the FULL horizon. DWELL (the hold at P) is only
// checked for `dwellMs` past arrival — see kUDwellMs for why the dodge does not
// have to promise a full horizon of stillness. Pass kHorizonMs to opt out and get
// the old whole-window stand-still test (the STAND-durability gate does).
bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P,
               float dwellMs = kUDwellMs);

// Query B (pathfinder edge relaxation): standing at B, is every bullet clear
// over the arrival window [tA, tB] (swept)?
bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB);

} // namespace Temporal

} } // namespace UDodge::Core
