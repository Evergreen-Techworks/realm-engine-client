#pragma once

#include <cstdint>
#include <cmath>
#include <algorithm>

// UDodge — unified auto-dodge: PJDodge predictive core + RePP field
// escape/goal layer. Pure data + inline math. No game/IL2CPP includes.
namespace UDodge {

// ── Candidate layout (legacy overlay indices; the reactive engine is retired) ─
// 0 = stand, 1..32 = compass headings, 34 = field escape. Retained only for the
// debug overlay's candidate-fan drawing until it is simplified.
constexpr int   kDirectionCount  = 32;
constexpr int   kStandCandidate  = 0;
constexpr int   kFieldCandidate  = kDirectionCount + 2;   // 34
constexpr int   kCandidateCount  = kDirectionCount + 3;   // 35
constexpr float kTwoPi           = 6.28318530717958647692f;

// ── Map capacities (fixed buffers — zero per-frame heap allocation) ─────────
constexpr int kMaxProjectiles = 96;
constexpr int kMaxAoes        = 32;
// 192, raised from 64: within the 16-tile blocker cull a dungeon corridor or a
// horde routinely exceeds 64 entities. Overflow used to DROP the newcomer, and
// PopulateEnemies fills in snapshot order — so a breakable wall one tile ahead
// could be dropped while a distant enemy that appeared earlier kept its slot,
// making the wall invisible to EnemyBlockedLocal (UDodgePathfinder) and letting
// A* route straight through it. PopulateEnemies now also evicts the FARTHEST
// kept blocker instead of dropping the nearer newcomer, which is what makes the
// set correct at ANY cap; this larger cap just keeps eviction rare.
// Cost: EnemyBlocker is 12 B, so 768 B -> 2.3 KB of fixed buffer.
constexpr int kMaxEnemies     = 192;
// Legacy route cap — DebugSnapshot still declares a path[] buffer of this size.
constexpr int kMaxPathPoints  = 48;

// Clearance headroom (tiles) over which the goal/orbit pull ramps to full; near
// the danger floor it fades so an accurate dodge always beats staying on the
// orbit line. Reused by the solver's headroomRamp (plan 64).
constexpr float kUScoreStyleBand = 1.5f;

// ── Per-tick safe-position solver (plan 64; baked-in, NO user sliders) ───────
// Server-accurate hit geometry. The game's IsHit (FUN_18015be50) folds the
// player half-extent into effR; our DangerMap lane.hitHalf is the BULLET half
// only, so the safety test must add this. Value mirrors DodgeHit::kPlayerHalf.
constexpr float kUPlayerHalf = 0.2139f;
// Player environment-COLLISION Chebyshev half-edge (tiles). This is the footprint
// used to decide whether the player can STAND at a position — the box the game
// tests against blocked tiles (mirrors TestTAB's kPlayerChebyshevScale = 0.2285,
// consumed by IsPositionBlocked / IsWalkPositionBlocked). It is DISTINCT from
// kUPlayerHalf (0.2139), which is the BULLET-HIT half folded into shot geometry:
// collision clearance and hit clearance are different quantities — do NOT conflate
// them. Passed to WorldTAB::CopyBoxBlocked so the bulk occupancy reader rasterizes
// the exact same walkability footprint the per-cell CanOccupy path used.
constexpr float kUOccPlayerHalfEdge = 0.2285f;
// Baked command-latency safety pad (tiles): keep the chosen point this far
// clear of the server hit boundary so a bullet seen one RTT ahead of our read
// can't clip it. Lowered for TIGHT weaving — the player wants to walk right up
// against a shot's edge; this is the only buffer beyond the true hit geometry
// (bulletHalf + kUPlayerHalf), so a small value hugs the boundary. NO user setting.
constexpr float kULatencyPad = 0.05f;

// Smart-direction objective weights over the SAFE candidate set. Safety is a
// hard constraint (every scored point is already provably safe); these only
// choose AMONG safe points and can never trade safety away.
constexpr float kSolveCommitW      = 1.0f;  // directional continuity (anti-jitter)
// Extra continuity reward (plan 76) for a candidate whose heading nearly matches
// the committed heading (Dot > 0.9). It breaks near-equal SAFE options toward
// "keep going" without touching the base kSolveCommitW term. Applied over the
// already-safe candidate set only, so it can never trade safety away.
constexpr float kSolveCommitBonus  = 0.5f;
constexpr float kSolveGoalW        = 0.8f;  // goal/WASD progress (fades near danger)
constexpr float kSolvePerpW        = 1.2f;  // lateral sidestep vs radial flee/charge: strong enough
                                            // that a left/right sidestep beats a backpedal's clearance edge
constexpr float kSolveMoveW        = 1.2f;  // minimal-disruption penalty (prefer nearest safe)
constexpr float kSolveClearW       = 0.25f; // gentle comfort tiebreak, capped
constexpr float kSolveClearComfort = 0.5f;  // clearance (tiles) above which comfort
                                            // stops rewarding — capped low so a wide
                                            // flee never out-scores a valid tight thread
// Reward a candidate that WEAVES the pattern — accepted because it is clear at
// ARRIVAL time (in/near a lane now, gap opens as the player arrives) — over one
// that flees to open space. Applied ONLY to already-safe (arrival-clear)
// candidates, so it can never trade safety away; it just keeps the dodge tight
// and aggressive instead of retreating off the pattern. Bounded, modest.
constexpr float kSolveWeaveW = 0.35f;   // flat reward for a threaded (in-gap) candidate
constexpr float kSolveStandBias    = 0.15f; // score the stand point gets so we don't twitch off a safe stand
constexpr float kSolveOutRangeW    = 1.6f;  // penalty per tile a dodge point sits OUTSIDE the boss
                                            // weapon range — prefer dodging inward, stay in shooting range
// Extra out-of-range penalty proportional to the SQUARE of tiles past weapon
// range. Keeps a small dodge-out cheap (safety still wins near the edge) while
// making a large drift out of the fight expensive, so the player returns to the
// annulus promptly. Locked boss only. Chooses among SAFE candidates only.
constexpr float kSolveOutRangeQuadW = 0.8f;   // tune in testing
// Hysteresis band (tiles) beyond weapon range before the solver actively steps
// back INTO the annulus from a safe stand. A band (not 0) so the player does not
// twitch in/out at the exact range boundary. Locked boss only.
constexpr float kUReturnRangeSlack = 0.5f;

// Route-step anti-oscillation (movement smoothing; baked, NO user setting). The
// worker republishes a route each server tick and its first-step direction can
// FLIP when it toggles between two near-equal durable-safe goal cells. Consuming
// that raw jerks the player back and forth. When a fresh route step's direction
// reverses the committed heading past this dot threshold (≈ >105° apart) AND
// continuing the old heading is itself still temporally clear, the solver keeps
// committing straight instead of reversing. Safety stays authoritative — the
// continuation must pass the same walkable + enemy + temporal floor, so a reversal
// that safety truly requires is never smoothed away.
constexpr float kURouteReverseDot  = -0.25f;

// Reflex score-tie band: two safe candidates within this score of each other are
// treated as equal and the tie is broken toward the committed heading (anti-
// jitter). Small — a meaningfully better safe cell still wins outright. Choosing
// among SAFE candidates only, so it never trades safety away.
constexpr float kSolveReflexHystEps = 0.15f;

// ── Plan-commitment / anti-flip-flop hysteresis (plan 76; baked, NO user setting) ─
// Commitment chooses only AMONG equally-SAFE goals — never a safety override. Two
// layers cooperate with the existing route-reversal damp (kURouteReverseDot) and
// heading-continuity term (kSolveCommitW):
//  • GOAL hysteresis (worker Dijkstra): carry the previously-committed durable-safe
//    goal cell forward and keep it when it is STILL a valid in-annulus goal reachable
//    in time and arrives within kURouteGoalHystMs of the new best goal's arrival —
//    otherwise take the new best. For the PARTIAL route (no durable goal) the old
//    target is kept unless the new safest reachable cell is MEANINGFULLY better:
//    ≥ kPartialGainTiles safer OR ≥ kURouteGoalHystTiles closer to the player. A goal
//    that stops being reachable/durable is dropped that same pass (re-tested every pass).
//  • HEADING commitment (solver): a soft branch of the route-step damp keeps
//    continuing the committed heading through a >60° toggle while the continuation is
//    still fully safe (walkable + enemy-free + temporally clear), capped at
//    kUMaxDampTicks consecutive damped ticks so a genuine required turn is never
//    delayed indefinitely.
constexpr float   kURouteGoalHystMs    = 120.f;  // keep the old goal unless a new one arrives this much sooner
constexpr float   kURouteGoalHystTiles = 1.5f;   // ...or (partial route) is this much closer to the player
constexpr uint8_t kUMaxDampTicks       = 3;      // max consecutive soft-damped ticks before accepting the new step

// ── Lookahead path planning (plan 64 extension; baked, NO user sliders) ──────
// The per-tick candidate set only reaches one move budget (≈1–1.5 tiles). In a
// dense shot wall no cell within that disk is safe NOW, so the greedy solver
// fell to Fallback and left the player inside a shot even though a durable gap
// sat a few tiles away. Because every lane already encodes its bullet's WHOLE
// forward travel path as geometry, a point clear of ALL lanes by a margin is a
// DURABLE-safe pocket — no bullet will ever pass through it. So we search a
// horizon LARGER than one tick for the NEAREST such pocket and steer the
// immediate solve toward it, pre-positioning INTO the gap over 2–3 ticks
// before the wall closes.
// Shift+Click walk-to-spot: distance (tiles) at which the player is considered
// to have ARRIVED at the walk target — the walk goal clears (UDodge::Tick) and
// the solver stops actively progressing toward it (repositionToward gate).
constexpr float kUWalkArriveTiles = 0.5f;
constexpr float kULookaheadTiles = 6.0f;  // horizon radius for the durable-pocket search (tiles)
// Comfort slack (tiles) the TEMPORAL arrival test adds beyond the exact server
// hit boundary (which already folds bulletHalf·scale + kUPlayerHalf). This is
// the ONLY knob for how tightly the player may weave in FRONT of / BETWEEN
// moving shots: a bullet that is not within (hit + kUArrivalMargin) of the
// player at the moment the player is there is threaded, not fled. SMALL = tight.
// Must stay > 0 so a slightly-off prediction can never let a real hit through.
constexpr float kUArrivalMargin = 0.10f;   // step 3 tightening: was 0.18; lets the player thread ~0.08 tiles closer to moving shots (still a real cushion — SWEPT test folds full hit half + player half)
static_assert(kUArrivalMargin > 0.f, "kUArrivalMargin must stay > 0: a zero/negative arrival margin lets the player accept a point a bullet is exactly on at arrival (a hit)");

// Clearance (tiles) a cell needs BEYOND the server hit boundary to count as a
// DURABLE resting pocket / route goal, and the comfort a HELD stand keeps. This
// is a RESTING-comfort knob, deliberately independent of the arrival-thread knob
// above: a hold/goal should stay comfortable even as threading gets tighter.
constexpr float kUDurablePocketMargin = 0.18f;
constexpr int   kUPocketRings    = 12;    // concentric rings out to kULookaheadTiles (0.5-tile step)
constexpr int   kUPocketAngles   = 24;    // angular samples per ring (15° resolution)
constexpr float kSolveFallbackPocketW = 0.5f; // fallback: bias the least-bad step toward the pocket/gap

// ── Temporal lookahead (plan 64 ext; baked, NO user sliders) ─────────────────
// The static durable-pocket test above treats each lane (bullet's whole forward
// path) as permanently dangerous — spatially safe but over-conservative: it
// cannot thread a gap in TIME (stand where a bullet WILL be but only after it
// has passed, or before it arrives). The temporal test marches time forward over
// a bounded horizon and checks the player's along-path position against each
// bullet's PREDICTED position at the moment the player is actually there. The
// prediction reuses the trajectory the sensors already traced with ComputePosAt
// (LaneThreat::pointTimesMs) — no re-prediction, so it stays cheap. The
// instantaneous lane-based safety (PointSafety) remains the conservative floor
// for the immediate per-tick reflex; temporal only upgrades the LOOKAHEAD.
constexpr int   kUTemporalSteps    = 8;      // 8 × 100 ms = 800 ms horizon (~4 server ticks) — long
                                             // enough to catch a slow-closing wall instead of freezing
                                             // a still-approaching bullet at its 500 ms position (plan 95)
constexpr float kUTemporalStepMs   = 100.f;  // unchanged; swept-segment checks between samples prevent
                                             // a fast bullet tunnelling across a candidate mid-step
// horizon = kUTemporalSteps × kUTemporalStepMs = 800 ms ≈ 4 server ticks
constexpr float kUTemporalCullTiles = 8.f;   // only predict bullets whose traced path passes within this
                                             // radius of the player over the horizon (skip far/receding)

// ── TRANSIT horizon vs DWELL horizon ────────────────────────────────────────
// PathClear models a candidate as "walk straight there, then STAND STILL for the
// rest of the horizon". Those two halves deserve very different trust:
//   • TRANSIT (t < tArrive) is REAL — the player genuinely occupies every point
//     of that walk at those times, so it is checked over the FULL horizon and is
//     never relaxed. The player must never be clipped en route.
//   • DWELL (t >= tArrive) is a FICTION — the solver re-runs every frame and
//     re-validates the step it actually takes, so it never commits to standing on
//     a candidate for the whole 800 ms horizon. Demanding 800 ms of stillness
//     rejects every tile a wall will EVENTUALLY sweep, which is exactly how the
//     dodge ends up refusing to enter a room whose shot-walls must be weaved
//     through (Lost Halls miniboss): the only tiles that survive an 800 ms
//     stand-still test are the ones nothing ever crosses, and in a wall pattern
//     there are none.
// kUDwellMs is how long AFTER ARRIVAL a candidate must stay clear. 300 ms =
// 1.5 × kServerTickSec (0.2 s): the arrival tick itself plus a full replan
// quantum of slack, so (a) a bullet occupying the candidate at or near arrival
// still rejects it, and (b) the player always has one whole planning quantum in
// which to leave again before the dwell guarantee runs out. Past kUDwellMs a lane
// simply STOPS being tested against the held position — it is not treated as a
// hit, it is treated as "the next solve's problem", which is literally true.
// NOTE: the STAND-durability gate deliberately opts OUT of this (it passes the
// full horizon) — detecting a slow-closing wall early is the whole point of that
// query, and there the stand-still assumption is the honest one.
constexpr float kUDwellMs = 300.f;

// ── Fast-lane sub-stepping (plan 95 §3 — activated) ─────────────────────────
// The march step's swept-segment test treats the bullet as travelling a straight
// chord between two 100 ms samples. That is exact for a straight shot but loses
// the real path shape for a shot that CURVES inside a 100 ms window, and a fast
// lane's chord is long enough for that error to hide a crossing. When a lane's
// per-step travel exceeds this, Build additionally samples it at the HALF-step
// times and the queries walk those finer samples (2 sub-segments per step instead
// of 1). 1.0 tile / 100 ms = 10 tiles/s, above ordinary shot speeds, so only the
// genuinely fast lanes pay the extra test; slow lanes keep today's single-segment
// path. Bounded by construction: one extra sample per step, never more.
constexpr float kUTemporalMaxSweepTiles = 1.0f;

// ── In-range-disk pathfinding (locked-boss only; baked, NO user sliders) ─────
// When a boss is LOCKED the movement manifold is the FILLED DISK of radius =
// weaponRange (goal.maxRange) around the boss — every position from which the
// boss is still hittable is fair game. The solver runs its normal open-space
// lookahead/pocket + temporal search but CONSTRAINS the durable-pocket search to
// that disk: it finds the nearest safe pocket ANYWHERE inside weapon range — in,
// out, or around the boss, cutting across the inside or drifting to the far side
// — and pre-positions to it, threading the pattern while keeping the boss
// hittable. Safety STILL OVERRIDES: if no safe pocket exists inside the disk the
// search is re-run unconstrained (may leave range to dodge, then return). The
// immediate reflex already penalizes leaving range via kSolveOutRangeW. This
// constraint applies ONLY when locked; unlocked behavior is unchanged.
constexpr float kUInRangeSlack = 0.35f;  // tiles of grace added to weaponRange when gating pockets to the
                                         // disk, so a pocket right at the boundary still counts as in-range

// ── Inner-standoff annulus (locked-boss only; plan 75; baked, NO user sliders) ─
// The in-range manifold is an ANNULUS [innerStandoff, weaponRange], not a filled
// disk: the planner keeps the boss hittable AND never hugs it (shotgun /
// point-blank patterns kill at close range). innerStandoff is a fraction of
// weapon range (scales with range across classes) with an absolute floor so a
// very short-range weapon still keeps a body's-worth of gap. The inner ring is a
// GOAL/SCORE exclusion, NEVER a traversal veto — a player who STARTS inside it
// must always be able to move outward (see UDodgeSolver/UDodgePathfinder).
constexpr float kUInnerStandoffFrac     = 0.35f;  // inner radius as a fraction of weapon range (tune in testing)
constexpr float kUInnerStandoffMinTiles = 2.0f;   // absolute inner-radius floor (tiles)
// Solver inner-standoff penalty per tile a dodge point sits INSIDE the inner ring.
// At least as strong as kSolveOutRangeW so the score never prefers point-blank.
constexpr float kSolveInnerW = 1.6f;

// ── Grid pathfinder (route AROUND obstacles; baked, NO user sliders) ─────────
// The straight-line durable-pocket search can only reach a gap that lies on an
// unobstructed ray from the player: if a bullet wall or a real wall sits between
// the player and the nearest safe area it REJECTS that area and settles for a
// nearer, worse one — it cannot route around the obstruction. This layer lays a
// coarse local occupancy/cost grid over a bounded window centered on the player
// and runs an 8-neighbour Dijkstra (no diagonal corner-cutting) to the NEAREST
// durable-safe cell, producing a WAYPOINT PATH that curves around blocked and
// dangerous cells. Its first step (clamped to the per-tick budget) becomes the
// lookahead target; over successive ticks the player follows the route around
// the obstacle. Per-cell cost is the CHEAP spatial Core::PointSafety (NOT a full
// temporal march per cell — the temporal check is reserved for validating the
// single immediate step actually taken). If no durable-safe cell exists in the
// base window the window EXPANDS outward in steps up to the cap and re-searches,
// so it reaches a safe area farther out rather than dead-ending.
constexpr float kUPathCellTiles    = 0.5f;  // grid cell size (tiles) — coarse for FPS
constexpr int   kUPathBaseRadCells = 12;    // initial window radius (cells) = 6 tiles
constexpr int   kUPathMaxRadCells  = 24;    // expansion cap (cells) = 12 tiles
constexpr int   kUPathRadStepCells = 6;     // window growth per expansion step (3 tiles)
constexpr float kUPathDangerW      = 30.f;  // cost per tile of PointSafety BELOW the durable pocket margin
                                            // (grades how strongly the route bends around danger)
constexpr float kUPathHitPenalty   = 120.f; // extra cost for a cell INSIDE the server hit region
                                            // (PointSafety < 0) — traversable only when boxed in
constexpr float kUPathRoot2        = 1.41421356f;
constexpr int   kUPathMaxSide      = kUPathMaxRadCells * 2 + 1;                    // 49
constexpr int   kUPathMaxCells     = kUPathMaxSide * kUPathMaxSide;               // 49x49 = 2401
constexpr int   kUPathHeapCap      = kUPathMaxCells * 8;  // fixed min-heap (lazy Dijkstra, done-check on pop)

// ── Navigation planner (Shift+Click walk-to A*; baked, NO user sliders) ──────
// The dodge pathfinder above searches a small (≤12-tile) window for the nearest
// SAFE pocket — it cannot route a long maze corridor to a distant clicked spot.
// The navigation A* is a SEPARATE, larger, GOAL-DIRECTED search: a coarse 1-tile
// occupancy grid centered on the player, filled from WorldTAB's blocked-tile map
// (walls the game has revealed; UNDISCOVERED tiles are absent → treated WALKABLE,
// the optimistic "assume open until we learn otherwise" model). An 8-neighbour A*
// with an octile heuristic aimed straight at the goal threads the corridor; if the
// goal lies outside the window the search targets the in-window cell nearest the
// goal (partial) and the window re-centers on the player each tick as it advances,
// so newly-revealed walls just re-route the next replan. Runs on the SAME worker
// thread as the dodge Dijkstra (a second job in Path::Compute). Enemy bodies from
// the plain snapshot are hard-blocked; bullets are NOT (the micro-dodge floor
// handles shots while walking). Cleared on arrival / new click / WASD.
constexpr float kUNavCellTiles = 1.0f;   // grid cell size (tiles) — coarse; corridors are tile-scale
constexpr int   kUNavRadCells  = 72;     // window radius (cells = tiles) — reach of one plan (72 tiles).
                                         // Larger = the A* sees far enough to route around long walls and
                                         // pick a good side; the rasterize is refill-gated (kUNavRefillTiles)
                                         // so the bigger grid does NOT cost per tick.
constexpr int   kUNavSide      = kUNavRadCells * 2 + 1;          // 145
constexpr int   kUNavCells     = kUNavSide * kUNavSide;          // 145x145 = 21025
constexpr int   kUNavHeapCap   = kUNavCells * 8;                 // fixed A* min-heap (lazy, done-check on pop)
constexpr int   kMaxNavWpts    = 96;     // route polyline cap handed back to the driver (bigger window → longer routes)
constexpr float kUNavRefillTiles = 16.f; // re-rasterize the nav window only after the player moves this far
                                         // (else reuse the cached grid — the worker handles the player's
                                         // offset from the stale center). Keeps the big grid cheap.
constexpr float kUNavArriveTiles = 0.6f; // waypoint-reached radius when advancing along the route
constexpr float kUNavHazardCost  = 6.0f; // extra A* cost to ENTER a hazard cell (water/lava): routes
                                         // around it when a dry path exists, but still traverses it when
                                         // boxed in (never a hard wall — a hazard-floored arena must path)

// The route step-target (the "anchor" the player drives toward) is placed this
// many move-budgets ahead along the route polyline, NOT one. At one budget the
// player reaches it in a single tick and then STALLS until the next worker plan
// (~1 tick latency) — a visible catch-up-and-stall stutter. A few budgets of
// runway keep the player moving continuously; the actual per-tick step is still
// one budget (min(dist, budget)) and still temporally validated, so lookahead
// only smooths the drive, never the safety.
constexpr float kUStepLookaheadBudgets = 2.5f;  // dodge route anchor runway
constexpr float kUNavLookaheadBudgets  = 3.0f;  // walk-to corridor anchor runway (open ground)

// ── Async pathfinder worker (plan 65; two-rate MPC — baked, NO user sliders) ──
// The heavy grid Dijkstra + radius expansion runs on a DEDICATED WORKER THREAD
// over a plain-data snapshot (rebuilt from the retired plan-58/59 seam), NOT on
// the game thread. The game thread's per-tick micro-dodge (the immediate safe
// cell + temporal step) stays the HARD SAFETY FLOOR and never blocks on the
// worker; it consumes the worker's latest route only as a lookahead direction /
// goal bias, and stays safe even when the route is a tick or two stale. This cap
// is the publish-sequence lag beyond which the game thread ignores the route and
// dodges purely on the immediate floor (no chasing a badly-stale plan).
constexpr uint32_t kUPlanMaxStaleSeq = 3;

struct Vec2 {
    float x = 0.f;
    float y = 0.f;
};

inline float Dot(Vec2 a, Vec2 b)  { return a.x * b.x + a.y * b.y; }
inline float LenSq(Vec2 v)        { return Dot(v, v); }
inline Vec2  Add(Vec2 a, Vec2 b)  { return { a.x + b.x, a.y + b.y }; }
inline Vec2  Sub(Vec2 a, Vec2 b)  { return { a.x - b.x, a.y - b.y }; }
inline Vec2  Mul(Vec2 v, float s) { return { v.x * s, v.y * s }; }
inline float Len(Vec2 v)          { return std::sqrt(LenSq(v)); }
inline Vec2  Normalize(Vec2 v)    { const float n = Len(v); return n > 1e-4f ? Mul(v, 1.f / n) : Vec2{}; }
inline float Cheb(float x, float y) { return std::max(std::fabs(x), std::fabs(y)); }

// Exact minimum L-infinity (Chebyshev) distance from the origin to the segment
// (x0,y0)→(x1,y1). Interior minima can only occur where |x|=|y| or where one
// coordinate crosses zero — check those parameter values in closed form.
inline float MinChebOnSegment(float x0, float y0, float x1, float y1)
{
    float best = std::min(Cheb(x0, y0), Cheb(x1, y1));
    const float dx = x1 - x0;
    const float dy = y1 - y0;
    const auto consider = [&](float t) {
        if (t <= 0.f || t >= 1.f) return;
        best = std::min(best, Cheb(x0 + dx * t, y0 + dy * t));
    };
    if (dx != 0.f)  consider(-x0 / dx);
    if (dy != 0.f)  consider(-y0 / dy);
    if (dx != dy)   consider((y0 - x0) / (dx - dy));
    if (dx != -dy)  consider((-y0 - x0) / (dx + dy));
    return best;
}

// A live enemy body. Proximity is scored (tiebreak), never a hard veto — the
// only safe lane may run past an enemy.
struct EnemyBlocker {
    Vec2  pos{};
    float radius = 0.5f;
};

struct Settings {
    float hitScale    = 1.0f;    // × per-shot hit threshold [0.25, 2.5]
    bool  safeWalk    = true;    // avoid damaging ground in path checks
    bool  speedScale  = true;    // match gentle overrides to intent speed
    bool  fieldEscape = true;    // Dijkstra pocket search when boxed in
    bool  debugOverlay = true;
    bool  debugWeights = false;  // color-code the pathfinder's visible cells by safety weight
                                 // (heatmap + nav route/window) — debug viz, off by default (draw cost)
    bool  lockFollow  = false;   // consume DangerPlanner external goal as intent
    bool  followLantern = false; // Autopilot: stand-on object scan (perf cost)
    bool  autopilot     = false; // Autopilot auto-lock: auto-select the highest-maxHp
                                 // targetable enemy as the enemy lock each tick
                                 // so the orbit/in-range fight engages automatically
    int   standOnType   = 0;     // objType to stand on (0 = off)
    float laneTiles = 12.f;  // danger-lane paint length (tiles)      [2, 16]
    float stepTiles = 0.f;   // candidate step distance; 0 = auto
                             // (tilesPerSec × kServerTickSec)        [0 | 0.4, 3]
    float reactMargin = 0.60f;  // reaction clearance floor (tiles) [0.05, 2.0]
    float orbitRange = 0.f;  // boss orbit standoff (tiles); 0 = auto
                             // (resolved weapon range × 0.85)        [0 | 2, 16]
    int   planRadius = 20;   // planner window radius (grid cells) [8, 40]
                             // shrinks the rasterized window to cut cost
};

// Host environment probe (kept as function pointers so the core stays free of
// game headers and unit-testable).
struct Env {
    // "Can the player stand at (x, y)?" — false for walls, and for damaging
    // ground when safeWalk is set.
    bool (*canOccupy)(float x, float y, bool safeWalk) = nullptr;
    // "Is (x, y) damaging ground?" — used by the hazard-escape mode.
    bool (*isHazard)(float x, float y) = nullptr;
};

// ── Instantaneous danger map (plan 45; temporal lookahead plan 64 ext) ──────
// Spatial danger plus a thin TIME axis on lanes. Lane points are the
// projectile's LIVE position followed by its remaining travel path as geometry
// (points[0] = live), and pointTimesMs[i] is the time (ms from NOW) at which the
// bullet reaches points[i] — i.e. the polyline is the bullet's spacetime
// trajectory, sampled by the same ComputePosAt / cached-path model that traced
// the geometry. The instantaneous safety tests ignore the times (whole path =
// dangerous NOW — the conservative floor); the temporal lookahead reads them to
// thread TIME-gaps (stand where a bullet only WILL be, or has already passed).
// Zones are discs classified active (hard) / pending (soft).

constexpr int   kMaxLanePoints    = 24;     // per-lane polyline cap
constexpr float kHugeClearance    = 1.0e9f; // "no danger anywhere" sentinel
constexpr float kServerTickSec    = 0.2f;   // planning quantum: one server tick of motion
constexpr float kTraceStepMs      = 30.f;   // sensor-internal geometry tracing step —
                                            // time never leaves the sensor

struct LaneThreat {
    int32_t  bulletId      = 0;   // identity for mid-tick re-anchoring...
    int32_t  attackerObjId = 0;   // ...(bulletId alone is not globally unique)
    uint32_t ownerObjId    = 0;
    float    hitHalf       = 0.5f; // game IsHit Chebyshev half (same rule as before)
    int      pointCount    = 0;
    Vec2     points[kMaxLanePoints]{};   // points[0] = live position (anchor)
    float    pointTimesMs[kMaxLanePoints]{}; // time (ms from NOW) the bullet reaches points[i]; [0]=0 (live).
                                             // The temporal lookahead interpolates bullet-position-at-time from
                                             // this; the instantaneous safety tests never read it.
};

struct ZoneThreat {
    Vec2  pos{};
    float radius = 1.f;
    bool  active = false;  // true = detonated & persisting (HARD danger);
                           // false = telegraphed, not yet landed (SOFT cost)
};

struct DangerMap {
    uint32_t tickId    = 0;      // WM_TickId this layout was built from
    bool     tickValid = false;  // false => tick source unreadable (fail-safe mode)
    LaneThreat lanes[kMaxProjectiles]{};
    int  laneCount = 0;
    ZoneThreat zones[kMaxAoes]{};
    int  zoneCount = 0;
    EnemyBlocker enemies[kMaxEnemies]{};
    int  enemyCount = 0;
    bool projectileSourceUnavailable = false;
    bool limited = false;
    bool    hasLock = false;   // autopilot boss lock (same semantics as Snapshot)
    int32_t lockId  = 0;
    Vec2    lockPos{};
};

// Input for the instantaneous core. No time fields exist — stepTiles is a
// DISTANCE (the candidate commitment length).
struct MapInput {
    Vec2  player{};
    Vec2  intentDir{};          // unit WASD/goal direction; zero when idle
    float stepTiles = 1.f;      // candidate commitment distance (tiles)
    float speed = 0.f;          // tiles per ms — for velocity output only
    uint32_t tickId = 0;        // map's tick stamp (tick-locked hysteresis)
    bool  movementLocked = false;
    bool  playerOnHazard = false;
    Settings settings{};
    Env env{};
    const DangerMap* map = nullptr;
};

enum class Decision : uint8_t {
    None,
    NoThreat,
    MovementLocked,
    PreserveSafeIntent,
    GentleOverride,
    GentleManualBlend,
    EmergencyOverride,
    EmergencyManualBlend,
    UnavoidableManualBlend,
    HazardEscape,          // standing on damaging ground — leave it, fastest exit first
    FieldEscape,           // boxed in — Dijkstra field routed to a safe pocket
};

struct CandidateDebug {
    Vec2  dir{};
    bool  valid = true;
    float clearance = kHugeClearance;  // min hard clearance along the step segment (tiles)
    float softCost  = 0.f;             // pending-zone penetration sum (tiles)
    float blockDist = kHugeClearance;  // distance at which walls truncate the segment
};

// Cross-frame solver state. Retains the last committed heading (the solver's
// directional-continuity term). The tick-hysteresis fields are legacy no-ops
// kept so CoreState's shape is unchanged for existing callers.
struct CoreState {
    int      selectedCandidate = kStandCandidate;
    uint32_t selectedTick = 0;
    bool     haveTick = false;
    Vec2     lastMoveDir{};   // last committed heading — directional-commitment memory (plan 63)
    uint8_t  dampStreak = 0;  // consecutive soft-damped route ticks (plan 76 heading commitment);
                              // capped at kUMaxDampTicks so a genuine required turn is never delayed
    void Reset()
    {
        selectedCandidate = kStandCandidate;
        selectedTick = 0;
        haveTick = false;
        lastMoveDir = {};
        dampStreak = 0;
    }
};

// Published to the overlay each frame (read on the render thread).
struct DebugSnapshot {
    bool     active = false;
    Decision decision = Decision::None;
    uint8_t  solveKind = 0;   // Solver::SolveKind (Hold/Safe/Fallback/Surrounded)
    Vec2  player{};
    Vec2  intentDir{};
    Vec2  moveTarget{};
    bool  overrideActive = false;
    bool  moveFailed = false;
    int   candidate = kStandCandidate;
    float speedScale = 1.f;
    int   threatCount = 0;
    float standClearance = kHugeClearance;  // ≤ 0 = danger covers current position
    float speed = 0.f;        // tiles/ms — for drawing candidate rays
    float stepTiles = 1.f;
    float reactMargin = 0.60f;
    uint32_t tickId = 0;      // map's NewTick stamp
    bool  tickValid = false;
    bool  rebuiltThisFrame = false;  // true = full layout rebuild; false = re-anchored
    bool  fieldActive = false;
    Vec2  fieldTarget{};
    Vec2  flowDir{};             // threat-flow arrow (plan 63)
    float flowCoherence = 0.f;   // 0..1 flow coherence (plan 63)
    bool  hasLockTarget = false;
    Vec2  lockTarget{};
    Vec2  path[kMaxPathPoints]{};   // planned route polyline (world coords) — plan 60,
                                    // now re-used to carry the worker grid route for the overlay
    int   pathCount = 0;
    bool  drawPath = true;          // gate the route overlay (udodgeDrawPath — plan 61)
    // ── Worker grid-route overlay (FIX: draw the pathfinder route) ──────────────
    // Published from the cached PlanResult each tick so the user can SEE the planned
    // path and what it avoids. path[0..pathCount-1] is the route polyline (world);
    // routeGoal is the durable-safe goal cell; inRangeRadius (>0 when a boss is
    // locked) is the weapon-range disk the route is constrained to, drawn around
    // map.lockPos. Enemy exclusion circles come from map.enemies (radius per body).
    bool  hasRoute = false;
    Vec2  routeGoal{};
    // Dodge route status (why the plan looks the way it does) — surfaced in the
    // overlay header so path behavior is diagnosable at a glance.
    bool  routePartial    = false;  // no durable pocket time-reachable → heads to safest-reachable
    bool  routeExpanded   = false;  // window grew past the base radius to find a goal
    bool  routeOutOfRange = false;  // locked: no in-range pocket → routed OUTSIDE weapon range (fled)
    float routeGoalDist   = 0.f;    // route arc-length to the goal (tiles)
    float inRangeRadius = 0.f;
    CandidateDebug candidates[kCandidateCount]{};
    DangerMap map{};
    // ── Navigation (walk-to) overlay + weight heatmap ────────────────────────
    bool  drawWeights = false;      // render the pathfinder-visibility heatmap (settings.debugWeights)
    float hitScale    = 1.f;        // for the heatmap's server-accurate PointSafety
    bool  safeWalk    = true;       // fold hazard into the heatmap's wall coloring
    bool  navActive   = false;      // a walk-to A* is in progress → draw its route + window
    bool  navPartial  = false;      // route only reaches toward the goal (goal outside window / blocked)
    int   navWptCount = 0;
    Vec2  navWpts[kMaxNavWpts]{};   // A* route polyline (world; [0] = player)
    Vec2  navGoal{};                // the clicked walk-to spot
    Vec2  navStepTarget{};          // the immediate steering target along the corridor
};

} // namespace UDodge
