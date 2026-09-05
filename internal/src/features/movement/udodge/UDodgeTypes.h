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
// Dense exaltation/O3 patterns can exceed the old 96-shot buffer. Overflow was
// order-dependent and silently removed real lanes. 192 remains a bounded,
// allocation-free snapshot within Temporal::Ctx's stack budget; Sensors also
// orders shots nearest-first before filling it.
constexpr int kMaxProjectiles = 192;
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
// SPEED-INDEPENDENT ON PURPOSE — do not "fix" this into a speed-scaled pad.
// kULatencyPad gates the SPATIAL tests only, and those measure against a whole
// LANE: the lane already covers the bullet's entire forward path over the trace
// window, so it is infinitely conservative in time and a faster bullet does not
// end up sitting any closer to it. The margin that genuinely has to absorb
// speed-scaled error is the TEMPORAL one (kUArrivalMargin + kUPredErrMs below),
// because that one compares a bullet and the player at an INSTANT. An earlier
// plan (78, "Hole E") diagnosed the speed sensitivity here; the audit corrected
// it to the arrival margin. Leaving this note so it is not re-opened.

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
// Extra locked-target engagement pull. Applied only among candidates that have
// already passed every spatial/temporal safety gate, so it makes the dodge take
// an equally-safe inward/threading step instead of drifting away from the fight.
constexpr float kSolveLockGoalW    = 1.0f;
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
//
// KEPT (not retired) now that the durability gradient below exists, because the
// two say different things and only one of them is "stay ON the pattern":
// threading is a STANCE (I am inside the pattern and the gap opens for me),
// durability is a MEASUREMENT (nothing reaches this cell for N ms). Open space is
// durable BY DEFINITION, so a gradient alone would hand every retreat the maximum
// reward and quietly invert the very preference this term was added for — the
// dodge would refuse to enter a room whose shot-walls must be weaved. So the flat
// term keeps holding the pattern and the gradient RANKS WITHIN each stance: the
// thread that stays open longest beats the one that closes immediately, and the
// open cell nothing crosses beats the open cell a wall sweeps in 350 ms.
constexpr float kSolveWeaveW = 0.50f;   // flat reward for a threaded (in-gap) candidate
// ── TEMPORAL DURABILITY GRADIENT ────────────────────────────────────────────
// Everything the temporal layer produced used to be BINARY: a candidate either
// survived the kUDwellMs dwell window or it did not, and after admission ranking
// fell back to Cand::clr — INSTANTANEOUS clearance, which knows nothing about the
// future. A cell that stays clear for the whole 800 ms horizon and a cell a wall
// sweeps at 310 ms therefore scored IDENTICALLY, and the solver had no way to
// prefer durable safety or to express "that gap is opening, go there".
//
// This is the term that scores it: (time-to-danger − kUDwellMs) / (horizon −
// kUDwellMs), clamped to [0,1] — 0 for a candidate that survives admission and no
// more, 1 for one nothing reaches anywhere in the horizon. Free, because
// Core::Temporal::TimeToDanger already computes that time on the way to the
// admission answer and used to throw it away.
//
// 0.30 is deliberately SMALLER than kSolveWeaveW and much smaller than the
// positioning terms. Sized so it can:
//   • break a near-tie decisively — its 0..0.30 span is 2 × kSolveReflexHystEps,
//     so "same spot, but it survives 500 ms longer" wins;
//   • out-rank the comfort tiebreak (kSolveClearW × kSolveClearComfort = 0.125),
//     which is the correct precedence: how long a cell stays safe matters more
//     than how much room it has right now;
// and NOT:
//   • overturn the locked annulus (0.30 buys 0.30/kSolveOutRangeW ≈ 0.19 tiles of
//     out-of-range drift before the linear term alone erases it, and the quadratic
//     term erases it far sooner) — a durable-but-boring cell can never win on time;
//   • buy distance (kSolveMoveW = 1.2 per budget) or beat the lateral-sidestep
//     term (kSolvePerpW = 1.2), so "durable" never turns into "run away".
// It also does NOT double-count with kSolveStandBias: the stand only reaches the
// scored set when the HOLD gate already declined it, and it is measured on exactly
// the same basis as every move candidate (walk-then-hold, zero-length walk).
constexpr float kSolveDurableW = 0.30f;   // full reward for staying clear through the whole horizon
// THE OVER-CORRECTION GUARD. Open space is durable by definition, so if the
// gradient could ever out-weigh the threading stance the dodge would start
// treating "retreat off the pattern" as the best-scoring option and refuse to
// enter shot-wall rooms at all — the exact failure kSolveWeaveW was added to
// prevent. Keeping the gradient strictly below it bounds the worst case: a
// threaded candidate that survives admission and no more (dur 0) still out-scores
// a perfectly durable open one (dur 1) by kSolveWeaveW − kSolveDurableW. The
// gradient therefore only ever re-orders WITHIN a stance; it never flips one.
static_assert(kSolveDurableW < kSolveWeaveW,
              "the durability gradient must not out-shout the threading stance (see kSolveWeaveW)");
constexpr float kSolveStandBias    = 0.15f; // score the stand point gets so we don't twitch off a safe stand
// ── PENDING-ZONE SOFT COST (finding G-2) ────────────────────────────────────
// A pending (telegraphed, not-yet-landed) AoE disc is documented as "cost-only
// (soft)" in five places across this engine — and no cost term existed anywhere.
// Nothing read a pending zone at all, so a bomb 1.2 s from landing was FULLY
// INVISIBLE: the solver would happily hold in its dead centre and the planner
// would call that a durable pocket, only to have to flee at 0.9 s when the arm
// window opened. Churn, and a wasted route.
//
// This is the missing term: a SCORE penalty per tile a candidate sits INSIDE a
// pending disc (+ kUPlayerHalf), applied over the ALREADY-SAFE set only — exactly
// like kSolveInnerW. It is NEVER a filter. If the only safe cells are inside the
// telegraph the player still dodges there (safety wins outright) and this simply
// pulls back out on the next tick, which is the whole point of "soft".
//
// 0.6/tile: at one tile of penetration it outweighs the stand bias and the
// comfort tiebreak, so we drift off a telegraphed spot when anywhere equal is
// available, without out-shouting goal progress or the lateral-sidestep term.
constexpr float kSolvePendingW   = 0.6f;
// Ceiling on the total penalty (score units). Penetration is a SUM over discs and
// a disc radius runs to 12 tiles, so an uncapped term could reach ~-20 and become
// a de-facto hard filter — the one thing a pending zone must never be. 2.0 is
// firmly decisive against every other term while staying a preference.
constexpr float kSolvePendingMax = 2.0f;

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

// Do not plan at the projectile's mathematical lifetime boundary. Target motion,
// MOVE-record quantization and one frame of launch latency can all turn a
// center-to-center shot at that exact radius into a miss. Lock mode therefore
// uses an engagement radius inset from physical projectile travel. The existing
// route slack and return hysteresis operate inside that reserve.
constexpr float kUEngagementRangeInset = 0.75f;

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
constexpr float   kURetreatGoalDetourMs = 320.f; // bounded extra arrival time to escape toward known ground
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

// SPEED TERM on the arrival margin. kUArrivalMargin above is a fixed COMFORT
// slack, but the errors the temporal test actually has to absorb are TIMING
// errors, and a timing error becomes a DISTANCE error in proportion to how fast
// the bullet is moving: the same 20 ms of slop is ~0.12 tiles on a 6 tiles/s
// shot and ~0.24 on a 12 tiles/s one. So the effective margin is
//     half + kUArrivalMargin + laneSpeed x kUPredErrMs
// with laneSpeed precomputed per lane at Ctx build time (Core::Temporal::Build),
// which leaves PathClear / ArrivalClear at exactly their previous per-candidate
// cost.
//
// kUPredErrMs is "how far in TIME the prediction may be off", and it is sized
// from the two irreducible timing errors in this pipeline:
//   • spawnTick / elapsed comes from GetTickCount64, whose resolution is one
//     scheduler tick (~15.6 ms) — the bullet's phase along its own path is only
//     ever known to that precision;
//   • one 60 fps frame (~16.7 ms) passes between the solve and the move actually
//     being applied, during which the bullet keeps moving.
// They are independent for a typical-error estimate, but a safety gate must cover
// the case where both delays point the same way. Their conservative sum is about
// 32.3 ms, so use 35 ms (including a small scheduling allowance). The old 20 ms
// value was below even the ~23 ms RMS estimate documented here and admitted
// boundary-threading candidates a fraction of a tile too early. The swept tests
// already cover geometric chord error; this term covers timing error only. The
// march grid's 100 ms spacing is NOT in here: steps are swept, not endpoint-only.
constexpr float kUPredErrMs = 35.f;
// Ceiling on the speed term (tiles). Keep malformed/ghost speeds bounded without
// truncating the new 35 ms allowance for ordinary fast shots: 0.45 tiles covers
// roughly 12.9 tiles/s. Refusing to move is its own way of dying, so this remains
// a firm cap rather than allowing an arbitrary sampled speed to inflate the map.
constexpr float kUPredPadMaxTiles = 0.45f;

// Clearance (tiles) a cell needs BEYOND the server hit boundary to count as a
// DURABLE resting pocket / route goal, and the comfort a HELD stand keeps. This
// is a RESTING-comfort knob, deliberately independent of the arrival-thread knob
// above: a hold/goal should stay comfortable even as threading gets tighter.
constexpr float kUDurablePocketMargin = 0.18f;
constexpr int   kUPocketRings    = 12;    // concentric rings out to kULookaheadTiles (0.5-tile step)
constexpr int   kUPocketAngles   = 24;    // angular samples per ring (15° resolution)
constexpr float kSolveFallbackPocketW = 0.5f; // fallback: bias the least-bad step toward the pocket/gap
constexpr float kSolveFallbackBackW   = 0.35f; // no-safe-cell fallback: prefer the known corridor behind us

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
// kUDwellMs is how long AFTER ARRIVAL a candidate must stay clear. One server
// tick is enough to guarantee the next solve can leave while still allowing a
// deliberate cross in front of a shot; the previous 300 ms requirement turned
// short-lived openings into permanent walls. Past kUDwellMs a lane
// simply STOPS being tested against the held position — it is not treated as a
// hit, it is treated as "the next solve's problem", which is literally true.
// NOTE: the STAND-durability gate deliberately opts OUT of this (it passes the
// full horizon) — detecting a slow-closing wall early is the whole point of that
// query, and there the stand-still assumption is the honest one.
constexpr float kUDwellMs = 200.f;

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
constexpr float kUInRangeSlack = 0.20f;  // small grid-quantization grace around the already-inset
                                         // engagement radius; never extends to physical max range

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

// ── General enemy standoff (EVERY enemy, lock or no lock; baked, NO sliders) ─
// Hard clearance beyond the estimated enemy body and the player's hit half. This
// is intentionally shared by the live solver and worker pathfinder: ending a step
// closer than this is never an acceptable resting point. Their path tests retain
// the existing escape exception when an enemy has already moved onto the player.
constexpr float kUEnemyKeepoutGap = 0.75f;
// The annulus above only exists while a boss is LOCKED. With no lock the ONLY
// thing holding the player off a mob was Core::EnemyBlocked's HARD exclusion at
// kEnemyRadius + kUPlayerHalf (~1.01 tiles from the enemy CENTRE) — and
// kEnemyRadius is one baked value for every mob (EnemyBlocker carries no per-type
// size), so on a large boss body that circle sits INSIDE the sprite: the player
// ends up standing on top of it. This term is the missing preference.
// It is a SCORE term over the already-SAFE candidate set, modelled on
// kSolveInnerW, and it is NEVER a filter: if the only safe cells are on top of a
// mob the player still dodges there and drifts back out on the next tick. Safety
// always wins over standoff. It does not widen kEnemyRadius / EnemyBlocked (the
// shared solver+pathfinder radius, which also decides what the ROUTE treats as
// impassable) — this is a preference layered on top, not a bigger wall.
// Measured as the GAP from that same hard-exclusion circle
// (dist - (radius + kUPlayerHalf)), so it is anchored to the body surface the
// exclusion already defines and stays correct if per-objType radii ever land in
// EnemyBlocker::radius. Ramps quadratically with closeness — strongest right on
// the body, fading to nothing at the band edge — so it reads as "prefer to sit
// out here, come in if you must" rather than a step the dodge fights against.
constexpr float kSolveStandoffBand = 2.0f;  // gap (tiles) over which the penalty fades to ZERO.
                                            // ~3.0 tiles from an enemy CENTRE — clear of any realistic
                                            // sprite, yet inside every weapon range (even a melee reach
                                            // of ~3 tiles), so it pushes the dodge off the body without
                                            // ever refusing to approach one.
constexpr float kSolveStandoffW    = 1.6f;  // penalty AT the body surface (gap 0). Matched to
                                            // kSolveInnerW / kSolveOutRangeW so sitting on a mob is never
                                            // the cheapest option, and above a full-budget move
                                            // (kSolveMoveW = 1.2) so the solver will spend a whole step to
                                            // get off one. The quadratic ramp keeps it at only ~0.4 by
                                            // half the band, where it cannot outweigh the goal-progress /
                                            // lateral-sidestep terms that make the dodge work.
// A durable-pocket HOLD returns before any candidate is scored, so a player parked
// on a mob would never see the term above. When the stand is this close to a body
// the solver declines that early Hold and runs the normal reflex, where the score
// drifts us outward among SAFE candidates (and re-picks the stand anyway when
// nothing better exists) — the same soft shape kSolvePendingW uses for telegraphs.
// Deliberately TIGHTER than the score band: the score only reorders candidates we
// are already choosing between, whereas this spends a whole reflex solve, so it
// must fire when the player is genuinely sitting on a mob — not merely fighting at
// close range, which would churn the reflex every tick.
constexpr float kSolveStandoffHoldGap = 0.9f;   // ~1.9 tiles from an enemy CENTRE

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

// ── BOUNDED WAIT EDGE (finding F) ───────────────────────────────────────────
// g(cell) in the pathfinder is ARRIVAL TIME and every edge advances time by
// exactly the travel time, so without a self-edge the search cannot express the
// single most important move in a shot-wall fight: "stand here for a moment, let
// the wall pass, THEN go". The solver's temporal layer (Temporal::PathClear)
// threads exactly that gap, so the two halves of the two-rate MPC were using
// opposite criteria for the same cell.
//
// The wait is expressed as a DELAYED DEPARTURE on an ordinary edge, not as a new
// state dimension: when the direct relaxation cur→ni fails the arrival gate, the
// search retries departing w slices later (arriving w slices later), gated by
// ArrivalClear over the whole stand at `cur`. Because Dijkstra records only the
// EARLIEST arrival at a cell, a delayed arrival is only ever recorded where no
// earlier one exists — a wait can create a route, never replace a faster one.
//
// The cap is what keeps this bounded. 2 slices = 200 ms = ONE server tick = one
// replan period: the longest wait that is still consistent with the whole plan
// being recomputed and republished before it elapses. Waiting longer would be
// planning past the point where the plan is thrown away. A wait is additionally
// refused once the departure time reaches Core::Temporal::kHorizonMs, because
// past the horizon the prediction is a conservative freeze — there is nothing
// left to wait out, and unbounded waiting would otherwise walk arrival times off
// the end of the model. See UDodgePathfinder.cpp SearchPass.
constexpr int   kUPathMaxWaitSlices = 2;   // ≤ 2 × kUTemporalStepMs = 200 ms = one server tick

// ── PENDING-ZONE GOAL DETOUR (finding G-2) ──────────────────────────────────
// A pending (telegraphed, not yet landed) AoE disc is COST-ONLY and must never
// hard-block — but the route goal test never costed it at all, so the planner
// would happily commit to the dead centre of a bomb 1.2 s out and then have to
// flee when it armed. This is how much LATER an arrival the goal search will
// accept in order to reach a goal cell that is NOT inside a pending disc. Two
// server ticks: a pending disc is at most ~kAoeArmWindowMaxMs from arming (after
// which it hard-blocks anyway), so paying two ticks of travel to not be standing
// in it when it lands is cheap. Never a filter — when no clean goal turns up
// inside the budget, the tainted goal is still used.
constexpr float kUPathPendingDetourMs = 400.f;

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
constexpr float kUNavSinkCost    = 3.0f; // extra A* cost to ENTER sink/slow ground (shallow water,
                                         // quicksand, honey). These tiles carry <Sink>/<Sinking> and a
                                         // speed multiplier of ~0.25-0.75 — they are SLOW, not walls.
                                         // Genuinely impassable water carries <NoWalk> as well and is
                                         // already a hard block via WorldTAB's blockedMap, so this cost
                                         // is what expresses "prefer dry land, but wade when that is the
                                         // way". Below kUNavHazardCost: wet is cheaper than burning.
constexpr float kUNavHazardCost  = 6.0f; // extra A* cost to ENTER a DAMAGING cell (lava/venom, safeWalk
                                         // only): routes around it when a clean path exists, but still
                                         // traverses it when boxed in (never a hard wall — a hazard-floored
                                         // arena must path). SINK/WATER is NOT priced here: it is impassable
                                         // for nav (NavGrid bit2 / NavBlocked), because no per-tile cost that
                                         // still loses to a long shoreline detour can stop walk-to from
                                         // swimming a lake the player cannot cross.

// The route step-target (the "anchor" the player drives toward) is placed this
// many move-budgets ahead along the route polyline, NOT one. At one budget the
// player reaches it in a single tick and then STALLS until the next worker plan
// (~1 tick latency) — a visible catch-up-and-stall stutter. A few budgets of
// runway keep the player moving continuously; the actual per-tick step is still
// one budget (min(dist, budget)) and still temporally validated, so lookahead
// only smooths the drive, never the safety.
constexpr float kUStepLookaheadBudgets = 1.25f; // short-lived combat route anchor; refreshed every tick
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
    float positionUncertainty = 0.f; // local desired vs server-visible MOVE position [0, .35]
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
    float laneTiles = 12.f;  // danger-lane PAINT length (tiles)      [2, 16]
                             // How far along a bullet's traced path counts as dangerous
                             // RIGHT NOW (LaneThreat::instantCount) — the overlay length
                             // and the instantaneous safety/cost field. It no longer caps
                             // the trace itself: the polyline is traced by TIME
                             // (kLaneCoverMs) so the temporal lookahead is never blind
                             // past this slider. Bigger = more timid instantaneously.
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
    // Worker-safe occupancy snapshot. When canOccupy is null, the solver reads
    // these copied flags instead of touching WorldTAB/game memory.
    const uint8_t* occFlags = nullptr;
    Vec2 occCenter{};
    int occSide = 0;
    int occRadius = 0;
    float occCellTiles = 0.f;
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

// ── Lane trace budget: TIME-capped, not distance-capped ─────────────────────
// A lane is the bullet's spacetime polyline, and the temporal lookahead can only
// see as far as the polyline reaches. Truncating it by DISTANCE (the old
// `pathLen >= laneTiles` break) made a lane's TIME coverage a function of bullet
// speed: at 25 tiles/s the default 12-tile lane covered only 480 ms, so
// SampleLaneTimes froze the bullet at 480 ms and every cell it swept over
// [480, 800] ms read CLEAR. That silently BROKE the conservative-freeze
// invariant (UDodgeCore.cpp) for exactly the fast shots it mattered for.
//
// The trace is now capped by TIME: every lane covers at least kLaneCoverMs.
// `laneTiles` survives as the PAINT span (LaneThreat::instantCount) — how far
// along the polyline the PRESENT-TENSE tests and the overlay treat as dangerous
// right now — so the user slider still does exactly what its label says while the
// temporal layer always has samples out to its horizon.
//
// kLaneCoverMs = the temporal horizon + one server tick of pad. The pad is what
// ReanchorMap eats: between server-tick BuildMaps a straight lane is re-anchored
// by dropping its leading points, which shortens its coverage from NOW by up to
// one tick. Without the pad every re-anchored lane would fall short of the
// horizon and trip the unknown-tail floor below.
constexpr float kLaneCoverPadMs   = 250.f;  // ≥ one server tick (kServerTickSec) of re-anchor decay
constexpr float kLaneCoverMs      = kUTemporalSteps * kUTemporalStepMs + kLaneCoverPadMs;   // 1050 ms
constexpr float kTraceStepMs      = 30.f;   // sensor-internal geometry tracing step —
                                            // time never leaves the sensor
// 36 points × 30 ms = 1050 ms of coverage at the SAME 30 ms resolution as before
// (raising the step instead would have chorded wavy/turning shots more coarsely).
// Memory: 12 B/point (Vec2 + float) × kMaxProjectiles(192) = 2.25 KB per extra
// point, so 24 → 36 costs ~13.8 KB per DangerMap (29.6 → 43.4 KB). There are a
// handful of DangerMaps (g_map, two PlannerSnapshots, the debug slot) and they
// are all statics/globals, so this is ~70 KB of BSS, not stack.
constexpr int   kMaxLanePoints    = 36;     // per-lane polyline cap
static_assert(static_cast<float>(kMaxLanePoints - 1) * kTraceStepMs >= kLaneCoverMs,
              "lane point budget must reach kLaneCoverMs at kTraceStepMs resolution");
constexpr float kHugeClearance    = 1.0e9f; // "no danger anywhere" sentinel
constexpr float kServerTickSec    = 0.2f;   // planning quantum: one server tick of motion

struct LaneThreat {
    int32_t  bulletId      = 0;   // identity for mid-tick re-anchoring...
    int32_t  attackerObjId = 0;   // ...(bulletId alone is not globally unique)
    uint32_t ownerObjId    = 0;
    float    hitHalf       = 0.5f; // game IsHit Chebyshev half (same rule as before)
    int      pointCount    = 0;    // FULL spacetime polyline (time-capped: covers kLaneCoverMs
                                   // or the shot's death, whichever comes first). TEMPORAL only.
    int      instantCount  = 0;    // leading points within the user's laneTiles PAINT span —
                                   // what every PRESENT-TENSE test (PointSafety / SegmentSafety /
                                   // PointClear) and the overlay read. Always <= pointCount.
                                   // Keeping these separate is what stops the longer trace from
                                   // silently widening the instantaneous danger field (and with it
                                   // the pathfinder's per-cell cost) behind the user's slider.
    bool     tailAtShotEnd = false;// the last point is where the SHOT ENDS (lifetime reached), so
    bool     provisional = false;  // packet-time ENEMYSHOOT recovery; runtime lane supersedes it
                                   // freezing the bullet there is a FACT. False means the trace
                                   // merely ran out — see the unknown-tail floor in UDodgeCore.
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

inline bool CanOccupyAt(const MapInput& in, Vec2 pos)
{
    if (in.env.canOccupy)
        return in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk);
    if (!in.env.occFlags || in.env.occSide <= 0 || in.env.occCellTiles <= 0.f)
        return true;
    const int gx = static_cast<int>(std::lround((pos.x - in.env.occCenter.x) /
                                                in.env.occCellTiles)) + in.env.occRadius;
    const int gy = static_cast<int>(std::lround((pos.y - in.env.occCenter.y) /
                                                in.env.occCellTiles)) + in.env.occRadius;
    if (gx < 0 || gy < 0 || gx >= in.env.occSide || gy >= in.env.occSide) return false;
    const uint8_t f = in.env.occFlags[gy * in.env.occSide + gx];
    if (f & 0x1) return false;
    if (in.settings.safeWalk && (f & 0x2)) return false;
    return true;
}

// Swept movement occupancy/hazard gate. Endpoint-only safe-walk permits a long
// diagonal to clip the corner of a damaging tile even though both ends are safe.
// Sample densely enough to cover the player's half-width; the live game-thread
// callback evaluates the real footprint, while worker snapshots use their 0.5-tile
// raster. When already on damaging ground, retain the existing escape rule: only
// require a safe endpoint so the starting tile cannot imprison the player.
inline bool OccupancyPathClear(const MapInput& in, Vec2 from, Vec2 to)
{
    if (!CanOccupyAt(in, to)) return false;
    if (in.playerOnHazard) return true;
    const float d = Len(Sub(to, from));
    const int steps = std::max(1, static_cast<int>(std::ceil(d / 0.20f)));
    for (int i = 1; i < steps; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(steps);
        if (!CanOccupyAt(in, Add(from, Mul(Sub(to, from), t)))) return false;
    }
    return true;
}

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
    float softCost  = 0.f;             // pending-zone penetration sum (tiles) — Core::PendingZoneCost.
                                       // Finding G-2: this was documented for the whole life of the
                                       // struct and NEVER written by anything, so it always read 0
                                       // and the overlay silently claimed "no telegraph here" while
                                       // sitting under a bomb. UDodge now fills slot kStandCandidate
                                       // (the stand) and slot 1 (the chosen target).
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
    bool  serverAnchorValid = false;
    Vec2  serverAnchor{};   // last clamped outbound MOVE point (server collision anchor)
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
    bool  routeTempGoal   = false;  // finding F: the goal is a second-class TEMPORAL pocket (no spatial
                                    // durable pocket existed anywhere in the window)
    float standPending    = 0.f;    // finding G-2: pending-zone penetration at the PLAYER (tiles)
    float targetPending   = 0.f;    // ...and at the solver's chosen target
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
