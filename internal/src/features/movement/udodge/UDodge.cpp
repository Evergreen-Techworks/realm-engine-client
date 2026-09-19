#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include "UDodgeNavigation.h"
#include "UDodgeGroupPreference.h"
#include "features/movement/nav/Runtime.h"
#include "UDodgeWorker.h"
#include "UDodgeSensors.h"
#include "UDodgeDebug.h"
#include "UDodgeEnemyHazards.h"
#include "UDodgeTelemetry.h"
#include "UDodgePredErr.h"
#include "UDodgeGoalOwner.h"
#include "UDodgeMapDiag.h"
#include "features/movement/nav/Speed.h"

#include "MovementRuntime.h"
#include "DbgFileLog.h"
#include "DiagTiming.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "DangerPlanner.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/combat/enemytracker/LockLiveness.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/CameraTAB.h"

#include <imgui/imgui.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <windows.h>

namespace UDodge {
namespace {

std::atomic<bool>  g_enabled{ false };
std::mutex g_groupMutex;
GroupPreference g_groupPreference{};
bool g_previousGroupActive = false;
Vec2 g_previousGroupPosition{};
int32_t g_previousGroupBoss = 0;
std::atomic<float> g_laneTiles{ 12.f };
std::atomic<float> g_stepTiles{ 0.f };
std::atomic<float> g_hitScale{ 1.0f };
// udodgePlanner. DEFAULT TACTICIAN on this private branch (S3.1); the public
// default is decided before any release.
std::atomic<uint8_t> g_planner{ static_cast<uint8_t>(Contact::Policy::Tactician) };
// udodgeRouteCommit (navigation finish plan, Item 1). ON by default: once a
// walk-to / lock-approach route is accepted, keep following it through a reflex
// detour instead of dropping it on every few-tile deviation; re-plan only on a
// real trigger. OFF reproduces today's behaviour exactly (the plain 5-tile
// deviation threshold, the 500 ms stall timer, no objective-changed trigger, no
// lattice snap under Classic). Lands under BOTH planner policies.
std::atomic<bool> g_routeCommit{ true };
// udodgeEnemyStandoff. AUTO by default: the owner's rule ("never walk near enemies,
// right on top of them, or in front of them to get shotgunned") is the safe
// behaviour, and `off` exists to A/B it against the pre-standoff engine.
std::atomic<uint8_t> g_enemyStandoff{ static_cast<uint8_t>(Standoff::Mode::Auto) };
std::atomic<float> g_reactMargin{ 0.60f };
std::atomic<bool>  g_safeWalk{ true };
std::atomic<bool>  g_speedScale{ true };
std::atomic<bool>  g_fieldEscape{ true };
std::atomic<bool>  g_debugOverlay{ true };
std::atomic<bool>  g_debugWeights{ false };
// Per-phase perf timing (QueryPerformanceCounter probes in Tick). Pure developer
// diagnostics — default OFF so shipped Release play pays nothing; a developer
// flips it on via SetDiagTiming to measure. Gates PhaseTimer + the 120-tick log.
std::atomic<bool>  g_diagTiming{ false };  // developer-only probes/logging; OFF in normal play
std::atomic<bool>  g_lockFollow{ false };
std::atomic<bool>  g_followLantern{ false };
std::atomic<bool>  g_autopilot{ false };   // autopilot auto-lock (default OFF)
// The enemy-lock id autopilot currently owns (0 = none). Distinguishes an
// autopilot-driven lock from the user's manual Shift+Click lock so that turning
// autopilot OFF releases only the auto-lock and never a manual lock.
std::atomic<int32_t> g_autopilotLockId{ 0 };
std::atomic<int>   g_standOnType{ 0 };
std::atomic<float> g_orbitRange{ 0.f };    // boss orbit standoff (tiles); 0 = auto
std::atomic<float> g_planRadius{ 20.f };   // planner window radius (grid cells) [8,40]
std::atomic<bool>  g_drawPath{ true };     // draw the plan-60 route overlay
std::atomic<bool>  g_moveEnvelope{ true }; // him-style local desired / clamped MOVE split
std::atomic<bool>  g_moveEnvelopeArmed{ false }; // proxy confirms outbound clamp is installed
std::atomic<float> g_serverPositionError{ 0.f }; // desired position ahead of last sent MOVE
std::atomic<float> g_serverAnchorX{ 0.f }, g_serverAnchorY{ 0.f };
std::atomic<bool>  g_serverAnchorValid{ false };
// udodgeFallbackSidestep (navigation finish plan, item 2). Default ON.
std::atomic<bool>  g_fallbackSidestep{ true };
// udodgeFrameBudget (navigation finish plan, item 4). AUTO by default.
std::atomic<bool>  g_frameBudgetAuto{ true };
// Target: p95 under 3 ms in a dense fight (navigation finish plan, Item 4
// acceptance). Measured against the same clock the phase timers use, checked
// once per Tick right before the solver phases.
constexpr double kFrameBudgetMs = 3.0;

// Last-resort signal for AutoNexus (plan 77). Written at the end of Tick, read
// via GetSafetyState from AutoNexus's poll thread. g_enabled (above) carries the
// `enabled` field; these three carry the rest. g_udSafetyTick advances once per
// Tick as a freshness guard for the consumer.
std::atomic<bool>     g_udExposed{ false };
std::atomic<float>    g_udStandClr{ 1e9f };
std::atomic<uint32_t> g_udSafetyTick{ 0 };
// udodge's COMMITTED next-move velocity (tiles/ms), so AutoNexus predicts the
// player along the dodge udodge is actually taking — not a straight coast (false
// nexus on shots udodge dodges) nor a frozen stand (misses the backstop). 0 = hold.
std::atomic<float>    g_udMoveVx{ 0.f };
std::atomic<float>    g_udMoveVy{ 0.f };
// Raw Solver::SolveKind of the last solve, published unconditionally (same
// reason as the AutoNexus signal above: a diagnostic/test consumer must not
// depend on the debug overlay flag). Navigation finish plan item 2 acceptance
// reads this to count Fallback frames; nothing production-facing consumes it.
std::atomic<uint8_t>  g_udSolveKind{ 0 };

// Nav wedge signal for auto-break-walls (plan 89). A pure OBSERVATION of the
// walk-to stuck detector below — it never feeds back into navReplan or any
// threshold. Written on the game thread inside Tick, read via GetNavWedge from
// the render thread.
std::atomic<bool>     g_wedgeWalkActive{ false };
std::atomic<bool>     g_wedged{ false };
std::atomic<float>    g_wedgeGoalX{ 0.f }, g_wedgeGoalY{ 0.f };
std::atomic<float>    g_wedgePlayerX{ 0.f }, g_wedgePlayerY{ 0.f };
std::atomic<uint32_t> g_wedgeStampMs{ 0 };

// Game-update thread only.
MovementCommitment g_commitment;
DangerMap  g_map;

// [Diag/PredErr] HitCulprit: closest-approach history for post-hoc hit
// attribution (UDodgePredErr.h). OFF unless diagOn; game-update thread only.
PredErr::HitCulprit::Ring g_hitHistory;
// [Diag/Ground]: edge-triggered damaging-ground steps (UDodgePredErr.h). OFF
// unless diagOn; game-update thread only.
PredErr::GroundDiag::State g_groundDiag;
// [Diag/Map]: Item 3 map-capture readiness observability (UDodgeMapDiag.h).
// OFF unless diagOn; game-update thread only.
MapDiag::State g_mapDiag;

// ── Decision telemetry (UDodgeTelemetry.h) ───────────────────────────────────
// OFF unless DiagTiming::On() (RE_ASSETS\diag-timing.flag, or the developer "Diag
// timing" checkbox). Tick touches these only while it is on; game-update thread only.
Telemetry::State g_telemetry;
struct TelemetryWorker {          // the latest worker cycle handed to the game thread
    float    dodgeMs = 0.f, navMs = 0.f, timedMs = 0.f, solveMs = 0.f;
    uint8_t  timedStatus = 0;
    bool     timedReused = false, timedBudgetHit = false;
    uint32_t seenSolveSeq = 0;    // g_solveSeq at the last sampled frame
};
TelemetryWorker g_telemetryWorker;

// ── Nav route cache (walk-to) ────────────────────────────────────────────────
// Navigation is NOT safety-critical (the micro-dodge handles shots), so we do not
// re-run the nav A* every tick. We cache the last planned route and just FOLLOW it,
// re-planning only on a real trigger: no route yet, the route is consumed (reached
// its end), the player got pushed far OFF it (by dodging), or the goal moved. This
// cuts the worker A* runs and the nav-grid rasterize (the walk-to perf cost).
struct NavCache {
    bool valid = false;
    Vec2 goal{};                 // walk-to goal this route was planned for
    int  n = 0;
    Vec2 wpts[kMaxNavWpts]{};     // route polyline (world; [0] = player at plan time)
    bool partial = false;        // route only reaches toward the goal (needs extending near its end)
    bool crossesHazard = false;
};
NavCache g_navCache;
// The objective the currently-cached route was last checked against (Item 1
// S1/S2), and an id that changes each time a genuinely new route replaces the
// cache (Item 1 S4 telemetry: route_id). Both reset when walk-to ends.
GoalOwner g_lastRouteObjective{};
uint64_t  g_routeId = 0;
Vec2 g_globalRawGoal{};
bool g_globalRawActive = false;
bool g_globalAssistance = false;
uint64_t g_globalCorridorEpoch = 0;
uint64_t g_globalCorridorGoalId = 0;
Navigation::Progress g_navProgress;
bool g_navAwaiting = false;
// Stuck memory (get-unstuck). A stall re-plans, but a re-plan over the same tile
// map returns the same route, so a blocker the map does not show (an object the
// world scan missed, say) held the player against it indefinitely. When a stall
// coincides with the game refusing our commanded steps, the square being pushed
// into is remembered for kNavAvoidMs and priced in the next A* (never a wall: a
// wrong guess costs a detour, not the route). Cleared with the walk goal.
struct NavAvoid { Vec2 pos{}; ULONGLONG untilMs = 0; };
NavAvoid g_navAvoid[kMaxNavAvoid]{};
int      g_navAvoidNext = 0;
int      g_refusedFrames = 0;         // consecutive commands the game granted < 25% of
ULONGLONG g_lastRefusedMs = 0;        // when the latest of those was measured
Vec2     g_lastCmdFrom{}, g_lastCmdTo{};
bool     g_lastCmdValid = false;
// Item 1 S2 refinement: edge-latch for the refused-streak route-invalidate
// trigger below, so ONE streak forces ONE immediate re-plan (like the
// self-resetting Navigation::Progress::Stalled), not a fresh forced re-plan
// every tick the streak stays fresh. Clears on a real successful command (a
// step the game actually granted) so a later, genuinely new streak can fire
// again; also cleared with the rest of the stuck memory.
bool     g_refusedStreakFired = false;
constexpr ULONGLONG kNavAvoidMs = 12000ULL;
constexpr int       kNavRefusedFramesForAvoid = 12;   // ~0.2 s of refusal at 60 FPS
constexpr ULONGLONG kNavRefusalFreshMs = 300ULL;       // a refusal older than this says nothing about now

// Active stuck-memory squares (expired entries skipped) into a plain array.
int ActiveNavAvoid(Vec2* out, ULONGLONG nowMs)
{
    int n = 0;
    for (const NavAvoid& a : g_navAvoid)
        if (a.untilMs > nowMs) out[n++] = a.pos;
    return n;
}

void ClearNavAvoid()
{
    for (NavAvoid& a : g_navAvoid) a = NavAvoid{};
    g_navAvoidNext = 0;
    g_refusedFrames = 0;
    g_lastRefusedMs = 0;
    g_lastCmdValid = false;
    g_refusedStreakFired = false;
}

// ── Stuck dump (field diagnostics; OFF unless RE_ASSETS/diag-timing.flag) ────
// One line per stall-or-blocked re-plan, at most one per 2 s: where the player is,
// where the route was steering, what the tile map says around them, and what the
// game did with our last step. It is the evidence for "the planner and the game
// disagree here" that the offline scenario harness cannot collect from a live map.
// Legend for the 11x11 map (1 tile per cell, player at the centre, north = -y row
// first): '.' open, '#' wall, 'f' FullOccupy half-tile rule at the centre, '~' sink,
// '!' damaging, ' ' unstreamed, 'a' a remembered stuck square.
void DiagStuckDump(const char* why, Vec2 player, Vec2 goal, Vec2 navStep, bool lockApproach,
                   const MapInput& in, const DangerMap& map, int avoidCount, const Vec2* avoid)
{
    static ULONGLONG s_lastMs = 0;
    const ULONGLONG now = GetTickCount64();
    if (s_lastMs != 0 && now - s_lastMs < 2000ULL) return;
    s_lastMs = now;

    constexpr int R = 5, S = 2 * R + 1;
    unsigned char cells[S * S];
    const Vec2 centre{ std::floor(player.x) + 0.5f, std::floor(player.y) + 0.5f };
    // '#' is the player box against walls (legacy) or the square itself (game rule).
    const Movement::Collision::Rule rule = Movement::Collision::GetRule();
    WorldTAB::CopyBoxBlocked(centre.x - static_cast<float>(R), centre.y - static_cast<float>(R), S, 1.f,
                             rule == Movement::Collision::Rule::Game ? 0.f : kUOccPlayerHalfEdge,
                             /*foldHazard=*/true, cells);
    char grid[S * (S + 1) + 1];
    int g = 0;
    for (int y = 0; y < S; ++y) {
        for (int x = 0; x < S; ++x) {
            const unsigned char f = cells[y * S + x];
            char ch = '.';
            if (f & 0x8) ch = ' ';
            else if (f & 0x1) ch = '#';
            else if (f & 0x10) ch = 'f';
            else if (f & 0x2) ch = '!';
            else if (f & 0x4) ch = '~';
            const Vec2 cw{ centre.x + static_cast<float>(x - R), centre.y + static_cast<float>(y - R) };
            for (int a = 0; a < avoidCount; ++a)
                if (std::fabs(cw.x - avoid[a].x) < 0.5f && std::fabs(cw.y - avoid[a].y) < 0.5f) ch = 'a';
            if (x == R && y == R) ch = '@';
            grid[g++] = ch;
        }
        grid[g++] = '|';
    }
    grid[g] = '\0';
    int activeZones = 0, nearEnemies = 0;
    for (int i = 0; i < map.zoneCount; ++i)
        if (map.zones[i].active && Len(Sub(map.zones[i].pos, player)) < map.zones[i].radius + 3.f) ++activeZones;
    for (int i = 0; i < map.enemyCount; ++i)
        if (Len(Sub(map.enemies[i].pos, player)) < 3.f) ++nearEnemies;
    DiagTiming::Logf("[Diag/Stuck] %s rule=%s at (%.3f,%.3f) goal=(%.2f,%.2f)%s step=(%.2f,%.2f) route=%d wpts=%d partial=%d"
        " hazardRoute=%d refused=%d avoid=%d safeWalk=%d liveOccupy(player)=%d liveOccupy(step)=%d"
        " nearZones=%d nearEnemies=%d map=%s",
        why, Movement::Collision::RuleName(rule), player.x, player.y, goal.x, goal.y, lockApproach ? " (lock approach)" : "",
        navStep.x, navStep.y, g_navCache.valid ? 1 : 0, g_navCache.n, g_navCache.partial ? 1 : 0,
        g_navCache.crossesHazard ? 1 : 0, g_refusedFrames, avoidCount, in.settings.safeWalk ? 1 : 0,
        CanOccupyAt(in, player) ? 1 : 0, CanOccupyAt(in, navStep) ? 1 : 0,
        activeZones, nearEnemies, grid);
}

// Locked target beyond engagement range: approached through the walk-to route
// pipeline toward its engagement disk (see Tick). The goal is frozen while the
// target stays within a tile of it, so a moving boss does not invalidate every
// worker result (walkMatches compares goals to 0.25 tiles).
bool    g_lockApproach = false;
bool    g_lockApproachGoalValid = false;
Vec2    g_lockApproachGoal{};
int32_t g_lockApproachId = 0;
// Distance-sampled dungeon breadcrumbs. Global (rather than Tick-local statics)
// so realm/location transitions can invalidate them explicitly.
Vec2 g_trail[16]{};       // newest at [0]
int  g_trailCount = 0;
constexpr float kNavGoalMoveTiles = 3.0f;   // goal moved this far → re-plan
constexpr float kNavDeviateTiles  = 5.0f;   // player pushed this far off the route → re-plan
constexpr float kNavEndTiles      = 3.0f;   // within this of the route's end → consumed → re-plan
// Per-tick safe-position solver result — game-thread-owned, cached for one
// server tick and re-validated (or re-solved) every frame (plan 64).
Solver::SolveResult g_solve;
// Item 4 follow-up (navigation finish plan, controller 2026-09-19): the
// liveSolve and revalidate phases below call Core::Temporal::Build with
// identical inputs when both run this Tick — see SharedCtx's contract in
// UDodgeSolver.h. Game-thread-only (this whole file is); reset to "not built"
// at the top of every Tick, never cleared mid-tick.
Solver::SharedCtx g_sharedTemporalCtx;
// Latest temporal-planner advice accepted from the worker, with the publish
// sequence it was computed for so the same staleness gate as the grid route
// applies. Advisory: the solver re-tests it against every hard floor.
Solver::TimedAdvice g_timed{};
uint32_t g_timedSeq = 0;
uint32_t            g_solveSeq = 0;
// Latest grid route from the async worker (plan 65). Game-thread-owned cache,
// refreshed from Worker::TryGetLatestPlan when the worker isn't busy; consumed by
// the solver as a lookahead bias. g_lastPubSeq is the newest snapshot sequence we
// published, used to gate route staleness (never chase a badly-stale plan).
Path::PlanResult g_route;
uint32_t         g_lastPubSeq = 0;

std::mutex    g_debugMutex;

// Heap-backed on purpose: as a plain global, MSVC (LTCG) const-promoted the
// identical snapshot in ZDodge into read-only .rdata, and PublishDebug's memcpy
// access-violated on the first byte. This one happens to land in .data today, but
// the promotion picked arbitrarily between identical globals — runtime-allocated
// storage cannot be const-promoted, so it can't regress.
// Intentionally never freed — the render thread may publish during DLL unload.
DebugSnapshot& DebugSlot()
{
    static DebugSnapshot* const slot = new DebugSnapshot();
    return *slot;
}

float Clamp(float value, float lo, float hi)
{
    if (!std::isfinite(value)) return lo;
    return std::clamp(value, lo, hi);
}
int ClampInt(int value, int lo, int hi) { return std::clamp(value, lo, hi); }

// Locked-target distances, shared by the approach decision and the orbit goal.
struct LockGeometry {
    float weaponRange = 6.f;
    float innerStandoff = 0.f;     // annulus inner radius (never fight point-blank)
    float engagementRange = 0.f;   // inset outer radius: shots connect reliably
    float standoff = 0.f;          // orbit standoff point distance
    float targetBand = 0.f;        // ENEMY STANDOFF: the locked target's band radius (0 = none)
};
LockGeometry ComputeLockGeometry(const Settings& settings, float targetBand)
{
    LockGeometry g;
    g.targetBand = targetBand;
    // Orbit the locked enemy at a standoff = resolved weapon range × 0.85
    // (the SetOrbitRange override feeds the standoff directly when non-zero).
    g.weaponRange = AutoAim::IsProjRangeResolved() ? AutoAim::GetProjRangeTiles() : 6.f;
    // Inner-standoff annulus radius: keep the player at least this far from the
    // boss so it never fights point-blank. Fraction of weapon range (scales
    // across classes) with an absolute tile floor.
    g.innerStandoff = std::max(kUInnerStandoffMinTiles, g.weaponRange * kUInnerStandoffFrac);
    g.engagementRange = std::max(g.innerStandoff + kUDurablePocketMargin,
                                 g.weaponRange - kUEngagementRangeInset);
    // The orbit standoff POINT must sit inside the annulus [innerStandoff,
    // weaponRange], so clamp it above the inner radius (with a small margin)
    // and never past weapon range — the soft goal never aims point-blank.
    const float standoff = settings.orbitRange > 0.f ? settings.orbitRange : g.weaponRange * 0.85f;
    g.standoff = std::clamp(standoff, g.innerStandoff + kUDurablePocketMargin, g.engagementRange);

    // ENEMY STANDOFF: fight from the OUTER part of weapon range, not the middle of
    // it. 54 % of the owner's 152 logged hits had an enemy within 4 tiles and the
    // shot that landed was a median of 62 ms old — at mid-ring the dodge simply has
    // no time. The target's own band (what its fastest shot covers in the reaction
    // budget) becomes the preferred fight distance, capped by what the weapon can
    // still reach. A short-range class (engagementRange < kShortRangeTiles) is left
    // exactly as it was, except that the 2-tile core still applies: a melee build
    // has no outer ring to retreat to and fencing it off would stop it fighting.
    if (settings.enemyStandoff != Standoff::Mode::Off && g.targetBand > 0.f &&
        settings.orbitRange <= 0.f && g.engagementRange >= kShortRangeTiles) {
        const float want = std::min(g.targetBand, g.engagementRange - kUStandoffRangeInset);
        g.innerStandoff = std::max(g.innerStandoff,
                                   std::min(g.targetBand, g.engagementRange) - kUStandoffRingWidth);
        g.innerStandoff = std::min(g.innerStandoff, g.engagementRange - kUDurablePocketMargin);
        g.standoff = std::clamp(want, g.innerStandoff, g.engagementRange);
    }
    g.innerStandoff = std::max(g.innerStandoff, Standoff::kCoreTiles);
    g.innerStandoff = std::min(g.innerStandoff, std::max(0.5f, g.engagementRange - kUDurablePocketMargin));
    return g;
}

// ── Per-phase perf instrumentation (diagnostics only) ────────────────────────
// Phase timers and decision counters feed DiagTiming::Game(); the detour in
// DangerPlanner.cpp emits them every 2 s with the whole-frame numbers. OFF unless
// RE_ASSETS/diag-timing.flag exists (see DiagTiming.h). The old 120-tick report
// went through DBG_FILE_LOG, which a Release build drops, so it never reached a
// user's log. NOTE: only meaningful in a RELEASE build.
using PhaseTimer = DiagTiming::Scope;

// A hit is the one moment a dodge decision can be checked against the outcome.
// Called BEFORE this frame's map sync, so g_map/g_solve still describe the frame
// the player was hit in (a projectile that hits is removed from the game's pool,
// so this frame's rebuild would no longer contain it).
void DiagLogHit(int32_t prevHp, int32_t hp, int32_t maxHp, Vec2 player, const Settings& settings,
                bool walkActive)
{
    static ULONGLONG s_windowMs = 0;
    static int s_inWindow = 0;
    const ULONGLONG now = GetTickCount64();
    if (now - s_windowMs >= 1000ULL) { s_windowMs = now; s_inWindow = 0; }
    if (++s_inWindow > 20) return;

    MapInput mi{};
    mi.player = player;
    mi.settings = settings;
    mi.map = &g_map;
    const float standClr = Core::PointSafety(mi, player);

    // Two nearest lane heads (Chebyshev, the game's projectile contact metric).
    int   nearIdx[2] = { -1, -1 };
    float nearD[2]   = { kHugeClearance, kHugeClearance };
    for (int i = 0; i < g_map.laneCount; ++i) {
        const LaneThreat& L = g_map.lanes[i];
        if (L.pointCount <= 0) continue;
        const float d = Cheb(L.points[0].x - player.x, L.points[0].y - player.y);
        if (d < nearD[0]) { nearD[1] = nearD[0]; nearIdx[1] = nearIdx[0]; nearD[0] = d; nearIdx[0] = i; }
        else if (d < nearD[1]) { nearD[1] = d; nearIdx[1] = i; }
    }
    char lanes[512] = {};
    size_t used = 0;
    for (int k = 0; k < 2; ++k) {
        if (nearIdx[k] < 0) break;
        const LaneThreat& L = g_map.lanes[nearIdx[k]];
        float tilesPerSec = 0.f;
        if (L.pointCount >= 2 && L.pointTimesMs[1] > L.pointTimesMs[0])
            tilesPerSec = Len(Sub(L.points[1], L.points[0])) * 1000.f / (L.pointTimesMs[1] - L.pointTimesMs[0]);
        int32_t ownerType = 0;
        for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot())
            if (e.id == static_cast<int32_t>(L.ownerObjId) || e.id == L.attackerObjId) { ownerType = e.objType; break; }
        const int n = snprintf(lanes + used, sizeof(lanes) - used,
            " lane%d{cheb=%.2f half=%.2f(x%.2f) spd=%.1ft/s pts=%d paint=%d beam=%d prov=%d owner=%u type=0x%X}",
            k, nearD[k], L.hitHalf, settings.hitScale, tilesPerSec, L.pointCount, L.instantCount,
            L.beam ? 1 : 0, L.provisional ? 1 : 0, L.ownerObjId, static_cast<unsigned>(ownerType));
        if (n <= 0) break;
        used = std::min(sizeof(lanes) - 1, used + static_cast<size_t>(n));
    }
    float zoneGap = kHugeClearance;
    for (int i = 0; i < g_map.zoneCount; ++i)
        if (g_map.zones[i].active)
            zoneGap = std::min(zoneGap, Len(Sub(g_map.zones[i].pos, player)) - g_map.zones[i].radius);
    float enemyDist = kHugeClearance;
    for (int i = 0; i < g_map.enemyCount; ++i)
        enemyDist = std::min(enemyDist, Len(Sub(g_map.enemies[i].pos, player)));

    // HitCulprit: append the closest-approach ring's best match — the shot that
    // came nearest the game's own hit test in the frames just before this HP
    // drop, tracked or not. The two nearest lanes above are g_map's CURRENT
    // state, which frequently no longer contains the hitting shot at all.
    used = PredErr::HitCulprit::AppendCulprit(PredErr::HitCulprit::FindCulprit(g_hitHistory, now),
                                              lanes, used, sizeof(lanes));

    DiagTiming::Logf("[Diag/Hit] hp %d->%d (-%d of %d) at (%.2f,%.2f) lastDecision=%d move=%d"
        " targetDist=%.2f standClr=%.2f lanes=%d zones=%d nearestActiveZoneGap=%.2f nearestEnemy=%.2f"
        " walk=%d wedged=%d lock=%d planner=%s hitbox=%.2f colliderTrusted=%d%s",
        prevHp, hp, prevHp - hp, maxHp, player.x, player.y, static_cast<int>(g_solve.kind),
        g_solve.shouldMove ? 1 : 0, Len(Sub(g_solve.target, player)), standClr,
        g_map.laneCount, g_map.zoneCount, zoneGap, enemyDist, walkActive ? 1 : 0,
        g_wedged.load(std::memory_order_relaxed) ? 1 : 0, g_map.hasLock ? 1 : 0,
        Contact::PolicyName(g_map.planner), g_map.targetScale, g_map.colliderTrusted ? 1 : 0, lanes);
}

// [Diag/PredErr] HitCulprit: record this tick's nearest kNearestN lanes into
// the closest-approach ring (UDodgePredErr.h), so a later HP drop can look
// backward through recent frames instead of only at the map at that instant
// (which frequently no longer holds the hitting shot). Called once per tick,
// right after the map sync, only while diagOn. No allocation: a small
// insertion sort into fixed local arrays.
void RecordApproachHistory(const DangerMap& map, Vec2 player, uint64_t nowMs)
{
    using PredErr::HitCulprit::kNearestN;
    int   nearIdx[kNearestN];
    float nearD[kNearestN];
    int   n = 0;
    for (int i = 0; i < map.laneCount; ++i) {
        const LaneThreat& L = map.lanes[i];
        if (L.pointCount <= 0) continue;
        const float d = Cheb(L.points[0].x - player.x, L.points[0].y - player.y);
        if (n >= kNearestN && d >= nearD[kNearestN - 1]) continue;
        int pos = n < kNearestN ? n : kNearestN - 1;
        while (pos > 0 && nearD[pos - 1] > d) {
            nearD[pos] = nearD[pos - 1]; nearIdx[pos] = nearIdx[pos - 1]; --pos;
        }
        nearD[pos] = d; nearIdx[pos] = i;
        if (n < kNearestN) ++n;
    }
    for (int k = 0; k < n; ++k) {
        const LaneThreat& L = map.lanes[nearIdx[k]];
        float tilesPerSec = 0.f;
        if (L.pointCount >= 2 && L.pointTimesMs[1] > L.pointTimesMs[0])
            tilesPerSec = Len(Sub(L.points[1], L.points[0])) * 1000.f / (L.pointTimesMs[1] - L.pointTimesMs[0]);
        uint32_t ownerType = 0;
        for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot())
            if (e.id == static_cast<int32_t>(L.ownerObjId) || e.id == L.attackerObjId) {
                ownerType = static_cast<uint32_t>(e.objType);
                break;
            }
        PredErr::HitCulprit::Record(g_hitHistory, { L.bulletId, L.attackerObjId, L.ownerObjId }, ownerType,
                                    L.hitHalf, tilesPerSec, nearD[k], L.beam, L.provisional, nowMs);
    }
}

Settings ReadSettings()
{
    Settings s{};
    s.laneTiles    = Clamp(g_laneTiles.load(std::memory_order_relaxed), 2.f, 16.f);
    const float stepT = g_stepTiles.load(std::memory_order_relaxed);
    s.stepTiles    = stepT <= 0.f ? 0.f : Clamp(stepT, 0.4f, 3.f);
    s.hitScale     = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.25f, 2.5f);
    s.planner      = static_cast<Contact::Policy>(g_planner.load(std::memory_order_relaxed));
    s.routeCommit  = g_routeCommit.load(std::memory_order_relaxed);
    s.enemyStandoff = static_cast<Standoff::Mode>(g_enemyStandoff.load(std::memory_order_relaxed));
    s.positionUncertainty = Clamp(g_serverPositionError.load(std::memory_order_relaxed), 0.f, 0.35f);
    s.reactMargin  = Clamp(g_reactMargin.load(std::memory_order_relaxed), 0.05f, 2.0f);
    s.safeWalk     = g_safeWalk.load(std::memory_order_relaxed);
    s.speedScale   = g_speedScale.load(std::memory_order_relaxed);
    s.fieldEscape  = g_fieldEscape.load(std::memory_order_relaxed);
    s.debugOverlay = g_debugOverlay.load(std::memory_order_relaxed);
    s.debugWeights = g_debugWeights.load(std::memory_order_relaxed);
    s.lockFollow   = g_lockFollow.load(std::memory_order_relaxed);
    s.followLantern = g_followLantern.load(std::memory_order_relaxed);
    s.autopilot     = g_autopilot.load(std::memory_order_relaxed);
    s.standOnType   = g_standOnType.load(std::memory_order_relaxed);
    const float orbit = g_orbitRange.load(std::memory_order_relaxed);
    s.orbitRange   = orbit <= 0.f ? 0.f : Clamp(orbit, 2.f, 16.f);
    s.planRadius   = ClampInt(static_cast<int>(std::lround(g_planRadius.load(std::memory_order_relaxed))), 8, 40);
    s.fallbackSidestep = g_fallbackSidestep.load(std::memory_order_relaxed);
    return s;
}

void PublishDebug(const DebugSnapshot& snap)
{
    std::lock_guard<std::mutex> lock(g_debugMutex);
    DebugSlot() = snap;
}

void PublishMinimal(Decision decision, Vec2 player)
{
    DebugSnapshot d{};
    d.active = IsEnabled();
    d.decision = decision;
    d.player = player;
    PublishDebug(d);
}

// Rasterize the plain-data occupancy+hazard grid the worker pathfinds over
// (plan 65). GAME-THREAD ONLY — WorldTAB tile-map reads / IsHazardAt touch live
// world memory, which is exactly why occupancy is baked into a plain grid here and
// the worker never calls Env. WALL bits (bit0) are rasterized through the unified
// player-box bulk reader (WorldTAB::CopyBoxBlocked, plan 73) — ONE tile-mutex lock
// for the whole grid instead of the old kUPathMaxCells (49×49 = 2401) per-cell
// Sensors::CanOccupy mutex storm — and only when rebuildWalls (a full map rebuild:
// walls are static within a server tick). HAZARD bits (bit1) refresh every call
// (cheap via the per-tick hazard memo). `grid` persists across frames (a static in
// Tick), so unrebuilt wall bits survive. Runs inside the per-tick memo lifetime
// (BuildMap/ReanchorMap populated it).
// ENEMY STANDOFF: the discs, collected ONCE per publish from the plain enemy list
// the sensors already built. Nearest-first is implicit — PopulateEnemies keeps the
// N nearest — and the list is capped so a 26-enemy Monolith pack costs a bounded
// raster, not a per-cell sweep.
int CollectStandoffDiscs(const DangerMap& map, Standoff::Disc* out)
{
    int n = 0;
    if (map.enemyStandoff == Standoff::Mode::Off) return 0;
    for (int i = 0; i < map.enemyCount && n < Standoff::kMaxDiscs; ++i) {
        const EnemyBlocker& e = map.enemies[i];
        if (e.standoffCore <= 0.f && e.standoffBand <= 0.f) continue;
        Standoff::Disc& d = out[n++];
        d.x = e.pos.x; d.y = e.pos.y; d.core = e.standoffCore; d.band = e.standoffBand;
    }
    return n;
}

void FillOccGrid(Path::OccGrid& grid, Vec2 player, bool rebuildWalls, Movement::Collision::Rule rule,
                 const DangerMap& map)
{
    grid.center = player;
    grid.squareX0 = static_cast<int>(std::floor(player.x)) - kUOccSquareRad;
    grid.squareY0 = static_cast<int>(std::floor(player.y)) - kUOccSquareRad;
    // Ground <Speed> of the squares around the window: the worker times each route
    // edge at the speed of the ground it crosses (Movement::Speed).
    WorldTAB::CopyTileSpeeds(grid.squareX0, grid.squareY0, kUOccSquareSide, grid.squareSpeed);
    if (rule == Movement::Collision::Rule::Game) {
        // The game's rule reads squares, not a box: one whole-tile, halfEdge-0 raster
        // at square centres around the window (Collision::RasterSquares).
        WorldTAB::CopyBoxBlocked(static_cast<float>(grid.squareX0) + 0.5f, static_cast<float>(grid.squareY0) + 0.5f,
                                 kUOccSquareSide, 1.f, 0.f, /*foldHazard=*/true, grid.squares);
    }
    constexpr int R = kUPathMaxRadCells;
    constexpr int S = kUPathMaxSide;

    // WALL bits (bit0): when rebuilding, rasterize the whole grid through the
    // unified player-box reader (plan 73) in ONE tile-mutex lock — replaces the
    // 2401 per-cell Sensors::CanOccupy probes and their per-tile mutex storm. Same
    // footprint (kUOccPlayerHalfEdge = the game's collision half-edge, exactly what
    // IsWalkPositionBlocked/CanOccupy used) over the same source (s_blockedMap), so
    // the walkability is unchanged — this is pure perf. safeWalk stays OUT here
    // (foldHazard=false) so hazard remains a SEPARATE bit the worker folds itself.
    // Only bit0 (wall) is consumed: CopyBoxBlocked also emits bit2 (sink/water)
    // unconditionally, and water is NOT a wall for the DODGE — it may cross one to
    // escape a shot (only NAVIGATION hard-blocks it). Mask, don't truth-test.
    // Origin is the world center of cell (0,0), player - R*cell, matching the old
    // per-cell center player + (gx-R)*cell.
    uint8_t wallScratch[kUPathMaxCells];
    if (rebuildWalls) {
        const float originX = player.x - static_cast<float>(R) * kUPathCellTiles;
        const float originY = player.y - static_cast<float>(R) * kUPathCellTiles;
        // Fold hazards into this same bulk tile-map pass. The former per-cell
        // live query below performed up to 2401 lookups (and hundreds of raw game
        // calls) per publish, which was a major game-thread FPS regression.
        WorldTAB::CopyBoxBlocked(originX, originY, S, kUPathCellTiles,
                                 kUOccPlayerHalfEdge, /*foldHazard=*/true, wallScratch);
    }

    for (int gy = 0; gy < S; ++gy) {
        for (int gx = 0; gx < S; ++gx) {
            const int i = gy * S + gx;
            uint8_t& f = grid.flags[i];
            if (rebuildWalls) {
                if (wallScratch[i] & 0x1) f |= 0x1;
                else                      f &= static_cast<uint8_t>(~0x1);
                if (wallScratch[i] & 0x8) f |= 0x1; // unstreamed/void is a hard boundary
                if (wallScratch[i] & 0x2) f |= 0x2;
                else                      f &= static_cast<uint8_t>(~0x2);
                // FullOccupy half-tile rule at this cell's centre: the live check
                // (Sensors::CanOccupy) refuses it, so the worker must too.
                if (wallScratch[i] & 0x10) f |= 0x10;
                else                       f &= static_cast<uint8_t>(~0x10);
            }
        }
    }
    // ENEMY STANDOFF bits. Refreshed EVERY call (enemies move; walls do not), and
    // read only by the GOAL tests — the dodge stays free to cross a band or a core
    // to escape a shot, which is the difference between a standoff and a cage.
    Standoff::Disc discs[Standoff::kMaxDiscs];
    const int discCount = CollectStandoffDiscs(map, discs);
    Standoff::Rasterize(grid.flags, S,
                        player.x - static_cast<float>(R) * kUPathCellTiles,
                        player.y - static_cast<float>(R) * kUPathCellTiles,
                        kUPathCellTiles, discs, discCount, player.x, player.y,
                        /*exemptGoal*/false, 0.f, 0.f);
}

// Fill the navigation A* occupancy (walk-to). Centered on the player; each cell is
// one tile. Reads WorldTAB's blocked-tile map in ONE bulk locked pass through the
// UNIFIED player-box reader (plan 73) — the same footprint the dodge occupancy grid
// uses (kUOccPlayerHalfEdge, the game's collision half-edge). Undiscovered tiles
// stay walkable (the optimistic model); damaging tiles fold in when safeWalk. The
// origin is the world CENTER of cell (0,0), player - kUNavRadCells*cell, so cell
// centers match the worker's NavCellWorld mapping (player + (gx-kNR)*cell). Sink /
// water cells arrive as bit2 regardless of safeWalk and the nav A* hard-blocks them
// (NavBlocked) — walking into deep water is not a safe-walk preference. Moving
// from single-tile to the player-box footprint makes walk-to hug walls slightly
// less — the intended fix for routing the player's edge into a wall the game blocks.
// Cheap: one mutex lock, kUNavCells hashmap probes, only when a walk-to is active.
void FillNavGrid(Path::NavGrid& grid, Vec2 player, bool safeWalk, Movement::Collision::Rule rule,
                 const DangerMap& map, bool navActive, Vec2 navGoal)
{
    // Stable tile centres preserve clearance in one-tile corridors; a grid
    // anchored to the player's fractional position can put every cell on a wall edge.
    grid.center = {std::floor(player.x) + 0.5f, std::floor(player.y) + 0.5f};
    const float originX = grid.center.x - static_cast<float>(kUNavRadCells) * kUNavCellTiles;
    const float originY = grid.center.y - static_cast<float>(kUNavRadCells) * kUNavCellTiles;
    // Legacy: the player box plus navigation padding. Game: no box — each cell is its
    // square exactly, which is what the A*'s Collision::DiagonalStepClear reads back.
    const float halfEdge = rule == Movement::Collision::Rule::Game
        ? 0.f : kUOccPlayerHalfEdge + Navigation::kWallPadding;
    WorldTAB::CopyBoxBlocked(originX, originY, kUNavSide, kUNavCellTiles,
                             halfEdge, /*foldHazard=*/safeWalk, grid.flags);
    for (int i = 0; i < kUNavCells; ++i)
        if (grid.flags[i] & 0x8) grid.flags[i] |= 0x1; // never A* into blank map void
    // ENEMY STANDOFF. Cores become walls for the route (NavBlocked) and bands a
    // strong per-cell cost (RunNavSearch), so a walk-to goes AROUND a pack instead
    // of through it — 68 of the owner's 152 logged hits were taken while a script
    // was walking the player. The destination's own band is exempted within
    // kGoalExemptTiles so a bag or portal beside a mob stays reachable; no core
    // ever is.
    Standoff::Disc discs[Standoff::kMaxDiscs];
    const int discCount = CollectStandoffDiscs(map, discs);
    Standoff::Rasterize(grid.flags, kUNavSide, originX, originY, kUNavCellTiles,
                        discs, discCount, player.x, player.y,
                        navActive, navGoal.x, navGoal.y);
}

// Follow the cached nav route: project the player onto the polyline, then place the
// steering target `lookahead` tiles further along it. Reports the player's distance
// FROM the route (deviation) and whether they've reached its end — the re-plan
// triggers. Returns the raw player position when there is no usable cached route.
// `outConnected` (Item 1 S2): whether Follow found a clear rejoin point on the
// cached polyline at all, however far off it the player has drifted. false only
// when no cache exists or the whole route is disconnected.
Vec2 NavStepFromCache(const NavCache& c, Vec2 player, float lookahead,
                      float& outDev, bool& outNearEnd, bool& outConnected, const MapInput& in)
{
    outDev = 0.f; outNearEnd = false; outConnected = false;
    if (!c.valid || c.n < 2) return player;

    Vec2 avoid[kMaxNavAvoid];
    const int avoidCount = ActiveNavAvoid(avoid, GetTickCount64());
    return Navigation::Follow(c.wpts, c.n, player, lookahead, outDev, outNearEnd, outConnected,
        [&](Vec2 from, Vec2 to) {
            return Navigation::PaddedPathClear(in, from, to) &&
                   Navigation::AvoidClear(avoid, avoidCount, from, to);
        });
}

// ── Autopilot auto-lock ──────────────────────────────────────────────────────
// When autopilot is ON, auto-select the enemy with the highest total HP (maxHp)
// that is a real, damageable target — has a health bar (not a wall/destructible),
// is not invulnerable/untargetable, and is currently alive (hp>0) — and set it as
// the enemy lock so the EXISTING orbit / in-range-disk fight engages. Re-evaluates
// every tick, so it re-targets when the current lock dies/despawns or a bigger
// enemy appears. SetEnemyLock only fires (and toasts) on an actual id change, so
// calling this every tick with a stable target is a cheap no-op.
//
// Ownership: g_autopilotLockId tracks the id autopilot set. When autopilot is OFF
// we release ONLY a lock autopilot owns and never touch the user's manual lock —
// so "no manual lock + autopilot off" means no fight, and a manual Shift+Click
// lock survives autopilot being off. Runs BEFORE BuildMap so PopulateEnemies sees
// the fresh lock the same tick.
void UpdateAutopilotLock(bool autopilotOn)
{
    const int32_t owned = g_autopilotLockId.load(std::memory_order_relaxed);

    if (!autopilotOn) {
        if (owned != 0) {
            if (DangerPlanner::GetEnemyLock() == owned)
                DangerPlanner::ClearEnemyLock();
            g_autopilotLockId.store(0, std::memory_order_relaxed);
        }
        return;
    }

    EnemyTracker::Tick();   // self-throttled; also refreshed inside BuildMap
    int32_t bestId = 0;
    int32_t bestMaxHp = 0;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!e.hasHealthBar) continue;   // walls / destructibles — not a fight target
        if (e.isInvulnerable) continue;  // <Invincible/> — untargetable / undamageable
        if (!EnemyTracker::EntryAlive(e)) continue;   // dead / despawning (LockLiveness.h)
        if (e.maxHp <= 0) continue;
        if (e.maxHp > bestMaxHp) { bestMaxHp = e.maxHp; bestId = e.id; }
    }

    if (bestId != 0) {
        if (bestId != owned) {
            DangerPlanner::SetEnemyLock(bestId);   // toast fires only on change
            g_autopilotLockId.store(bestId, std::memory_order_relaxed);
        }
    } else if (owned != 0) {
        // No valid target left — release the auto-lock so we don't orbit a corpse.
        if (DangerPlanner::GetEnemyLock() == owned)
            DangerPlanner::ClearEnemyLock();
        g_autopilotLockId.store(0, std::memory_order_relaxed);
    }
}

} // namespace

void SetEnabled(bool enabled)
{
    if (enabled) {
        ProjectileTracking::Install();   // sensors need the projectile hook
        Worker::Start();                 // async grid-pathfinder worker (plan 65)
        Movement::Nav::Runtime::Start();
    }
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        SetGroupPreference("");
        g_previousGroupActive = false;
        g_previousGroupBoss = 0;
        Worker::Stop();                  // JOIN the worker before releasing state it never touches
        Movement::Nav::Runtime::Stop();
        UpdateAutopilotLock(false);      // release any autopilot-owned enemy lock (never a manual one)
        DangerPlanner::ClearWalkGoal();  // drop any pending walk-to spot
        g_commitment.Reset();
        g_solve = Solver::SolveResult{};
        g_route = Path::PlanResult{};
        g_lastPubSeq = 0;
        g_solveSeq = 0;
        g_lockApproach = false;
        g_lockApproachGoalValid = false;
        g_lockApproachId = 0;
        ClearNavAvoid();
        // Clear the AutoNexus last-resort signal (plan 77): udodge is no longer
        // handling anything, so it must not report itself as covering the player.
        g_udExposed.store(false, std::memory_order_relaxed);
        g_udStandClr.store(1e9f, std::memory_order_relaxed);
        g_udMoveVx.store(0.f, std::memory_order_relaxed);
        g_udMoveVy.store(0.f, std::memory_order_relaxed);
        g_udSolveKind.store(0, std::memory_order_relaxed);
        g_serverAnchorValid.store(false, std::memory_order_release);
        PublishDebug(DebugSnapshot{});
    }
}

bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

SafetyState GetSafetyState()
{
    SafetyState s{};
    s.enabled        = g_enabled.load(std::memory_order_relaxed);
    s.exposed        = g_udExposed.load(std::memory_order_relaxed);
    s.standClearance = g_udStandClr.load(std::memory_order_relaxed);
    s.tickId         = g_udSafetyTick.load(std::memory_order_relaxed);
    s.moveVx         = g_udMoveVx.load(std::memory_order_relaxed);
    s.moveVy         = g_udMoveVy.load(std::memory_order_relaxed);
    s.serverAnchorValid = g_serverAnchorValid.load(std::memory_order_acquire);
    s.serverX        = g_serverAnchorX.load(std::memory_order_relaxed);
    s.serverY        = g_serverAnchorY.load(std::memory_order_relaxed);
    return s;
}

uint8_t GetLastSolveKind() { return g_udSolveKind.load(std::memory_order_relaxed); }

NavWedge GetNavWedge()
{
    NavWedge w{};
    w.walkActive = g_wedgeWalkActive.load(std::memory_order_relaxed);
    w.wedged     = g_wedged.load(std::memory_order_relaxed);
    w.goalX      = g_wedgeGoalX.load(std::memory_order_relaxed);
    w.goalY      = g_wedgeGoalY.load(std::memory_order_relaxed);
    w.playerX    = g_wedgePlayerX.load(std::memory_order_relaxed);
    w.playerY    = g_wedgePlayerY.load(std::memory_order_relaxed);
    w.stampMs    = g_wedgeStampMs.load(std::memory_order_relaxed);
    return w;
}

void SetGroupPreference(const char* payload)
{
    std::lock_guard<std::mutex> guard(g_groupMutex);
    g_groupPreference.Set(payload, GetTickCount64());
}

void OnEnter()
{
    SetGroupPreference("");
    g_previousGroupActive = false;
    g_previousGroupBoss = 0;
    Movement::Nav::Runtime::InvalidateGoal();
    ProjectileTracking::Install();   // sensors need the projectile hook
    // A completed result from the previous realm is still valid plain data as far
    // as the worker handoff knows. Flush both pending/latest slots by restarting
    // the worker before accepting any route in the new location.
    Worker::Stop();
    Worker::Start();
    g_commitment.Reset();
    g_solve = Solver::SolveResult{};
    g_route = Path::PlanResult{};
    g_navCache = NavCache{};
    g_globalRawActive = false;
    g_globalAssistance = false;
    g_globalCorridorEpoch = 0;
    g_globalCorridorGoalId = 0;
    g_navAwaiting = false;
    g_navProgress.Reset();
    g_lockApproach = false;
    g_lockApproachGoalValid = false;
    g_lockApproachId = 0;
    ClearNavAvoid();
    g_trailCount = 0;
    for (Vec2& p : g_trail) p = {};
    // Every one of these stores world coordinates/object ids and is therefore
    // location-scoped. Never carry a click/follow/lock waypoint across a realm.
    DangerPlanner::ClearWalkGoal();
    DangerPlanner::ClearFollowPlayer();
    DangerPlanner::ClearEnemyLock();
    g_lastPubSeq = 0;
    g_solveSeq = 0;
    g_telemetry = Telemetry::State{};
    g_telemetryWorker = TelemetryWorker{};
    g_mapDiag = MapDiag::State{};
    // Reset the AutoNexus last-resort signal (plan 77) on (re)entry.
    g_udExposed.store(false, std::memory_order_relaxed);
    g_udStandClr.store(1e9f, std::memory_order_relaxed);
    g_udSolveKind.store(0, std::memory_order_relaxed);
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) return;
    if (!DodgeRuntime::EnsureResolved()) return;

    // ── Perf probe: measure the full UDodge::Tick cost on the game thread. RAII
    // so it captures every return path (records total even on early return); the
    // per-phase breakdown is emitted every 2 s by DangerPlanner's update detour.
    PhaseTimer total(DiagTiming::Game().total);
    const bool diagOn = DiagTiming::On();
    // Item 4 (navigation finish plan): frame-cost ceiling. One QueryPerformanceCounter
    // read (DiagTiming::NowMs(), the same clock the phase timers already use) — cheap
    // enough to always take, so "off" costs the same as before this switch existed.
    const double tickStartMs = DiagTiming::NowMs();
    // Item 4 follow-up: this Tick has not built the shared temporal context yet.
    g_sharedTemporalCtx.built = false;

    const Settings settings = ReadSettings();
    const SteerInput::SteerState steer = SteerInput::Get();

    // Autopilot auto-lock — pick the highest-maxHp targetable enemy as the enemy
    // lock (or release the auto-lock when off). Runs BEFORE the map build so the
    // fresh lock is reflected in g_map.hasLock/lockPos this same tick.
    UpdateAutopilotLock(settings.autopilot);

    int32_t hp = 0, maxHp = 0;
    float spd = 0.f, tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);
    {
        static int32_t s_diagPrevHp = -1, s_diagPrevMaxHp = -1;
        if (diagOn && maxHp > 0) {
            if (s_diagPrevHp > 0 && s_diagPrevMaxHp == maxHp && hp < s_diagPrevHp) {
                float wx = 0.f, wy = 0.f; bool wa = false;
                DangerPlanner::GetWalkGoal(wx, wy, wa);
                DiagLogHit(s_diagPrevHp, hp, maxHp, { px, py }, settings, wa);
            }
            s_diagPrevHp = hp; s_diagPrevMaxHp = maxHp;
        } else {
            s_diagPrevHp = -1;
        }
    }

    // ── NewTick sync ─────────────────────────────────────────────────────
    // The map LAYOUT is rebuilt from authoritative game state every server
    // tick (WM_TickId change). Between ticks, lanes are re-anchored to the
    // game's own live projectile positions (never extrapolated by our
    // clock). A structural change (projectile spawned/retired mid-tick)
    // forces an immediate rebuild so a new shot is visible the same frame.
    // If the tick counter is unreadable (stale offsets), rebuild every
    // frame — the fail-safe direction is fresher, never staler.
    // tick / tickOk / rebuilt are consumed later in Tick, so they are declared
    // outside the timed scope; the sync scope wraps only the actual map-sync
    // work (ReadWorldTick / ReanchorMap / BuildMap).
    uint32_t tick = 0;
    bool tickOk = false;
    bool rebuilt = false;
    {
        PhaseTimer _p(DiagTiming::Game().sync);
        tickOk = Sensors::ReadWorldTick(tick);
        bool synced = false;
        if (tickOk && g_map.tickValid && g_map.tickId == tick)
            synced = Sensors::ReanchorMap(g_map, px, py, settings, diagOn);
        rebuilt = !synced;
        if (rebuilt) {
            Sensors::BuildMap(g_map, px, py, settings, diagOn);
            g_map.tickId = tick;
            g_map.tickValid = tickOk;
        }
    }
    if (diagOn) {
        DiagTiming::GameStats& gs = DiagTiming::Game();
        ++(rebuilt ? gs.rebuilds : gs.reanchors);
        gs.maxLanes   = std::max(gs.maxLanes, g_map.laneCount);
        gs.maxZones   = std::max(gs.maxZones, g_map.zoneCount);
        gs.maxEnemies = std::max(gs.maxEnemies, g_map.enemyCount);
        if (g_map.limited) ++gs.mapLimited;
        RecordApproachHistory(g_map, { px, py }, GetTickCount64());
    }
    if (g_map.projectileSourceUnavailable) {
        g_commitment.Reset();
        PublishMinimal(Decision::None, { px, py });
        if (diagOn)
            Telemetry::Idle(g_telemetry, GetTickCount64(), "projectile_source_unavailable", &DbgFileLogWrite);
        return;
    }

    MapInput in{};
    in.player = { px, py };

    // Movement::Speed: the conditions-and-SPD base, and the speed on the player's own
    // square for this frame's step (the square the game's move update reads).
    const float ownSquareSpeed = WorldTAB::GetTileSpeed(static_cast<int>(std::floor(px)),
                                                        static_cast<int>(std::floor(py)));
    const float baseTilesPerSec = Movement::Speed::BaseTilesPerSec(tilesPerSec, ownSquareSpeed);
    in.speed = Movement::Speed::TilesPerSec(baseTilesPerSec, ownSquareSpeed) / 1000.f;
    in.stepTiles = settings.stepTiles > 0.f
        ? settings.stepTiles
        : std::clamp(std::max(0.f, tilesPerSec) * kServerTickSec, 0.f, 3.0f);
    in.tickId = g_map.tickId;
    in.movementLocked = in.speed <= 0.f;
    in.playerOnHazard = settings.safeWalk && Sensors::IsHazardAt(px, py);
    in.settings = settings;
    in.env.canOccupy = &Sensors::CanOccupy;
    in.env.isHazard = &Sensors::IsHazardAt;
    in.env.wallsClear = &Sensors::WallsClear;
    const Movement::Collision::Rule collisionRule = Movement::Collision::GetRule();
    in.env.rule = collisionRule;
    in.env.stepClear = &Sensors::StepClear;
    in.map = &g_map;

    // in.stepTiles IS the per-tick move budget (tilesPerSec × kServerTickSec).
    const float b = in.stepTiles;
    CoreState proposedState = g_commitment.state;

    // ── Goal (soft preference only) ─────────────────────────────────────────
    // The goal is consumed ONLY through the solver's wGoal term over the SAFE set,
    // so it can never move the player into a shot: it is just how we rank safe
    // options. Priority: WASD steer → Shift+Click walk-to spot → user-locked enemy
    // orbit standoff → none (pure dodge that never wanders). A walk-to goal
    // OVERRIDES the orbit (the user told it to go somewhere) until cleared; when it
    // clears, autopilot's auto-lock resumes the orbit-fight. Safety is unchanged
    // and always authoritative — the solver only ever ranks SAFE cells.
    const bool wasdActive = steer.active && (steer.dirX != 0.f || steer.dirY != 0.f);

    // Walk-to-spot goal (Shift+Click on empty ground). Clear it when the user
    // steers with WASD (overrides everything), or when the player has arrived
    // within kUWalkArriveTiles. A new click overwrites it in TestTAB.
    float walkX = 0.f, walkY = 0.f;
    bool  walkActive = false;
    DangerPlanner::GetWalkGoal(walkX, walkY, walkActive);
    if (walkActive && wasdActive) {
        DangerPlanner::ClearWalkGoal();
        walkActive = false;
    }
    if (walkActive) {
        const float dwx = walkX - px, dwy = walkY - py;
        if (std::sqrt(dwx * dwx + dwy * dwy) <= kUWalkArriveTiles) {
            DangerPlanner::ClearWalkGoal();
            walkActive = false;
        }
    }

    // ── Follow-player (Shift+Click on another player) ────────────────────────
    // Resolve the followed player's LIVE position (throttled ~20 Hz; the entity is
    // read straight from the world dict, not the stale WorldTAB snapshot) and walk
    // toward them at a standoff, reusing the SAME nav-A* / walk-to pipeline below.
    // Only when no walk-to goal and no WASD is active. The goal tracks them each
    // tick; when caught up (within standoff) we hold, and resume when they move off.
    const int32_t followId = DangerPlanner::GetFollowPlayer();
    if (followId != 0 && !walkActive && !wasdActive) {
        static ULONGLONG s_lastFollowMs = 0;
        static ULONGLONG s_followMissSinceMs = 0;
        static int32_t   s_lastFollowId = 0;
        static float     s_fpx = 0.f, s_fpy = 0.f;
        static bool      s_fpOk = false;
        const ULONGLONG  nowFollow = GetTickCount64();
        if (followId != s_lastFollowId) {
            s_lastFollowId = followId;
            s_followMissSinceMs = 0;
            s_fpOk = false;
        }
        if (nowFollow - s_lastFollowMs >= 50ULL) {   // 20 Hz resolve
            s_lastFollowMs = nowFollow;
            float liveX = 0.f, liveY = 0.f;
            if (EnemyTracker::ResolveObjectPos(followId, liveX, liveY)) {
                s_fpx = liveX; s_fpy = liveY;
                s_fpOk = true;
                s_followMissSinceMs = 0;
            } else {
                // A world-dict refresh can transiently miss an otherwise-live
                // player. Keep both the target id and last-known position instead
                // of permanently cancelling /follow on one failed 20-Hz lookup.
                if (s_followMissSinceMs == 0) s_followMissSinceMs = nowFollow;
                if (nowFollow - s_followMissSinceMs > 3000ULL) {
                    s_fpOk = false;
                    DangerPlanner::ClearFollowPlayer();
                    s_lastFollowId = 0;
                }
            }
        }
        if (s_fpOk) {
            const float tox = s_fpx - px, toy = s_fpy - py;
            const float dist = std::sqrt(tox * tox + toy * toy);
            constexpr float kFollowStandoff = 2.0f;   // stop ~2 tiles away (don't stack on them)
            if (dist > kFollowStandoff + 0.75f) {     // +hysteresis so we don't twitch at the edge
                const float inv = 1.f / std::max(dist, 1e-4f);
                walkX = px + tox * inv * (dist - kFollowStandoff);
                walkY = py + toy * inv * (dist - kFollowStandoff);
                walkActive = true;   // drive via the walk-to / nav pipeline below
            }
        }
    }

    // ── Locked target out of engagement range: approach it by route ──────────
    // The orbit below only ranks one-budget steps toward a standoff point, with a
    // penalty that grows with distance past weapon range. That is right in range,
    // but from outside it the player walks straight at the boss and stops against
    // the first concave wall in between — the dodge grid is 12 tiles, and nothing
    // else routed. So beyond engagement range the approach runs through the walk-to
    // pipeline (72-tile A*, cached route, follower) toward the ENGAGEMENT DISK: the
    // nearest cell by path within range, not one point that may sit behind a wall.
    // Hysteresis keeps the hand-off to the orbit from flickering at the edge.
    constexpr float kLockApproachEnterTiles = 1.0f;   // start routing this far past engagement range
    constexpr float kLockApproachExitTiles  = 0.25f;  // hand back to the orbit this far inside it
    constexpr float kLockApproachInsetTiles = 0.75f;  // the route's goal disk sits this far inside
    float navGoalRadius = 0.f;
    bool  lockApproach = false;
    // RING APPROACH (Tactician Slice 2). The walk-to A* that carries the approach is
    // projectile-blind, and during it the snapshot carries no lock, so the dodge
    // pathfinder used to treat any shot-free stand as "done" — around a radially
    // firing boss that is where the shots end, outside weapon range. Once the ring's
    // outer edge is inside the dodge window the snapshot asks for a route INTO the
    // ring (time-checked like every dodge route). Farther out nothing changes: the
    // walk-to still carries the long approach, and it stays active underneath.
    constexpr float kRingPlanReachTiles = kUPathMaxRadCells * kUPathCellTiles - 2.0f;
    bool  ringApproach = false;
    float ringOuter = 0.f, ringInner = 0.f;
    if (!walkActive && !wasdActive && g_map.hasLock) {
        const LockGeometry lg = ComputeLockGeometry(settings, g_map.lockBand);
        const float dist = Len(Sub(in.player, g_map.lockPos));
        if (g_map.lockId != g_lockApproachId) {
            g_lockApproachId = g_map.lockId;
            g_lockApproach = false;
        }
        if (dist > lg.engagementRange + kLockApproachEnterTiles) g_lockApproach = true;
        else if (dist <= lg.engagementRange - kLockApproachExitTiles) g_lockApproach = false;
        if (g_lockApproach) {
            if (!g_lockApproachGoalValid || LenSq(Sub(g_lockApproachGoal, g_map.lockPos)) > 1.f) {
                g_lockApproachGoal = g_map.lockPos;
                g_lockApproachGoalValid = true;
            }
            walkX = g_lockApproachGoal.x;
            walkY = g_lockApproachGoal.y;
            walkActive = true;
            lockApproach = true;
            navGoalRadius = std::max(0.5f, lg.engagementRange - kLockApproachInsetTiles);
            if (settings.planner == Contact::Policy::Tactician &&
                dist - lg.engagementRange <= kRingPlanReachTiles) {
                ringApproach = true;
                ringOuter = lg.engagementRange;   // the two values the in-range orbit publishes
                ringInner = lg.innerStandoff;     // (goal.maxRange / goal.innerStandoff below)
            }
            if (diagOn) ++DiagTiming::Game().lockApproachFrames;
        } else {
            g_lockApproachGoalValid = false;
        }
    } else {
        g_lockApproach = false;
        g_lockApproachGoalValid = false;
    }

    // ── Goal owner (Item 1 S1) ────────────────────────────────────────────────
    // ONE place that decides this tick's objective, from the same flags already
    // derived above (wasdActive / lockApproach / walkActive / followId /
    // g_map.hasLock) — the ones that build Solver::Goal below and the [Diag/Nav]
    // objective today. A plain fill, not a new derivation: DangerPlanner's
    // setters (SetWalkGoal, SetEnemyLock, SetFollowPlayer) are untouched. The
    // route-commitment decision below reads this for "did the objective change";
    // nothing else consumes it yet.
    GoalOwner objective{};
    if (wasdActive) {
        objective.kind = Telemetry::Objective::Steer;
    } else if (lockApproach) {
        objective.kind     = Telemetry::Objective::LockApproach;
        objective.targetId = g_map.lockId;
        objective.target   = g_map.lockPos;
    } else if (walkActive) {
        float wcx = 0.f, wcy = 0.f; bool commanded = false;
        DangerPlanner::GetWalkGoal(wcx, wcy, commanded);
        objective.kind     = commanded ? Telemetry::Objective::WalkTo : Telemetry::Objective::Follow;
        objective.targetId = commanded ? 0 : followId;
        objective.target   = { walkX, walkY };
    } else if (g_map.hasLock) {
        objective.kind     = Telemetry::Objective::Lock;
        objective.targetId = g_map.lockId;
        objective.target   = g_map.lockPos;
    }

    const bool globalPointActive = walkActive && !lockApproach && !wasdActive;
    if (!globalPointActive || !g_globalRawActive ||
        LenSq(Sub(g_globalRawGoal, Vec2{walkX, walkY})) > 4.f)
        g_globalAssistance = false;
    g_globalRawGoal = {walkX, walkY};
    g_globalRawActive = globalPointActive;
    // ENEMY STANDOFF: hand the D* navigator the same discs the nav A* rasterises,
    // so both navigators route around a pack under one rule.
    {
        Standoff::Disc discs[Standoff::kMaxDiscs];
        const int discCount = CollectStandoffDiscs(g_map, discs);
        Movement::Nav::Router::StandoffDisc routerDiscs[Standoff::kMaxDiscs];
        for (int i = 0; i < discCount; ++i)
            routerDiscs[i] = { discs[i].x, discs[i].y, discs[i].core, discs[i].band };
        Movement::Nav::Runtime::SetStandoff(routerDiscs, discCount);
    }
    const auto corridor = Movement::Nav::Runtime::Update({px, py}, {walkX, walkY},
        baseTilesPerSec, globalPointActive, settings.safeWalk);
    const bool sameGlobalRequest = Navigation::SameRouteRequest(
        Movement::Nav::Runtime::Enabled() && globalPointActive && g_globalAssistance,
        corridor.epoch, corridor.goalId, g_globalCorridorEpoch, g_globalCorridorGoalId);
    g_globalCorridorEpoch = globalPointActive ? corridor.epoch : 0;
    g_globalCorridorGoalId = globalPointActive ? corridor.goalId : 0;
    // Item 3 (navigation finish plan, 2026-09-19), VISIBLE FALLBACK: this gate
    // is already the whole contract. While capturePending is set, this block
    // never runs, so walkX/walkY keep whatever DangerPlanner::GetWalkGoal (or
    // the lock-approach/follow logic above) already put in them — the exact
    // same values navNavigator=legacy would use — and every nav-replan / cache
    // / follow decision from here down (they only ever branch on walkActive,
    // g_navCache, etc., never on Runtime::Enabled()) runs identically to
    // legacy too. So a stuck capture already degrades to legacy walk-to
    // behaviour from its very first pending tick; nothing here needed to
    // change for Item 3's fallback requirement. What was missing was making
    // that visible — see t.navFallback / "nav=dstar(fallback)" below, and
    // [Diag/Map] (UDodgeMapDiag.h) for why capture is pending in the first
    // place.
    if (Movement::Nav::Runtime::Enabled() && !corridor.capturePending) {
        if (walkActive && !lockApproach && !wasdActive) {
            if (g_globalAssistance && corridor.count >= 2 && corridor.state != Movement::Nav::RouteState::Unreachable) {
                const auto& waypoint = corridor.points[corridor.count - 1];
                walkX = waypoint.worldX;
                walkY = waypoint.worldY;
            } else if (corridor.state != Movement::Nav::RouteState::Repairing &&
                       (g_globalAssistance || corridor.state == Movement::Nav::RouteState::Unreachable ||
                        corridor.count == 0)) {
                walkX = px;
                walkY = py;
                g_navCache.valid = false;
                g_navAwaiting = false;
            }
        }
    }

    // Enemy-centred keep-outs (self blasts, point-blank shooters) stay HARD during
    // walk-to as well: the route goes around them, and with no way round the player
    // waits at the edge (UDodgeEnemyHazards.h).

    // ── Nav re-plan decision (walk-to route caching) ─────────────────────────
    // Follow the cached route and only re-run the A* on a real trigger. navStep is
    // the steering target ~lookahead budgets ahead along the cached polyline.
    bool navReplan = false;
    Telemetry::ReplanReason navReplanReason = Telemetry::ReplanReason::None;
    bool navRejoin = false;   // Item 1 S4 telemetry: a detour rejoined the route instead of re-planning
    const bool wasNavWaiting = g_navAwaiting;
    bool navWaiting = g_navAwaiting;
    Vec2 navStep{ walkX, walkY };
    if (walkActive) {
        const Vec2  wg{ walkX, walkY };
        const float lookahead = std::max(b, 1.f) * kUNavLookaheadBudgets;
        float dev = 0.f; bool nearEnd = false; bool routeConnected = false;
        navStep = NavStepFromCache(g_navCache, in.player, lookahead, dev, nearEnd, routeConnected, in);
        const bool goalMoved = g_navCache.valid &&
            LenSq(Sub(wg, g_navCache.goal)) > kNavGoalMoveTiles * kNavGoalMoveTiles;
        if (goalMoved && !sameGlobalRequest) {
            g_navCache.valid = false;
            g_navAwaiting = navWaiting = false;
            navStep = wg;
        }
        // Item 1 S2: route commitment. ON (default, settings.routeCommit): once a
        // route is accepted, keep following it through a reflex detour — Follow
        // already rejoins the polyline at the nearest forward point regardless of
        // how far the detour pushed the player (routeConnected) — and re-plan only
        // on a real trigger: the route is truly disconnected (routeConnected
        // false), the objective changed, the cached route ran out before the goal
        // (nearEnd), or no progress for 1.5 s (below, via g_navProgress). OFF
        // reproduces the old plain "5 tiles off the route -> re-plan" rule exactly.
        const bool objectiveChanged = g_navCache.valid && settings.routeCommit &&
            !objective.SameObjective(g_lastRouteObjective);
        const bool routeInvalidated = settings.routeCommit
            ? (g_navCache.valid && !routeConnected)
            : (dev > kNavDeviateTiles);
        const bool routeExhausted = nearEnd && (g_navCache.partial ||                    // consumed a partial route → extend
            LenSq(Sub(in.player, wg)) > kNavEndTiles * kNavEndTiles);                    // at route end but not the goal
        navRejoin = settings.routeCommit && routeConnected && dev > kNavDeviateTiles;
        navReplan = goalMoved || !g_navCache.valid || objectiveChanged || routeInvalidated || routeExhausted;
        if (goalMoved)               navReplanReason = Telemetry::ReplanReason::GoalMoved;
        else if (!g_navCache.valid)  navReplanReason = Telemetry::ReplanReason::Invalidated;
        else if (objectiveChanged)   navReplanReason = Telemetry::ReplanReason::ObjectiveChanged;
        else if (routeInvalidated)   navReplanReason = Telemetry::ReplanReason::Invalidated;
        else if (routeExhausted)     navReplanReason = Telemetry::ReplanReason::Arrival;
        g_lastRouteObjective = objective;

        // Blocked corridor: replan immediately. Small alternating nudges do
        // not count as progress; real movement around a wall does, even when
        // temporarily moving away from the final destination.
        const ULONGLONG nowNav = GetTickCount64();
        if (goalMoved) { g_navProgress.Reset(); ClearNavAvoid(); }
        // A keep-out that moved onto the route (its enemy walked there) blocks it as
        // surely as a wall: the solver will not step in, so re-plan now rather than
        // waiting for the stall timer.
        const auto keepoutOnRoute = [&]() {
            for (int i = 0; i < g_map.zoneCount; ++i) {
                const ZoneThreat& z = g_map.zones[i];
                if (!z.enemyKeepout || !z.active) continue;
                const float r = z.radius + kUPlayerHalf;
                if (Len(Sub(in.player, z.pos)) < r) continue;   // standing in it: leaving is allowed
                const Vec2 ab = Sub(navStep, in.player);
                const float l2 = LenSq(ab);
                const float s = l2 > 1e-12f ? std::clamp(Dot(Sub(z.pos, in.player), ab) / l2, 0.f, 1.f) : 0.f;
                if (Len(Sub(z.pos, Add(in.player, Mul(ab, s)))) < r) return true;
            }
            return false;
        };
        const bool blocked = g_navCache.valid &&
            (!Navigation::PaddedPathClear(in, in.player, navStep) || keepoutOnRoute());
        // Item 1 S2: "no progress along the route for 1.5 s" under route
        // commitment (a detour needs time to rejoin before the follower gives up
        // on the route); the pre-existing 500 ms timer otherwise.
        const bool stalled = in.speed > 0.f &&
            g_navProgress.Stalled(in.player, nowNav, g_navAwaiting, settings.routeCommit ? 1500ULL : 500ULL);
        // Item 1 S2 refinement (controller ruling): a step the GAME refuses is
        // direct evidence the committed route is wrong right here — the world
        // model disagrees with what the game actually allows — so it should not
        // have to wait out the (now longer) no-progress timer. Under route
        // commitment, a sustained refusal streak invalidates the route
        // immediately; it is the SAME signal (g_refusedFrames / kNavRefusedFrames-
        // ForAvoid / kNavRefusalFreshMs) that already feeds the navAvoid memory
        // below, just no longer gated on `stalled` first. OFF is unaffected:
        // refusedStreak is always false there, so the avoid-population and
        // replan conditions below reduce to exactly what they were before this
        // refinement. Cases with no refusal signal still wait the full 1.5 s.
        // Edge-triggered (g_refusedStreakFired), like Navigation::Progress::
        // Stalled's own self-reset: ONE streak forces ONE immediate re-plan, not
        // a fresh forced re-plan every tick the streak stays fresh (which, while
        // the follower holds at the player and issues no new command, never
        // re-arms on its own -- it stayed latched and thrashed the route every
        // tick; measured on j_hidden_blocker, fixed by this latch).
        const bool refusedFresh = g_refusedFrames >= kNavRefusedFramesForAvoid &&
            nowNav - g_lastRefusedMs <= kNavRefusalFreshMs;
        const bool refusedStreak = settings.routeCommit && refusedFresh && !g_refusedStreakFired;
        if (refusedStreak) g_refusedStreakFired = true;
        if ((stalled || refusedStreak) && refusedFresh) {
            // Remember the square just past the player box in the refused direction,
            // and its two neighbours across that direction: whatever refused the step
            // is more often a wall than a single post, and one square per stall made
            // the re-plan crawl along it a square at a time.
            const Vec2 dir = Normalize(Sub(g_lastCmdTo, g_lastCmdFrom));
            if (LenSq(dir) > 1e-6f) {
                const Vec2 ahead = Add(in.player, Mul(dir, kUOccPlayerHalfEdge + 0.35f));
                const Vec2 centre{ std::floor(ahead.x) + 0.5f, std::floor(ahead.y) + 0.5f };
                const Vec2 across = std::fabs(dir.x) >= std::fabs(dir.y) ? Vec2{ 0.f, 1.f } : Vec2{ 1.f, 0.f };
                for (float k : { 0.f, -1.f, 1.f }) {
                    NavAvoid& a = g_navAvoid[g_navAvoidNext];
                    a.pos = Add(centre, Mul(across, k));
                    a.untilMs = nowNav + kNavAvoidMs;
                    g_navAvoidNext = (g_navAvoidNext + 1) % kMaxNavAvoid;
                }
                DBG_FILE_LOG("[UDodge] stuck: game refused the route step; avoiding squares around ("
                             << centre.x << "," << centre.y << ") for the next plans");
                if (diagOn) ++DiagTiming::Game().navAvoids;
            }
        }
        if (diagOn) {
            if (blocked) ++DiagTiming::Game().navBlocked;
            if (stalled) ++DiagTiming::Game().navStalls;
        }
        if ((blocked || stalled || refusedStreak) && diagOn) {
            Vec2 avoid[kMaxNavAvoid];
            const int avoidCount = ActiveNavAvoid(avoid, nowNav);
            DiagStuckDump(blocked ? "blocked" : refusedStreak ? "refused" : "stalled", in.player, wg, navStep,
                          lockApproach, in, g_map, avoidCount, avoid);
        }
        if (blocked || stalled || refusedStreak) {
            navReplan = true;
            navReplanReason = blocked ? Telemetry::ReplanReason::Blocked
                             : refusedStreak ? Telemetry::ReplanReason::Refused
                             : Telemetry::ReplanReason::NoProgress;
            g_navAwaiting = navWaiting = true;
            g_navCache.valid = false;
            navStep = in.player;
        }
        g_wedged.store(!lockApproach && (blocked || stalled || refusedStreak), std::memory_order_relaxed);
        // Plan 89: publish the wedge observation (goal, player, freshness stamp).
        // A locked-target approach is not a commanded walk; it never asks for walls to break.
        g_wedgeWalkActive.store(!lockApproach, std::memory_order_relaxed);
        g_wedgeGoalX.store(wg.x, std::memory_order_relaxed);
        g_wedgeGoalY.store(wg.y, std::memory_order_relaxed);
        g_wedgePlayerX.store(in.player.x, std::memory_order_relaxed);
        g_wedgePlayerY.store(in.player.y, std::memory_order_relaxed);
        g_wedgeStampMs.store(static_cast<uint32_t>(nowNav), std::memory_order_relaxed);
        if (navWaiting) navStep = in.player;
        else if (!g_navCache.valid) {
            // A destination is not a corridor. Only use it directly when the
            // entire padded sweep is known clear; otherwise wait for A*.
            if (Navigation::PaddedPathClear(in, in.player, wg)) navStep = wg;
            else {
                g_navAwaiting = navWaiting = true;
                navStep = in.player;
            }
        }
    } else {
        g_navProgress.Reset();
        g_navAwaiting = false;
        g_navCache.valid = false;              // walk-to ended → drop the cache
        g_lastRouteObjective = GoalOwner{};     // Item 1 S1/S2: next walk-to starts as a plan, not a replan
        g_routeId = 0;
        ClearNavAvoid();
        g_wedged.store(false, std::memory_order_relaxed);            // plan 89: walk-to ended
        g_wedgeWalkActive.store(false, std::memory_order_relaxed);
    }

    Solver::Goal goal{};
    if (wasdActive) {
        // WASD is relative to the ROTATED camera view (W = up on screen). Rotate
        // the raw screen-space direction by the live camera yaw so movement matches
        // what the player sees when the camera is turned.
        const float camRad = -CameraTAB::GetAngle() * (kTwoPi / 360.f);
        const float cs = std::cos(camRad), sn = std::sin(camRad);
        const Vec2 dir = Normalize(Vec2{
            steer.dirX * cs - steer.dirY * sn,
            steer.dirX * sn + steer.dirY * cs });
        if (LenSq(dir) > 1e-6f) {
            goal.active = true;
            goal.pos = Add(in.player, Mul(dir, b));   // WASD intent one budget ahead
        }
    } else if (walkActive) {
        // Walk-to spot: the solver ACTIVELY pathfinds here (goal.walkTo) while the
        // micro-dodge floor keeps dodging on the way. Steer along the CACHED nav
        // route's step target (navStep) — we FOLLOW the route and only re-plan on a
        // real trigger (see the re-plan decision above), rather than re-running the
        // A* every tick.
        goal.active = true;
        goal.walkTo = true;
        goal.pos = navStep;
    } else if (g_map.hasLock) {
        const LockGeometry lg = ComputeLockGeometry(settings, g_map.lockBand);
        const float innerStandoff = lg.innerStandoff;
        const float engagementRange = lg.engagementRange;
        const float standoff = lg.standoff;
        const Vec2 fromLock = Sub(in.player, g_map.lockPos);
        const float dist = Len(fromLock);
        if (dist > 1e-3f) {
            const Vec2 dir = Mul(fromLock, 1.f / dist);
            goal.active = true;
            goal.pos = Add(g_map.lockPos, Mul(dir, standoff));  // on the player-side ray
        }
        // Stay-in-range: the solver holds when safe & inside the annulus, repositions
        // inward when we drift past weaponRange or outward when we hug past
        // innerStandoff, and biases dodges to keep the annulus.
        goal.fromLock = true;
        goal.lockPos  = g_map.lockPos;
        goal.maxRange = engagementRange;  // inset outer radius: shots connect reliably
        goal.innerStandoff = innerStandoff; // annulus INNER radius (never fight point-blank)
    }

    {
        std::lock_guard<std::mutex> guard(g_groupMutex);
        Vec2 target{};
        const bool freshGroup = g_groupPreference.Read(GetTickCount64(), g_map.hasLock ? g_map.lockId : 0, in.player, target);
        goal.groupActive = freshGroup && goal.fromLock && !wasdActive && !walkActive;
        goal.groupPos = target;
    }
    const int32_t groupBossId = goal.groupActive ? g_map.lockId : 0;
    const bool groupChanged = goal.groupActive != g_previousGroupActive || groupBossId != g_previousGroupBoss
        || (goal.groupActive && LenSq(Sub(goal.groupPos, g_previousGroupPosition)) > 0.0025f);
    g_previousGroupActive = goal.groupActive;
    g_previousGroupPosition = goal.groupPos;
    g_previousGroupBoss = groupBossId;

    // ── Async grid pathfinder: publish snapshot + consume latest route ───────
    // The heavy grid Dijkstra + radius expansion runs on the WORKER thread over a
    // PLAIN-DATA snapshot; the game thread NEVER blocks on it. Publish is gated to
    // the ACTUAL server-tick change (~5 Hz) — the rasterize (FillOccGrid) + the
    // snapshot copy are the only added game-thread cost, so they run at tick rate,
    // not per frame. The route we consume only BIASES the lookahead; the immediate
    // micro-dodge floor below stays authoritative even when it is a tick stale.
    static Path::PlannerSnapshot s_snap;   // large (danger map + occ grid) — keep off the stack
    static uint32_t s_lastPubTick = 0xFFFFFFFFu;
    static int      s_pubFrame    = 0;
    const bool tickChanged      = tickOk && tick != s_lastPubTick;
    const bool throttleFallback = !tickOk && ((s_pubFrame++ % 12) == 0);
    if (rebuilt || tickChanged || throttleFallback) {
        // Distance-sampled breadcrumbs preserve the corridor used to enter a room.
        // One older point inside the local planner window is enough to disambiguate
        // "run back" from "go deeper" without turning the trail into a hard goal.
        if (g_trailCount == 0 || Len(Sub(in.player, g_trail[0])) > 20.f) {
            g_trail[0] = in.player;
            g_trailCount = 1;            // initial sample or realm teleport
        } else if (Len(Sub(in.player, g_trail[0])) >= 0.75f) {
            const int lim = std::min(g_trailCount, 15);
            for (int i = lim; i > 0; --i) g_trail[i] = g_trail[i - 1];
            g_trail[0] = in.player;
            g_trailCount = std::min(g_trailCount + 1, 16);
        }
        bool retreatValid = false;
        Vec2 retreatPos{};
        for (int i = 1; i < g_trailCount; ++i) {
            const float d = Len(Sub(in.player, g_trail[i]));
            if (d >= 1.5f && d <= 8.f) {
                retreatValid = true;
                retreatPos = g_trail[i]; // oldest/farthest breadcrumb still local
            }
        }
        // Publish is tick-gated, so re-rasterize walls each publish (once per tick,
        // ~5 Hz). REGION #2: when locked on a boss, CENTER the search grid on the
        // BOSS so the whole in-range disk (every spot from which the boss is still
        // hittable — including the far side) is inside the searchable window and the
        // route can thread a safe arc AROUND the boss, not just a 12-tile bubble
        // around the player. Unlocked → player-centered as before. The worker starts
        // its search from the player's cell within this window (StartCell).
        //
        // FINDING L: boss-centring only helps while the PLAYER IS INSIDE the window.
        // Beyond it, Path::PlayerCell CLAMPS the start to the grid edge, so the
        // search starts from a cell the player is not standing in while RunSearch
        // measures the step target from the REAL player — the first step can point
        // somewhere the route never goes. That is exactly the "drifted out of range,
        // reposition inward" case, i.e. the moment the route matters most. So fall
        // back to player-centred once the player is near/past the window edge: the
        // boss then sits outside the grid, the disk gate simply admits no in-range
        // goal, and ComputeDodge's existing unconstrained re-search takes over.
        // Margin of 2 cells (1 tile) so a player hugging the boundary — or one who
        // moved since this tick's raster — is never planned from a clamped start.
        constexpr float kGridEdgeMarginTiles =
            (kUPathMaxRadCells - 2) * kUPathCellTiles;   // 11 tiles of the 12-tile window
        const bool playerInGrid =
            std::max(std::fabs(in.player.x - goal.lockPos.x),
                     std::fabs(in.player.y - goal.lockPos.y)) <= kGridEdgeMarginTiles;
        const bool lockedCenter = goal.fromLock && goal.maxRange > 0.f && playerInGrid;
        Vec2 gridCenter         = lockedCenter ? goal.lockPos : in.player;
        // LATTICE (Tactician S3.8). The window's cells sit at centre + k x cell, so a
        // centre that drifts with the player re-cuts the plane every publish: the cell
        // the previous goal fell in is a different point each time, the commitment
        // hysteresis cannot recognise its own goal, and the route jitters. Snapping the
        // centre to the 0.5-tile lattice makes every publish share one cell grid, so a
        // goal re-snaps to itself while the player moves through it.
        // The lattice is offset by half a cell so no cell centre ever lands exactly
        // on a tile boundary: under the game's point rule a centre on the edge of a
        // FullOccupy object is refused, and a route made of such cells is one the
        // game declines move after move (measured: d_boss_wall_rings [game] stuck
        // 36 s with 1981 refused moves on the unoffset lattice).
        // Item 1 S3 was tried and REVERTED (see the navigation finish plan
        // ledger): extending this snap to Classic measurably regressed
        // e_corridor1_fullocc under navCollisionRule=legacy (4.78s -> 12.78s,
        // 0 -> 5 extra nav re-plans; a 1-tile-wide FullOccupy corridor, where
        // the legacy player-box+padding rule is tight enough that the
        // lattice-snapped dodge grid centre stops lining up with the
        // corridor's walkable cells the way the unsnapped, player-centred
        // grid did). Reproduced 3x on the affected commit, absent on the
        // commit before it (isolated by archiving both trees and diffing
        // run_scenarios.py --metrics). Classic keeps the pre-Item-1 grid
        // centring unconditionally; only Tactician gets the lattice snap.
        if (settings.planner == Contact::Policy::Tactician) {
            constexpr float kHalfCell = kUPathCellTiles * 0.5f;
            gridCenter.x = std::round((gridCenter.x - kHalfCell) / kUPathCellTiles) * kUPathCellTiles + kHalfCell;
            gridCenter.y = std::round((gridCenter.y - kHalfCell) / kUPathCellTiles) * kUPathCellTiles + kHalfCell;
        }
        {
            PhaseTimer _p(DiagTiming::Game().rasterOcc);
            FillOccGrid(s_snap.grid, gridCenter, true, collisionRule, g_map);
        }
        s_snap.commitment       = g_commitment;
        s_snap.tickId           = g_map.tickId;
        s_snap.player           = in.player;
        s_snap.moveBudget       = b;
        // FINDING K: carry the REAL player speed (tiles/ms) so the worker's
        // arrival-time grid and this thread's step validation agree on how fast the
        // player actually moves. moveBudget above is in.stepTiles, which decouples
        // from the real speed the moment the user sets the "Step distance" slider
        // or the auto clamp [0.4, 3.0] binds — it stays a step-LENGTH knob only.
        s_snap.speed            = in.speed;
        s_snap.baseSpeed        = baseTilesPerSec / 1000.f;
        s_snap.settings         = settings;
        s_snap.goalActive       = goal.active;
        s_snap.goalPos          = goal.pos;
        s_snap.goalWalkTo       = goal.walkTo;
        s_snap.groupActive      = goal.groupActive;
        s_snap.groupPos         = goal.groupPos;
        s_snap.groupBossId      = groupBossId;
        s_snap.playerOnHazard   = in.playerOnHazard;
        s_snap.hasLock          = goal.fromLock;
        s_snap.lockPos          = goal.lockPos;
        s_snap.weaponRangeTiles = goal.fromLock ? goal.maxRange : 0.f;
        s_snap.innerStandoffTiles = goal.fromLock ? goal.innerStandoff : 0.f;
        // A lock approach is a walk-to (goal.fromLock is off), so the ring travels on
        // its own flag. The grid stays player-centred: the ring's near side is inside it.
        s_snap.ringApproach     = ringApproach;
        if (ringApproach) {
            s_snap.lockPos            = g_map.lockPos;
            s_snap.weaponRangeTiles   = ringOuter;
            s_snap.innerStandoffTiles = ringInner;
        }
        // Plan-commitment hysteresis (plan 76): carry the last accepted route goal
        // into the snapshot so the worker Dijkstra prefers it among near-equal
        // options. g_route still holds the PREVIOUS tick's route here (it is refreshed
        // below, after this publish block), so this is exactly last tick's committed goal.
        s_snap.prevGoalValid    = g_route.found;
        s_snap.prevGoalPos      = g_route.goalPos;
        s_snap.retreatValid     = retreatValid;
        s_snap.retreatPos       = retreatPos;
        s_snap.map              = g_map;    // plain-data danger copy (lanes/zones/enemies)
        s_snap.collisionRule    = collisionRule;
        s_snap.planner          = settings.planner;
        // Navigation (walk-to): only ask the worker to (re)plan — and only pay the
        // large nav-grid rasterize — when a re-plan is actually triggered (navReplan).
        // Between re-plans we FOLLOW the cached route, so the walk-to costs nothing
        // here on most ticks. This is the walk-to perf win.
        s_snap.navActive        = walkActive && navReplan;
        s_snap.navGoal          = { walkX, walkY };
        s_snap.navGoalRadius    = navGoalRadius;
        s_snap.navAvoidCount    = ActiveNavAvoid(s_snap.navAvoid, GetTickCount64());
        if (s_snap.navActive) {
            PhaseTimer _p(DiagTiming::Game().rasterNav);
            FillNavGrid(s_snap.navGrid, in.player, settings.safeWalk, collisionRule,
                        g_map, true, Vec2{ walkX, walkY });
            if (diagOn) ++DiagTiming::Game().navReplans;
        }
        uint32_t pub = 0;
        {
            PhaseTimer _p(DiagTiming::Game().publish);
            pub = Worker::PublishSnapshot(s_snap);
        }
        if (diagOn && pub == 0) ++DiagTiming::Game().publishDropped;
        if (pub) g_lastPubSeq = pub;
        if (tickOk) s_lastPubTick = tick;
    }

    // Refresh the cached route when the worker isn't busy (non-blocking — keeps the
    // last route on contention / cold start).
    Worker::Result fresh{};
    bool rejectedFreshWalk = false;
    bool commitmentChanged = false;
    bool navCacheRefreshed = false;
    bool navArrivedFresh = false;
    bool acceptedWalkSolve = false;
    Vec2 acceptedWalkStep{};
    if (Worker::TryGetLatest(fresh)) {
        const bool seqFresh = fresh.plan.forSeq != 0 && g_lastPubSeq >= fresh.plan.forSeq
            && (g_lastPubSeq - fresh.plan.forSeq) <= kUPlanMaxStaleSeq;
        const bool walkMatches = fresh.walkActive == walkActive
            && (!walkActive || LenSq(Sub(fresh.walkGoal, Vec2{walkX, walkY})) <= 0.25f * 0.25f);
        const float maxOriginDrift = std::max(3.f, b * 2.f);
        const bool originFresh = LenSq(Sub(fresh.snapshotPlayer, in.player))
            <= maxOriginDrift * maxOriginDrift;
        const bool groupMatches = fresh.groupActive == goal.groupActive && fresh.groupBossId == groupBossId
            && (!goal.groupActive || LenSq(Sub(fresh.groupPos, goal.groupPos)) <= 0.0025f);
        const bool acceptFresh = seqFresh && walkMatches && originFresh && groupMatches;
        if (diagOn) {
            DiagTiming::GameStats& gs = DiagTiming::Game();
            ++(acceptFresh ? gs.workerAccepted : gs.workerDiscarded);
            if (fresh.plan.found) ++(fresh.plan.partial ? gs.routePartial : gs.routeFound);
            gs.workerDodgeMsMax = std::max(gs.workerDodgeMsMax, fresh.plan.computeDodgeMs);
            gs.workerNavMsMax   = std::max(gs.workerNavMsMax, fresh.plan.computeNavMs);
            gs.workerTimedMsMax = std::max(gs.workerTimedMsMax, fresh.timedMs);
            gs.workerSolveMsMax = std::max(gs.workerSolveMsMax, fresh.solveMs);
            g_telemetryWorker.dodgeMs = fresh.plan.computeDodgeMs;
            g_telemetryWorker.navMs = fresh.plan.computeNavMs;
            g_telemetryWorker.timedMs = fresh.timedMs;
            g_telemetryWorker.solveMs = fresh.solveMs;
            g_telemetryWorker.timedStatus = fresh.timedStatus;
            g_telemetryWorker.timedReused = fresh.timedReused;
            g_telemetryWorker.timedBudgetHit = fresh.timedBudgetHit;
        }
        if (acceptFresh) {
            g_route = fresh.plan;
            g_timed = fresh.timed;
            g_timedSeq = fresh.plan.forSeq;
            if (g_commitment.Accepts(fresh.commitmentRevision)) {
                g_solve = fresh.solve;
                acceptedWalkSolve = walkActive;
                acceptedWalkStep = fresh.solveGoal;
                proposedState = fresh.solveState;
                g_solveSeq = fresh.plan.forSeq;
            } else {
                // Keep the route as a hint, but score a new immediate decision
                // from the movement accepted since this worker snapshot.
                commitmentChanged = true;
            }
        } else {
            rejectedFreshWalk = walkActive;
            DBG_FILE_LOG("[UDodge] Discard stale worker result seq=" << fresh.plan.forSeq
                << " latest=" << g_lastPubSeq << " walkMatch=" << walkMatches
                << " originFresh=" << originFresh);
        }
        static int s_wpN = 0;
        if (acceptFresh && (s_wpN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] Worker route seq=" << g_route.forSeq
                << " found=" << g_route.found << " len=" << g_route.waypoints
                << " gridR=" << g_route.radiusCells << " pops=" << g_route.pops
                << " expanded=" << g_route.expanded
                << " partial=" << g_route.partial
                << " tempGoal=" << g_route.tempGoal
                << " arriveMs=" << g_route.goalArriveMs
                << " | nav found=" << g_route.navFound
                << " partial=" << g_route.navPartial
                << " arrived=" << g_route.navArrived
                << " wpts=" << g_route.navWptCount
                << " navPops=" << g_route.navPops
                << " step=(" << g_route.navStepTarget.x << "," << g_route.navStepTarget.y << ")"
                << " goalCell=(" << g_route.navGoalCell.x << "," << g_route.navGoalCell.y << ")"
                << " cDodgeMs=" << g_route.computeDodgeMs
                << " cNavMs=" << g_route.computeNavMs);

        // Cache a fresh nav route so we FOLLOW it between re-plans (walk-to perf).
        // Only updates when the worker actually ran the nav A* (navFound) — which is
        // only when we requested a re-plan (navActive), so the cache holds the last
        // committed route until the next trigger.
        if (acceptFresh && Movement::Nav::Runtime::Enabled() && g_globalRawActive &&
            LenSq(Sub(g_globalRawGoal, Vec2{walkX, walkY})) < 0.01f && g_route.navPops > 0 &&
            (!g_route.navFound || g_route.navPartial))
            g_globalAssistance = true;
        if (acceptFresh && g_route.navArrived) {
            g_navAwaiting = false;
            navArrivedFresh = true;
        }
        if (acceptFresh && g_route.navFound && g_route.navWptCount >= 2) {
            g_navAwaiting = false;
            g_navCache.valid   = true;
            navCacheRefreshed = true;
            ++g_routeId;   // Item 1 S4 telemetry: a genuinely new committed route
            g_navCache.goal    = { walkX, walkY };
            g_navCache.n       = std::min(g_route.navWptCount, kMaxNavWpts);
            for (int i = 0; i < g_navCache.n; ++i) g_navCache.wpts[i] = g_route.navWpts[i];
            g_navCache.partial = g_route.navPartial;
            g_navCache.crossesHazard = g_route.navCrossesHazard;
            if (diagOn && g_route.navCrossesHazard) ++DiagTiming::Game().hazardRoutes;
        } else if (acceptFresh && g_route.navPops > 0 &&
                   g_route.navWptCount < 2 && !g_route.navArrived) {
            // No reachable route is not permission to drive at the raw goal.
            // Keep requesting A* as the map streams and preserve dodge safety.
            g_navCache.valid = false;
            g_navAwaiting = true;
        }
    }

    // The worker may have released the wait and replaced the corridor above.
    // Refresh BOTH the local waiting flag and steering goal before any fallback
    // solve; otherwise an accepted route is immediately overwritten by HOLD.
    navWaiting = g_navAwaiting;
    if (goal.walkTo && navArrivedFresh) navStep = {walkX, walkY};
    else if (goal.walkTo && navCacheRefreshed && g_navCache.valid && !navWaiting) {
        float dev = 0.f; bool nearEnd = false; bool routeConnected = false;
        navStep = NavStepFromCache(g_navCache, in.player,
            std::max(b, 1.f) * kUNavLookaheadBudgets, dev, nearEnd, routeConnected, in);
    }
    // RING ROUTE: while a lock approach has a fresh dodge route whose goal lies in
    // the ring, this frame steers by THAT route's step target, not the corridor's.
    // No second follower: the step target sits ~kUStepLookaheadBudgets budgets ahead
    // and is replaced every publish, exactly as the in-ring orbit consumes it. The
    // solver's walk-to step still has to pass every floor (walls, bodies, blasts,
    // Temporal::PathClear); when it does not, the pre-position branch, the timed
    // advice and the reflex decide as before. Any frame without such a route — none
    // delivered, stale, or the follower waiting on the A* — is today's walk-to.
    const bool ringRoute = settings.planner == Contact::Policy::Tactician &&
        lockApproach && goal.walkTo && !navWaiting &&
        g_route.found && g_route.ringGoal &&
        g_lastPubSeq >= g_route.forSeq && (g_lastPubSeq - g_route.forSeq) <= kUPlanMaxStaleSeq;
    const Vec2 steerStep = ringRoute ? g_route.stepTarget : navStep;
    const auto navHandoff = Navigation::FinishRefresh(goal.walkTo, wasNavWaiting, navWaiting,
        g_navCache.valid, in.player, navStep, rebuilt || tickChanged || throttleFallback,
        commitmentChanged, rejectedFreshWalk,
        (acceptedWalkSolve && LenSq(Sub(acceptedWalkStep, navWaiting ? in.player : steerStep))
            > kUNavAnchorArriveTiles * kUNavAnchorArriveTiles)
        || (!UsesGameRule(in) && Navigation::TravelStepConsumed(goal.walkTo, g_navCache.valid, navWaiting,
            g_solve.shouldMove && g_solve.kind == Solver::SolveKind::Safe,
            in.player, g_solve.target, steerStep, in.speed * Clamp(dt * 1000.f, 1.f, 250.f))));
    if (goal.walkTo) {
        navStep = navHandoff.step;
        goal.pos = ringRoute ? steerStep : navStep;
    }

    // Staleness gate: only feed the solver a route recent enough to trust as a
    // lookahead. Too stale (or cold) → an empty route → pure immediate dodge.
    Path::PlanResult routeForSolve{};
    if (g_route.found &&
        g_lastPubSeq >= g_route.forSeq &&
        (g_lastPubSeq - g_route.forSeq) <= kUPlanMaxStaleSeq) {
        routeForSolve = g_route;
    }

    // The timed advice is a lookahead exactly like the route above, so it gets
    // the same freshness rule: an advice computed for a snapshot too many
    // publishes back is dropped rather than steered by. A commanded walk-to owns
    // direction, so the advice is withheld there too — dodging still happens
    // through the reflex, which the walk-to path already defers to.
    Solver::TimedAdvice timedForSolve{};
    if (g_timed.valid && g_timedSeq != 0 && g_lastPubSeq >= g_timedSeq &&
        (g_lastPubSeq - g_timedSeq) <= kUPlanMaxStaleSeq && !goal.walkTo)
        timedForSolve = g_timed;

    // A cold/late worker must not stall navigation or leave an old absolute
    // target behind the player. The expensive grid search stays asynchronous;
    // this is only the small live safety solver, at server-tick cadence.
    if (navWaiting) routeForSolve = Path::PlanResult{};
    if (diagOn && navWaiting) ++DiagTiming::Game().navWaitFrames;
    // ── Frame-cost ceiling (navigation finish plan, Item 4) ──────────────────
    // Set immediately before the solver phases (liveSolve below, then
    // revalidate) so BOTH calls this tick see the same decision. "auto"
    // degrades ONLY the candidate ring (BuildCandidates); it never skips
    // ReanchorMap/BuildMap above, never drops a lane the relevance cull kept,
    // and never relaxes a safety floor on the step finally chosen — Evaluate
    // and the temporal admission tests still run, unchanged, on whatever
    // candidates the (possibly smaller) ring produces.
    if (g_frameBudgetAuto.load(std::memory_order_relaxed)) {
        const bool overBudget = (DiagTiming::NowMs() - tickStartMs) > kFrameBudgetMs;
        Solver::SetFrameDegraded(overBudget);
        if (overBudget) {
            ++DiagTiming::Game().frameBudgetHits;
            static int s_fbN = 0;
            if ((s_fbN++ % 120) == 0)
                DBG_FILE_LOG("[UDodge] Frame budget: over " << kFrameBudgetMs
                             << " ms before the solver phases -> fewer candidates this frame"
                             << " (hits=" << s_fbN << ")");
        }
    }
    if (navHandoff.solve || groupChanged) {
        PhaseTimer _p(DiagTiming::Game().liveSolve);
        Solver::Solve(in, b, goal, routeForSolve, proposedState, g_solve, timedForSolve, &g_sharedTemporalCtx);
    }

    // Normal temporal solving is performed with the path search on the worker.
    // The game thread keeps only the emergency same-frame re-solve below when a
    // live re-anchor invalidates the worker's already-published target.

    // How much of last frame's commanded step the game actually granted. Refusal
    // (under a quarter of the command, frame after frame) is the stuck-memory cue.
    if (g_lastCmdValid) {
        const Vec2 cmd = Sub(g_lastCmdTo, g_lastCmdFrom);
        const float cmdLen = Len(cmd);
        const float granted = cmdLen > 1e-4f ? Dot(Sub(in.player, g_lastCmdFrom), Mul(cmd, 1.f / cmdLen)) : 0.f;
        if (cmdLen >= 0.01f && granted < 0.25f * cmdLen) {
            ++g_refusedFrames;
            g_lastRefusedMs = GetTickCount64();
        } else {
            g_refusedFrames = 0;
            g_refusedStreakFired = false;   // a real granted step re-arms the trigger
        }
    }
    g_lastCmdValid = false;

    const float frameMs = Clamp(dt * 1000.f, 1.f, 250.f);
    Vec2 moveTarget = in.player;
    bool moveFailed = false;

    // ── One movement allowance per game update ───────────────────────────────
    // The game's own update already moved the player from input (and the server
    // may have corrected them) before this tick runs. Charge that travel against
    // this update's allowance so our step does not stack on top of it: the solver
    // validated a step of one frame's travel, and two frames of travel is not the
    // motion it approved. When the accounting is unavailable we keep the previous
    // pure per-frame clamp, so this can only ever tighten the step, never widen it.
    const auto frameMove = DodgeRuntime::BeginMovementFrame(player, frameMs, in.speed);

    // Validate against this frame's map and replace unsafe decisions before
    // driving. A rebuild must not suppress the immediate solve while the worker
    // is still processing its snapshot.
    bool reflexVeto = false;   // telemetry only: set inside the diagnostics branch below
    {
        PhaseTimer _p(DiagTiming::Game().revalidate);
        CoreState safetyState = g_commitment.state;
        if (Solver::RevalidateAndSolve(in, b, goal, routeForSolve, safetyState, g_solve, rebuilt,
                                       timedForSolve, &g_sharedTemporalCtx)) {
            proposedState = safetyState;
            if (diagOn) { ++DiagTiming::Game().revalidateResolves; reflexVeto = true; }
        }
    }
    if (diagOn) {
        DiagTiming::GameStats& gs = DiagTiming::Game();
        switch (g_solve.kind) {
            case Solver::SolveKind::Hold:       ++gs.holds;      break;
            case Solver::SolveKind::Safe:       ++gs.safes;      break;
            case Solver::SolveKind::Fallback:   ++gs.fallbacks;  break;
            case Solver::SolveKind::Surrounded: ++gs.surrounded; break;
        }
    }

    // ── Drive toward the (possibly re-solved) target ─────────────────────────
    // Enemy bodies stay a hard no-go even after a re-solve; a target that is
    // enemy-blocked now is not driven (the next tick's fresh solve re-picks).
    const bool enemyDriveClear = (g_solve.kind == Solver::SolveKind::Fallback)
        ? Core::EnemyEscapePathClear(in, in.player, g_solve.target)    // partial outward escape
        : !Core::EnemyPathBlocked(in, in.player, g_solve.target);       // finding J: swept
    // Re-solving can choose a new emergency fallback. Apply its zone/ground
    // rules again at execution, rather than assuming rejection made it safe.
    const bool drivePathClear = OccupancyPathClear(in, in.player, g_solve.target) &&
        (g_solve.kind == Solver::SolveKind::Fallback
            ? Core::ZoneEscapePathClear(in, in.player, g_solve.target)
            : Core::ZonePathClear(in, in.player, g_solve.target));
    if (g_solve.shouldMove && enemyDriveClear && drivePathClear) {
        const Vec2 to = Sub(g_solve.target, in.player);
        const float d = Len(to);
        const Vec2 dir = d > 1e-4f ? Mul(to, 1.f / d) : Vec2{};
        // Per-frame step, clamped to the player's speed. The game's MoveTo does
        // NOT clamp again (LKHPPBEGNOM::DGLCONCOIBO sets the position outright), so
        // in.speed must be the speed the game allows — Slowed and the square's
        // speed included (DodgeRuntime::GetTilesPerSec). Converges onto the target
        // by the tick boundary without ever exceeding the per-tick budget.
        float reach = std::min(d, in.speed * frameMs);
        if (frameMove.budgeted) reach = std::min(reach, frameMove.tiles);
        moveTarget = Add(in.player, Mul(dir, reach));
        // A fully consumed allowance means the game already moved the player a
        // frame's worth this update; issuing a zero-length MoveTo would only
        // re-assert the position, so skip the call and keep the commitment.
        const bool ok = reach > 1e-4f
            ? DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y) : true;
        if (reach > 1e-4f) { g_lastCmdFrom = in.player; g_lastCmdTo = moveTarget; g_lastCmdValid = true; }
        if (!ok) moveFailed = true;
        if (diagOn) ++(ok ? DiagTiming::Game().moves : DiagTiming::Game().moveRefused);
        g_commitment.Record(proposedState, Sub(moveTarget, in.player), ok);
        static int s_mvN = 0;
        if ((s_mvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] MOVE kind=" << (int)g_solve.kind
                << (g_solve.inRangeDisk
                        ? (g_solve.outOfRange
                               ? (g_solve.prePosition ? " DISK-OOR-PREPOS" : " DISK-OOR")
                               : (g_solve.prePosition ? " INRANGE-PREPOS" : " INRANGE"))
                        : (g_solve.prePosition ? " PREPOS(temporal)" : " IMMED"))
                // This step came from the bounded temporal planner's advice
                // rather than the route/reflex ladder (it still passed every floor).
                << (g_solve.timedEscape ? " TIMED" : "")
                // Route tag: following a curved multi-waypoint grid route around
                // an obstacle (PATH) vs a straight immediate/pre-position step.
                << (g_solve.followedRoute
                        ? (g_solve.routeExpanded ? " PATH+EXP len=" : " PATH len=")
                        : " STRAIGHT len=")
                << (int)g_solve.routeWaypoints
                << " gridR=" << (int)g_solve.routeRadius
                << " pops=" << (int)g_solve.routePops
                << " bossDist=" << (g_map.hasLock
                        ? std::sqrt((g_solve.target.x - g_map.lockPos.x) * (g_solve.target.x - g_map.lockPos.x)
                                  + (g_solve.target.y - g_map.lockPos.y) * (g_solve.target.y - g_map.lockPos.y))
                        : 0.f)
                << " pocketDist=" << g_solve.pocketDist
                << " tempLanes=" << (int)g_solve.tempLanes
                // Temporal durability of the chosen target (0 = clears the dwell
                // window and no more, 1 = clear through the whole horizon).
                << " dur=" << g_solve.targetDurability
                << " envelope=" << (g_moveEnvelopeArmed.load(std::memory_order_relaxed) ? 1 : 0)
                << " srvErr=" << in.settings.positionUncertainty
                // Smoothing diagnostics: dot of the route step vs the previous
                // committed heading (1=same, -1=reversal), and whether the
                // anti-oscillation guard damped a hard route reversal this tick.
                << " stepDot=" << g_solve.routeStepDot
                << (g_solve.routeDamped ? " DAMPED" : "")
                << " clr=" << g_solve.clearance << " frameMs=" << frameMs
                << " -> (" << moveTarget.x << "," << moveTarget.y
                << ") from (" << in.player.x << "," << in.player.y << ") ok=" << ok);
    } else if (!g_solve.shouldMove) {
        static int s_noMvN = 0;
        if ((s_noMvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] NO-MOVE kind=" << (int)g_solve.kind
                << (g_solve.timedEscape ? " TIMED-WAIT" : "")
                << " pocketDist=" << g_solve.pocketDist
                << " clr=" << g_solve.clearance);
    }

    DodgeRuntime::EndMovementFrame(player);

    // Server-accurate clearance at the player (≤ 0 ⇒ danger covers the stand).
    // Computed once here (unconditional): it feeds both the debug snapshot below
    // and the AutoNexus last-resort signal at the end of Tick (plan 77), which
    // must be published even when the debug overlay is off.
    float standClr = Core::PointSafety(in, in.player);
    if (g_serverAnchorValid.load(std::memory_order_acquire)) {
        const Vec2 serverPos{ g_serverAnchorX.load(std::memory_order_relaxed),
                              g_serverAnchorY.load(std::memory_order_relaxed) };
        standClr = std::min(standClr, Core::PointSafety(in, serverPos));
    }

    if (settings.debugOverlay) {
        PhaseTimer _p(DiagTiming::Game().debug);
        static DebugSnapshot d;   // large (holds the danger map) — keep off the stack
        d.active = true;
        // SolveKind → the closest legacy Decision label for the overlay header.
        switch (g_solve.kind) {
            case Solver::SolveKind::Hold:       d.decision = Decision::NoThreat;        break;
            case Solver::SolveKind::Safe:       d.decision = Decision::GentleOverride;  break;
            case Solver::SolveKind::Fallback:   d.decision = Decision::EmergencyOverride; break;
            case Solver::SolveKind::Surrounded: d.decision = Decision::MovementLocked;  break;
        }
        d.solveKind = static_cast<uint8_t>(g_solve.kind);
        d.player = in.player;
        d.serverAnchorValid = g_serverAnchorValid.load(std::memory_order_acquire);
        d.serverAnchor = { g_serverAnchorX.load(std::memory_order_relaxed),
                           g_serverAnchorY.load(std::memory_order_relaxed) };
        d.intentDir = goal.active ? Normalize(Sub(goal.pos, in.player)) : Vec2{};
        d.moveTarget = g_solve.shouldMove ? g_solve.target : in.player;
        d.overrideActive = g_solve.shouldMove;
        d.moveFailed = moveFailed;
        d.candidate = kStandCandidate;
        d.speedScale = 1.f;
        d.threatCount = g_map.laneCount;
        // Server-accurate clearance at the player (≤ 0 ⇒ danger covers the stand).
        d.standClearance = standClr;
        d.speed = in.speed;
        d.stepTiles = in.stepTiles;
        d.reactMargin = settings.reactMargin;
        d.tickId = g_map.tickId;
        d.tickValid = g_map.tickValid;
        d.rebuiltThisFrame = rebuilt;
        d.fieldActive = false;
        d.fieldTarget = {};
        d.flowDir = {};
        d.flowCoherence = 0.f;
        d.hasLockTarget = goal.active;
        d.lockTarget = goal.pos;
        // Publish the worker grid route so the overlay can DRAW it (FIX: the user
        // could not see the planned path). Route polyline → path[]; the durable-safe
        // goal → routeGoal; the weapon-range disk radius (locked boss) → inRangeRadius,
        // drawn around g_map.lockPos. Enemy exclusion circles come from g_map.enemies.
        if (g_route.found && g_route.wptCount >= 2) {
            d.hasRoute = true;
            d.drawPath = true;
            d.pathCount = std::min(g_route.wptCount, kMaxPathPoints);
            for (int i = 0; i < d.pathCount; ++i) d.path[i] = g_route.wpts[i];
            d.routeGoal = g_route.goalPos;
        } else {
            d.hasRoute = false;
            d.drawPath = false;
            d.pathCount = 0;
            d.routeGoal = {};
        }
        d.routePartial    = g_route.partial;
        d.routeTempGoal   = g_route.tempGoal;
        d.routeExpanded   = g_route.expanded;
        d.routeOutOfRange = g_route.outOfRange;
        d.routeGoalDist   = g_route.goalDist;
        d.inRangeRadius = goal.fromLock ? goal.maxRange : 0.f;
        for (int i = 0; i < kCandidateCount; ++i) d.candidates[i] = CandidateDebug{};
        // FINDING G-2: CandidateDebug::softCost has always documented "pending-zone
        // penetration sum (tiles)" and was never written by anything — the overlay
        // read a hardcoded 0 and so reported "clear of every telegraph" while the
        // player stood in the middle of one. Fill the two slots that carry meaning
        // for this solver (its real candidate set is 131 wide, not kCandidateCount):
        // the STAND, and the target actually chosen.
        d.standPending  = Core::PendingZoneCost(in, in.player);
        d.targetPending = g_solve.pendingCost;
        d.candidates[kStandCandidate].softCost = d.standPending;
        d.candidates[kStandCandidate].dir      = {};
        if (kCandidateCount > 1) {
            d.candidates[1].softCost = d.targetPending;
            d.candidates[1].dir      = g_solve.shouldMove
                ? Normalize(Sub(g_solve.target, in.player)) : Vec2{};
            d.candidates[1].valid    = g_solve.shouldMove;
        }
        d.map = g_map;
        // Weight heatmap + navigation overlay.
        d.drawWeights = settings.debugWeights;
        d.hitScale    = settings.hitScale;
        d.safeWalk    = settings.safeWalk;
        // Overlay the CACHED route (what we're actually following), not the worker's
        // (which is only fresh on a re-plan tick and otherwise empty now).
        d.navActive   = walkActive;
        d.navGoal     = { walkX, walkY };
        d.navStepTarget = navStep;
        d.navPartial  = g_navCache.partial;
        if (walkActive && g_navCache.valid && g_navCache.n >= 2) {
            d.navWptCount = std::min(g_navCache.n, kMaxNavWpts);
            for (int i = 0; i < d.navWptCount; ++i) d.navWpts[i] = g_navCache.wpts[i];
        } else {
            d.navWptCount = 0;
        }
        PublishDebug(d);
    }

    // ── Last-resort signal for AutoNexus (plan 77) ───────────────────────────
    // "Exposed" = the solve gave up (Fallback/Surrounded) AND the stand is
    // actually covered (clearance ≤ latency pad) — the reachable disk is fully
    // dangerous, exactly when the nexus is the correct backstop. Safe/Hold mean
    // udodge placed or kept the player on a provably-safe cell, so the nexus must
    // NOT fire on udodge's own transient re-steer.
    const bool udExposed = (g_solve.kind == Solver::SolveKind::Fallback ||
                            g_solve.kind == Solver::SolveKind::Surrounded)
                           && standClr <= kULatencyPad;
    g_udStandClr.store(standClr, std::memory_order_relaxed);
    g_udExposed.store(udExposed, std::memory_order_relaxed);
    g_udSolveKind.store(static_cast<uint8_t>(g_solve.kind), std::memory_order_relaxed);
    // Committed move velocity (tiles/ms) = unit(target − player) × speed, or 0 when
    // holding. AutoNexus predicts the player along this so it only fires when the
    // dodge udodge is taking STILL leads to a hit (a genuine failure).
    float udMvx = 0.f, udMvy = 0.f;
    if (g_solve.shouldMove) {
        const float dx = g_solve.target.x - in.player.x;
        const float dy = g_solve.target.y - in.player.y;
        const float d  = std::sqrt(dx * dx + dy * dy);
        if (d > 1e-4f) { udMvx = (dx / d) * in.speed; udMvy = (dy / d) * in.speed; }
    }
    g_udMoveVx.store(udMvx, std::memory_order_relaxed);
    g_udMoveVy.store(udMvy, std::memory_order_relaxed);
    g_udSafetyTick.fetch_add(1, std::memory_order_relaxed);

    // ── Decision telemetry (UDodgeTelemetry.h) ───────────────────────────────
    // Observation only, after every decision and command of this frame. With
    // diagnostics off this is one branch and nothing inside it runs.
    if (diagOn) {
        namespace T = Telemetry;
        T::Sample t{};
        t.nowMs = GetTickCount64();
        t.dodgeMode = static_cast<int>(TestTAB::GetDodgeMode());
        t.ruleGame = collisionRule == Movement::Collision::Rule::Game;
        t.navigatorDstar = Movement::Nav::Runtime::Enabled();
        t.corridorState = static_cast<uint8_t>(corridor.state);
        t.mapPending = corridor.capturePending;
        // Item 3: dstar selected, capture stuck pending past kMapFallbackMs.
        // The walk-to is already running the legacy path underneath (the
        // waypoint-substitution block a few hundred lines below is skipped
        // whenever capturePending is set) — this only makes that visible.
        t.navFallback = t.navigatorDstar && corridor.capturePending &&
                        corridor.captureDiag.pendingMs >= T::kMapFallbackMs;
        t.globalAssist = g_globalAssistance;
        t.player = in.player;
        if (wasdActive) {
            t.objective = T::Objective::Steer;
        } else if (lockApproach) {
            t.objective = T::Objective::LockApproach;
            t.targetId = g_map.lockId;  t.target = g_map.lockPos;  t.hasTarget = true;
        } else if (walkActive) {
            // A commanded walk goal (script, Shift+Click or minimap) or, with none
            // set, the follow-player standoff point. g_globalRawGoal is the goal
            // before the global corridor substituted its waypoint.
            float wx = 0.f, wy = 0.f; bool commanded = false;
            DangerPlanner::GetWalkGoal(wx, wy, commanded);
            t.objective = commanded ? T::Objective::WalkTo : T::Objective::Follow;
            t.targetId = commanded ? 0 : followId;
            t.target = g_globalRawGoal;  t.hasTarget = true;
        } else if (g_map.hasLock) {
            t.objective = T::Objective::Lock;
            t.targetId = g_map.lockId;  t.target = g_map.lockPos;  t.hasTarget = true;
        }
        if (g_map.hasLock && (t.objective == T::Objective::Lock || t.objective == T::Objective::LockApproach)) {
            const LockGeometry lg = ComputeLockGeometry(settings, g_map.lockBand);
            t.ringInner = lg.innerStandoff;
            t.ringOuter = lg.engagementRange;
        }
        t.goalActive = goal.active;
        t.goal = goal.pos;
        t.navRoute = !walkActive ? T::NavRoute::None : navWaiting ? T::NavRoute::Waiting
                   : g_navCache.valid ? T::NavRoute::Cached : T::NavRoute::Direct;
        t.navWpts = g_navCache.valid ? g_navCache.n : 0;
        t.navPartial = g_navCache.valid && g_navCache.partial;
        t.navRouteDelivered = navCacheRefreshed;
        // Item 1 S4: route_id/rejoin/replan_reason are computed unconditionally
        // above (they gate real navReplan behaviour, not just this log), so
        // diagnostics-off vs on stays identical apart from the log line itself.
        t.routeId = g_navCache.valid ? g_routeId : 0;
        t.rejoin = navRejoin;
        t.replanReason = navReplanReason;
        const bool routeFresh = g_route.forSeq != 0 && g_lastPubSeq >= g_route.forSeq &&
                                (g_lastPubSeq - g_route.forSeq) <= kUPlanMaxStaleSeq;
        t.ringApproach = ringApproach;
        t.plan = (!g_route.found && !g_route.startIsGoal) ? T::Plan::None
               : !routeFresh          ? T::Plan::Stale
               : g_route.startIsGoal  ? T::Plan::StartIsGoal
               : g_route.partial      ? T::Plan::Partial
               : g_route.ringGoal     ? (g_route.tempGoal ? T::Plan::RingTemporal : T::Plan::RingRoute)
               : g_route.tempGoal     ? T::Plan::TemporalGoal : T::Plan::Route;
        t.planGoalValid = g_route.found;
        t.planGoal = g_route.goalPos;
        t.solve = !g_solve.shouldMove
                ? (g_solve.kind == Solver::SolveKind::Surrounded ? T::Solve::Surrounded
                   : g_solve.timedEscape ? T::Solve::TimedWait : T::Solve::Hold)
                : g_solve.kind == Solver::SolveKind::Fallback ? T::Solve::Fallback
                : g_solve.timedEscape  ? T::Solve::Timed
                : g_solve.prePosition  ? (g_solve.followedRoute ? T::Solve::DodgeRoute : T::Solve::Lateral)
                : g_solve.followedRoute ? (ringRoute ? T::Solve::RingRoute : T::Solve::NavRoute)
                : T::Solve::Solver;
        const bool adopted = g_solveSeq != g_telemetryWorker.seenSolveSeq;
        g_telemetryWorker.seenSolveSeq = g_solveSeq;
        t.source = reflexVeto ? T::Source::ReflexVeto
                 : (navHandoff.solve || groupChanged) ? T::Source::Live
                 : adopted ? T::Source::Worker : T::Source::Cached;
        t.drive = !g_solve.shouldMove ? T::Drive::None
                : !enemyDriveClear ? T::Drive::BlockedEnemy
                : !drivePathClear  ? T::Drive::BlockedPath
                : moveFailed       ? T::Drive::Refused : T::Drive::Ok;
        t.clearance = g_solve.clearance;
        t.commanded = Sub(moveTarget, in.player);
        t.lanes = g_map.laneCount;  t.zones = g_map.zoneCount;  t.enemies = g_map.enemyCount;
        // ENEMY STANDOFF telemetry: one pass over the enemy list, flag-gated with
        // the rest of the heartbeat, so it costs nothing in a normal session.
        t.nearEnemy = -1.f;
        t.inBand = false;
        for (int i = 0; i < g_map.enemyCount; ++i) {
            const EnemyBlocker& e = g_map.enemies[i];
            const float d = Len(Sub(in.player, e.pos));
            if (t.nearEnemy < 0.f || d < t.nearEnemy) t.nearEnemy = d;
            if (e.standoffBand > 0.f && d < e.standoffBand) t.inBand = true;
        }
        t.workerDodgeMs = g_telemetryWorker.dodgeMs;  t.workerNavMs = g_telemetryWorker.navMs;
        t.workerTimedMs = g_telemetryWorker.timedMs;  t.workerSolveMs = g_telemetryWorker.solveMs;
        t.timedStatus = g_telemetryWorker.timedStatus;
        t.timedReused = g_telemetryWorker.timedReused;
        t.timedBudgetHit = g_telemetryWorker.timedBudgetHit;
        const int groundTileX = static_cast<int>(std::floor(px));
        const int groundTileY = static_cast<int>(std::floor(py));
        const int groundDmg = WorldTAB::GetTileDamageLive(groundTileX, groundTileY);
        t.onHazard = groundDmg > 0;
        T::Emit(g_telemetry, t, &DbgFileLogWrite);

        // [Diag/Map]: Item 3 observability — which guard is holding capture,
        // tiles read, list pointer/count/epoch, ms pending, and the
        // transition to ready with the reason. Only while dstar is selected;
        // corridor.captureDiag is always-filled plain data (Runtime.cpp), so
        // this is purely a formatting + logging cost, gated the same as
        // every other line in this block.
        if (t.navigatorDstar)
            MapDiag::Step(g_mapDiag, corridor.captureDiag, t.nowMs, &DbgFileLogWrite);

        // [Diag/Ground]: edge-triggered damaging-ground steps (UDodgePredErr.h).
        // Reuses this frame's own telemetry sample for the decision fields —
        // no separate recomputation.
        PredErr::GroundDiag::Step(g_groundDiag, groundTileX, groundTileY, groundDmg,
                                  Sensors::IsHazardAt(px, py), settings.safeWalk,
                                  WorldTAB::IsLiveHazardActive(), T::Name(t.solve), T::Name(t.source),
                                  T::Name(t.objective), t.nowMs, &DbgFileLogWrite);
    }

    // The per-phase breakdown is emitted every 2 s by the update detour
    // (DangerPlanner.cpp DiagAfterUpdate) together with the whole-frame numbers.
}

void RenderSettings()
{
    // Only the controls that still drive the per-tick solver remain (plan 64):
    // the reactive engine's step distance / plan-window radius / draw-path /
    // lock-follow / field-escape controls were retired. NO new settings.
    float hit  = GetHitScale();
    bool  safe = GetSafeWalk();
    bool  dbg  = GetDebugOverlay();

    float lane = GetLaneTiles();
    if (ImGui::SliderFloat("Danger lane length (tiles)##udodge", &lane, 2.f, 16.f)) SetLaneTiles(lane);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How far ahead of each bullet its danger lane is painted.\n"
                          "Longer = react earlier to distant shots; shorter = only\n"
                          "dodge nearby bullets.");
    if (ImGui::SliderFloat("Hit scale##udodge", &hit, 0.5f, 1.5f)) SetHitScale(hit);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Scales the bullet hit half-extent in the safety test.\n"
                          "The player half-extent + latency pad are always included.");
    if (ImGui::Checkbox("Safe walk (avoid damaging ground)##udodge", &safe)) SetSafeWalk(safe);
    if (ImGui::Checkbox("Debug overlay##udodge", &dbg)) SetDebugOverlay(dbg);
    bool wts = GetDebugWeights();
    if (ImGui::Checkbox("Pathfinder weight grid##udodge", &wts)) SetDebugWeights(wts);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Color-code the cells the pathfinder can see by safety weight\n"
                          "(green = safe, yellow = marginal, red = inside a shot, dark = wall)\n"
                          "and draw the walk-to A* corridor + its search window. Debug view.");
    bool diagT = GetDiagTiming();
    if (ImGui::Checkbox("Diag timing##udodge", &diagT)) SetDiagTiming(diagT);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Per-phase perf timing (QueryPerformanceCounter probes in Tick,\n"
                          "logged every 120 ticks). Developer diagnostic — default OFF so\n"
                          "shipped play pays nothing. Only meaningful in a Release build.");

    float orbit = GetOrbitRange();
    if (ImGui::SliderFloat("Orbit range (tiles, 0 = auto)##udodge", &orbit, 0.f, 16.f)) SetOrbitRange(orbit);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Boss lock standoff distance. 0 = auto (resolved weapon\n"
                          "range x 0.85). Consumed only as a soft goal over safe points.");

    bool autopilot = GetAutopilot();
    if (ImGui::Checkbox("Autopilot: auto-lock highest-HP enemy##udodge", &autopilot)) SetAutopilot(autopilot);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Each tick, auto-select the highest-max-HP targetable/damageable\n"
                          "enemy as the lock so the orbit/in-range fight engages automatically.\n"
                          "Off = only a manual Shift+Click lock fights.");

    bool followLantern = GetFollowLantern();
    if (ImGui::Checkbox("Autopilot: follow stand-on object (perf cost)##udodge", &followLantern)) SetFollowLantern(followLantern);
    int standOn = GetStandOnType();
    if (ImGui::InputInt("Autopilot stand-on objType (0=off)##udodge", &standOn)) SetStandOnType(standOn);
}

void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!IsEnabled() || !GetDebugOverlay()) return;
    // large — keep off the render-thread stack; heap-backed for the same reason as DebugSlot()
    static DebugSnapshot* const snap = new DebugSnapshot();
    { std::lock_guard<std::mutex> lock(g_debugMutex); *snap = DebugSlot(); }
    Debug::Render(*snap, camX, camY, angle, zoom, cx, cy);
}

void  SetLaneTiles(float t) { g_laneTiles.store(Clamp(t, 2.f, 16.f), std::memory_order_relaxed); }
float GetLaneTiles()        { return g_laneTiles.load(std::memory_order_relaxed); }
void  SetStepTiles(float t) { g_stepTiles.store(t <= 0.f ? 0.f : Clamp(t, 0.4f, 3.f), std::memory_order_relaxed); }
float GetStepTiles()        { return g_stepTiles.load(std::memory_order_relaxed); }
void  SetHitScale(float s) { g_hitScale.store(Clamp(s, 0.25f, 2.5f), std::memory_order_relaxed); }
void  SetPlannerPolicy(const char* text)
{
    g_planner.store(static_cast<uint8_t>(Contact::PolicyFromText(text)), std::memory_order_relaxed);
}
Contact::Policy GetPlannerPolicy()
{
    return static_cast<Contact::Policy>(g_planner.load(std::memory_order_relaxed));
}
// udodgeRouteCommit: "off" = the pre-Item-1 follower (plain 5-tile deviation
// threshold, no objective-changed trigger, no lattice snap under Classic);
// anything else (default) = route commitment on.
void SetRouteCommit(const char* text)
{
    g_routeCommit.store(!(text && text[0] == 'o' && text[1] == 'f'), std::memory_order_relaxed);
}
bool GetRouteCommit() { return g_routeCommit.load(std::memory_order_relaxed); }
void  SetEnemyStandoff(const char* text)
{
    g_enemyStandoff.store(static_cast<uint8_t>(Standoff::ModeFromText(text)), std::memory_order_relaxed);
}
Standoff::Mode GetEnemyStandoff()
{
    return static_cast<Standoff::Mode>(g_enemyStandoff.load(std::memory_order_relaxed));
}
// Game thread: whatever the last map build read (UDodgeSensors BuildMap, S3.3).
float GetLiveHitboxMultiplier() { return g_map.targetScale; }
bool  GetLiveHitboxTrusted()    { return g_map.colliderTrusted; }
float GetHitScale() { return g_hitScale.load(std::memory_order_relaxed); }
void  SetReactMargin(float m) { g_reactMargin.store(Clamp(m, 0.05f, 2.0f), std::memory_order_relaxed); }
float GetReactMargin() { return g_reactMargin.load(std::memory_order_relaxed); }
void  SetSafeWalk(bool en) { g_safeWalk.store(en, std::memory_order_relaxed); }
bool  GetSafeWalk() { return g_safeWalk.load(std::memory_order_relaxed); }
void  SetSpeedScale(bool en) { g_speedScale.store(en, std::memory_order_relaxed); }
bool  GetSpeedScale() { return g_speedScale.load(std::memory_order_relaxed); }
void  SetFieldEscape(bool en) { g_fieldEscape.store(en, std::memory_order_relaxed); }
bool  GetFieldEscape() { return g_fieldEscape.load(std::memory_order_relaxed); }
void  SetDebugOverlay(bool en) { g_debugOverlay.store(en, std::memory_order_relaxed); }
bool  GetDebugOverlay() { return g_debugOverlay.load(std::memory_order_relaxed); }
void  SetDebugWeights(bool en) { g_debugWeights.store(en, std::memory_order_relaxed); }
bool  GetDebugWeights() { return g_debugWeights.load(std::memory_order_relaxed); }
void  SetDiagTiming(bool en) { g_diagTiming.store(en, std::memory_order_relaxed); DiagTiming::SetForced(en); }
bool  GetDiagTiming() { return DiagTiming::On(); }
void  SetLockFollow(bool en) { g_lockFollow.store(en, std::memory_order_relaxed); }
bool  GetLockFollow() { return g_lockFollow.load(std::memory_order_relaxed); }
void  SetFollowLantern(bool en) { g_followLantern.store(en, std::memory_order_relaxed); }
bool  GetFollowLantern() { return g_followLantern.load(std::memory_order_relaxed); }
void  SetAutopilot(bool en) { g_autopilot.store(en, std::memory_order_relaxed); }
bool  GetAutopilot() { return g_autopilot.load(std::memory_order_relaxed); }
void  SetStandOnType(int t) { g_standOnType.store(t, std::memory_order_relaxed); }
int   GetStandOnType() { return g_standOnType.load(std::memory_order_relaxed); }
void  SetOrbitRange(float t) { g_orbitRange.store(t <= 0.f ? 0.f : Clamp(t, 2.f, 16.f), std::memory_order_relaxed); }
float GetOrbitRange() { return g_orbitRange.load(std::memory_order_relaxed); }
void  SetPlanRadius(float cells) { g_planRadius.store(Clamp(cells, 8.f, 40.f), std::memory_order_relaxed); }
float GetPlanRadius() { return g_planRadius.load(std::memory_order_relaxed); }
void  SetDrawPath(bool en) { g_drawPath.store(en, std::memory_order_relaxed); }
bool  GetDrawPath() { return g_drawPath.load(std::memory_order_relaxed); }
void  SetMoveEnvelope(bool en) { g_moveEnvelope.store(en, std::memory_order_relaxed); }
bool  GetMoveEnvelope() { return g_moveEnvelope.load(std::memory_order_relaxed); }
void  SetMoveEnvelopeArmed(bool armed) {
    g_moveEnvelopeArmed.store(armed, std::memory_order_release);
    if (!armed) g_serverPositionError.store(0.f, std::memory_order_relaxed);
}
void  SetServerPositionError(float tiles) {
    g_serverPositionError.store(Clamp(tiles, 0.f, 0.35f), std::memory_order_relaxed);
}
void  SetServerAnchorX(float x) { if (std::isfinite(x)) g_serverAnchorX.store(x, std::memory_order_relaxed); }
void  SetServerAnchorY(float y) { if (std::isfinite(y)) g_serverAnchorY.store(y, std::memory_order_relaxed); }
void  SetServerAnchorValid(bool valid) { g_serverAnchorValid.store(valid, std::memory_order_release); }
void  SetFallbackSidestep(bool en) { g_fallbackSidestep.store(en, std::memory_order_relaxed); }
bool  GetFallbackSidestep() { return g_fallbackSidestep.load(std::memory_order_relaxed); }
// udodgeFrameBudget: "off" = no ceiling, ever; anything else (default) = auto.
void  SetFrameBudget(const char* text)
{
    g_frameBudgetAuto.store(!(text && text[0] == 'o' && text[1] == 'f'), std::memory_order_relaxed);
}
bool  GetFrameBudgetAuto() { return g_frameBudgetAuto.load(std::memory_order_relaxed); }

} // namespace UDodge
