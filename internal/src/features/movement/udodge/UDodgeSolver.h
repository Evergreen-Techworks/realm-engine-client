#pragma once
#include "UDodgeTypes.h"

// UDodge per-tick safe-position solver (plan 64). Each server tick it computes
// the player position — within the legal per-tick move budget — that lies
// OUTSIDE every bullet's server hit region (safety is a HARD constraint,
// including the player half-extent via Core::PointSafety) and is best by a
// smart-direction objective, then hands that target back so UDodge::Tick can
// drive the player there through the game's own speed-clamped MoveTo.
//
// Pure data + math over the plain-data DangerMap and the Env probes already in
// MapInput. No IL2CPP, no globals, no worker thread.
//
// LOOKAHEAD (plan 64 extension). The per-tick candidate set only reaches one
// move budget, so a greedy "safest cell NOW" pick has no way to PLAN toward a
// gap it cannot reach in a single step — in a dense shot wall it dead-ends
// inside a shot. On top of the immediate layer the solver runs a bounded
// nearest-pocket search over a horizon larger than one tick (kULookaheadTiles)
// and pre-positions the player INTO the gap over 2–3 ticks.
//
// TEMPORAL. The pocket test is TIME-parameterized: it predicts where every
// relevant bullet is GOING (reusing the trajectory the sensors already traced,
// LaneThreat::pointTimesMs — no re-prediction) and asks whether the player's
// along-path position is clear AT THE MOMENT the player is actually there. This
// threads gaps in TIME (stand where a bullet only WILL be, or has already
// passed) that the static whole-path test forbids, with a comfort margin so a
// slightly-off prediction can't clip. The instantaneous lane-based safety stays
// the CONSERVATIVE FLOOR for the immediate reflex; temporal only upgrades the
// lookahead/pre-positioning. The trigger is a durability test on the current
// spot: if a bullet will sweep through it over the horizon (a wall closing),
// walk the validated path to the pocket now; only when the stand is itself a
// durable temporal pocket do we HOLD.
//
// IN-RANGE DISK (locked boss). When a boss is LOCKED (goal.fromLock, goal.maxRange
// = weaponRange) the movement manifold is the FILLED DISK of radius weaponRange
// around the boss — every spot from which the boss is still hittable. The solver
// runs its normal open-space lookahead but CONSTRAINS the durable-pocket search
// to that disk: it finds the NEAREST safe temporal pocket ANYWHERE inside weapon
// range (in, out, or around the boss — it may cut across the inside of the disk
// or drift to the far side, whatever the nearest safe spot is) and pre-positions
// to it, threading the pattern while keeping the boss hittable. The stay-in-range
// preference is governed by kSolveOutRangeW on the immediate reflex and the disk
// gate on the pocket search. Safety STILL OVERRIDES: if no safe pocket exists
// inside the disk the search is re-run UNCONSTRAINED (leave range to dodge, then
// return once clear). This constraint applies ONLY when locked; unlocked play is
// unchanged.
//
// HONEST GUARANTEE. "Numerically impossible to get hit" holds ONLY for the
// SolveKind::Safe case: a provably-safe point existed within the move budget
// and we placed the player there. When the reachable disk is fully covered
// (Fallback / Surrounded) the player CAN be hit; the solver then minimizes
// exposure (max-min-clearance) but cannot guarantee zero hits. That bound is a
// physical consequence of the per-tick move budget, not a solver weakness.
namespace UDodge { namespace Solver {

struct Goal {
    bool  active = false;   // a soft target exists (lock standoff or WASD intent)
    Vec2  pos{};            // world target we would like to progress toward
    bool  fromLock = false; // true = boss-lock orbit (may actively reposition to
                            // stay in range); false = WASD/idle (game drives — the
                            // solver only overrides to dodge, never to walk a goal)
    Vec2  lockPos{};        // locked boss position (for the stay-in-range preference)
    float maxRange = 0.f;   // weapon range (tiles): the max distance from the boss at which
                            // it is still hittable. When fromLock && maxRange>0 this is the
                            // radius of the IN-RANGE DISK the solver pathfinds within — the
                            // durable-pocket search is constrained to it. See the header note.
};

enum class SolveKind : uint8_t {
    Hold,        // player is already safe and nothing better is worth moving for
    Safe,        // moved to a provably-safe reachable cell
    Fallback,    // no safe reachable cell — moved to the least-bad (max-min-clr) cell
    Surrounded,  // no reachable cell improves clearance — hold in place
};

struct SolveResult {
    SolveKind kind = SolveKind::Hold;
    Vec2      target{};        // world position to drive toward this tick
    bool      shouldMove = false;
    float     clearance = 0.f; // server-accurate clearance at target
    // ── Lookahead (plan 64 extension) ────────────────────────────────────────
    // prePosition: this tick's move is a PRE-POSITIONING step toward a durable
    // lookahead pocket a few tiles away — the current spot is only momentarily
    // safe (a wall is closing), so we walk into the gap now instead of waiting
    // to be threatened. false = the move is an immediate dodge / hold.
    bool      prePosition = false;
    float     pocketDist  = 0.f; // reach to the nearest durable pocket (0 = none, or standing in one)
    uint8_t   tempLanes   = 0;   // relevant bullets fed to the temporal test (post-cull) — diagnostics
    // ── In-range-disk pathfinding (locked-boss only) ─────────────────────────
    // inRangeDisk: this solve was constrained to the boss's weapon-range disk
    // (goal.fromLock) — the durable-pocket search preferred spots keeping the
    // boss hittable. Diagnostics only; the target is still an open-space pocket.
    bool      inRangeDisk = false;
    bool      outOfRange  = false; // true = no safe pocket existed in the disk, so the search
                                   // left weapon range to dodge (safety override); returns when clear
};

// Solve for the best reachable position this server tick.
//   moveBudgetTiles = per-tick reach = tilesPerSec × kServerTickSec (in.stepTiles).
//   goal            = soft preference (lock standoff / WASD); never overrides safety.
//   state.lastMoveDir is read (commitment term) and updated (chosen heading).
void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           CoreState& state, SolveResult& out);

} } // namespace UDodge::Solver
