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
constexpr int kMaxEnemies     = 64;
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
// Baked command-latency safety pad (tiles): keep the chosen point this far
// clear of the server hit boundary so a bullet seen one RTT ahead of our read
// can't clip it. NO user setting.
constexpr float kULatencyPad = 0.10f;

// Smart-direction objective weights over the SAFE candidate set. Safety is a
// hard constraint (every scored point is already provably safe); these only
// choose AMONG safe points and can never trade safety away.
constexpr float kSolveCommitW      = 1.0f;  // directional continuity (anti-jitter)
constexpr float kSolveGoalW        = 0.8f;  // goal/WASD progress (fades near danger)
constexpr float kSolvePerpW        = 1.2f;  // lateral sidestep vs radial flee/charge: strong enough
                                            // that a left/right sidestep beats a backpedal's clearance edge
constexpr float kSolveMoveW        = 1.2f;  // minimal-disruption penalty (prefer nearest safe)
constexpr float kSolveClearW       = 0.25f; // gentle comfort tiebreak, capped
constexpr float kSolveClearComfort = 1.0f;  // clearance (tiles) above which comfort stops rewarding
constexpr float kSolveStandBias    = 0.15f; // score the stand point gets so we don't twitch off a safe stand
constexpr float kSolveOutRangeW    = 1.6f;  // penalty per tile a dodge point sits OUTSIDE the boss
                                            // weapon range — prefer dodging inward, stay in shooting range

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
constexpr float kULookaheadTiles = 6.0f;  // horizon radius for the durable-pocket search (tiles)
constexpr float kUPocketMargin   = 0.35f; // clearance (tiles) a cell needs BEYOND the hard safety
                                          // boundary (PointSafety already folds in the bullet half +
                                          // player half) to count as a DURABLE pocket — and the
                                          // comfortable margin the current spot needs to just HOLD
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
constexpr int   kUTemporalSteps    = 5;      // march samples beyond t=0 (horizon = steps × stepMs)
constexpr float kUTemporalStepMs   = 100.f;  // coarse march step (~half a server tick) — swept-segment
                                             // checks between samples prevent a fast bullet tunnelling
// horizon = kUTemporalSteps × kUTemporalStepMs = 500 ms ≈ 2.5 server ticks
constexpr float kUTemporalCullTiles = 8.f;   // only predict bullets whose traced path passes within this
                                             // radius of the player over the horizon (skip far/receding)

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
    bool  lockFollow  = false;   // consume DangerPlanner external goal as intent
    bool  followLantern = false; // Autopilot: stand-on object scan (perf cost)
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
    void Reset()
    {
        selectedCandidate = kStandCandidate;
        selectedTick = 0;
        haveTick = false;
        lastMoveDir = {};
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
    Vec2  path[kMaxPathPoints]{};   // planned route polyline (world coords) — plan 60
    int   pathCount = 0;
    bool  drawPath = true;          // gate the route overlay (udodgeDrawPath — plan 61)
    CandidateDebug candidates[kCandidateCount]{};
    DangerMap map{};
};

} // namespace UDodge
