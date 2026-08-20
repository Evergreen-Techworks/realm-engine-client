#pragma once

#include <cstdint>
#include <cmath>
#include <algorithm>

// UDodge — unified auto-dodge: PJDodge predictive core + RePP field
// escape/goal layer. Pure data + inline math. No game/IL2CPP includes.
namespace UDodge {

// ── Candidate layout ────────────────────────────────────────────────────────
// 0 = stand, 1..32 = compass headings, 33 = intent, 34 = field escape.
constexpr int   kDirectionCount  = 32;
constexpr int   kStandCandidate  = 0;
constexpr int   kIntentCandidate = kDirectionCount + 1;   // 33
constexpr int   kFieldCandidate  = kDirectionCount + 2;   // 34
constexpr int   kCandidateCount  = kDirectionCount + 3;   // 35
constexpr float kTwoPi           = 6.28318530717958647692f;

// ── Map capacities (fixed buffers — zero per-frame heap allocation) ─────────
constexpr int kMaxProjectiles = 96;
constexpr int kMaxPathSamples = 24;
constexpr int kMaxAoes        = 32;
constexpr int kMaxEnemies     = 64;
// Whole-window planner route cap (plan 60). Defined here so both the plain-data
// Planner (UDodgePlanner.h, nested namespace) and DebugSnapshot below can see it.
constexpr int kMaxPathPoints  = 48;

// ── Controller constants (reference-tuned; tiles) ───────────────────────────
// Wide reaction space substitutes for the deleted time/lead dimension: the
// dodge starts moving while a bullet is still ~0.6 tiles off its hitbox (not
// 0.08 = essentially touching), and keeps that buffer. Relevance is raised so
// threats are considered far enough out to position for the wider buffer.
constexpr float kRelevanceClearance       = 2.0f;   // "could this shot matter" pad
constexpr float kIntentSafeClearance      = 0.60f;  // safety floor for keeping/blending intent
constexpr float kEmergencyIntentBand      = 0.30f;  // clearance we may trade for intent in emergencies
constexpr float kUnavoidableClearanceBand = 0.05f;
constexpr float kHysteresisScoreGain      = 0.25f;  // hold the chosen heading unless beaten by this much
constexpr int   kCorridorNeighbors        = 3;      // half-width of the corridor-safety window

// ── Smart-dodge weighted score (plan 63; baked-in, NO user sliders) ─────────
// ScoreOf re-ranks ONLY within the already-safety-floored candidate set, so
// these convert a straight retreat into a committed lateral sidestep without
// ever overriding a hard-safety filter. Ratios mirror RePP (1.5 / 5.0 / 2.5)
// with perp scaled to 3.0 because UDodge re-ranks within the floored set.
// Change here + recompile if the feel needs tuning.
constexpr float kUScoreClearW   = 1.5f;   // clearance reward (top end +4×1.5 = +6 dominates)
constexpr float kUScorePerpW    = 3.0f;   // perpendicular-sidestep reward (anti-flee)
constexpr float kUScoreIntentW  = 2.0f;   // goal/WASD alignment reward
constexpr float kUScoreCommitW  = 2.5f;   // directional-commitment reward (anti-jitter)
constexpr float kUScoreSoftW    = 1.0f;   // pending-zone penetration penalty
constexpr float kUScoreDeadband = 0.4f;   // hysteresis flip deadband (score units)

// Whole-window plan freshness gate (plan 63): a plan older than this many
// publish sequences NEVER drives movement (no wander on worker contention).
constexpr uint32_t kUPlanMaxStaleSeq = 8;

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

// ── Instantaneous danger map (plan 45) ──────────────────────────────────────
// Present-tense spatial danger only. No time values are stored: lane points
// are the projectile's LIVE position followed by its remaining travel path as
// pure geometry; zones are discs classified active (hard) / pending (soft).

constexpr int   kMaxLanePoints    = 24;     // per-lane polyline cap
constexpr float kHugeClearance    = 1.0e9f; // "no danger anywhere" sentinel
constexpr float kServerTickSec    = 0.2f;   // planning quantum: one server tick of motion
constexpr int   kCandProbes       = 16;     // candidate-segment probe intervals
constexpr float kCorridorCap      = 0.75f;  // per-neighbor clearance cap in corridor sum
constexpr float kClearBucket      = 0.1f;   // clearance bucketing for lexicographic compare
constexpr float kTraceStepMs      = 30.f;   // sensor-internal geometry tracing step —
                                            // time never leaves the sensor

struct LaneThreat {
    int32_t  bulletId      = 0;   // identity for mid-tick re-anchoring...
    int32_t  attackerObjId = 0;   // ...(bulletId alone is not globally unique)
    uint32_t ownerObjId    = 0;
    float    hitHalf       = 0.5f; // game IsHit Chebyshev half (same rule as before)
    int      pointCount    = 0;
    Vec2     points[kMaxLanePoints]{};   // points[0] = live position (anchor)
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

struct CoreOutput {
    bool  overrideActive = false;
    Vec2  velocity{};          // tiles per ms (speed scale already applied)
    int   candidate = kStandCandidate;
    float speedScale = 1.f;
    int   threatCount = 0;
    float standClearance = kHugeClearance;  // ≤ 0 = danger covers current position
    Decision decision = Decision::None;
    bool  fieldActive = false;   // field candidate was generated this frame
    Vec2  fieldTarget{};         // pocket cell (world) the field routed to
    Vec2  flowDir{};             // aggregate threat-flow direction (plan 63; debug only)
    float flowCoherence = 0.f;   // 0..1 flow coherence (plan 63; debug only)
    CandidateDebug candidates[kCandidateCount]{};
};

// Cross-frame controller state (tick-locked hysteresis). Heading held while
// the server tick is unchanged; re-decided at each NewTick sync.
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
