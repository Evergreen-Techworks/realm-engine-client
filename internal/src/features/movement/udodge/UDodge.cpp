#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgePathfinder.h"
#include "UDodgeNavigation.h"
#include "UDodgeWorker.h"
#include "UDodgeSensors.h"
#include "UDodgeDebug.h"

#include "MovementRuntime.h"
#include "DbgFileLog.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "DangerPlanner.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/CameraTAB.h"

#include <imgui/imgui.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <windows.h>

namespace UDodge {
namespace {

std::atomic<bool>  g_enabled{ false };
std::atomic<float> g_laneTiles{ 12.f };
std::atomic<float> g_stepTiles{ 0.f };
std::atomic<float> g_hitScale{ 1.0f };
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
};
NavCache g_navCache;
Navigation::Progress g_navProgress;
bool g_navAwaiting = false;
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

// ── Per-phase perf instrumentation (diagnostics only) ────────────────────────
// Accumulates wall-clock into a named bucket; LogPhasesEvery120() logs all
// buckets every 120 ticks (matches the existing throttle so log volume is
// unchanged). Game-thread only: static accumulators, no synchronization.
// Compiled in all configs but effectively free when the phase is small. NOTE:
// these numbers are only meaningful in a RELEASE build — Debug overhead inflates
// every phase and makes the breakdown non-representative of ship cost.
struct PhaseAccum { double sum = 0.0, max = 0.0; };
PhaseAccum g_tSync, g_tRaster, g_tPublish, g_tSolve, g_tDebug, g_tTotal;

class PhaseTimer {           // RAII: start in ctor, stop+accumulate in dtor
    LARGE_INTEGER t0;
    PhaseAccum&   bucket;
    bool          armed;     // false when diag timing is off — records nothing
public:
    explicit PhaseTimer(PhaseAccum& b)
        : bucket(b), armed(g_diagTiming.load(std::memory_order_relaxed))
    {
        if (armed) QueryPerformanceCounter(&t0);   // skip the probe when off
    }
    ~PhaseTimer() {
        if (!armed) return;
        LARGE_INTEGER t1, f; QueryPerformanceCounter(&t1); QueryPerformanceFrequency(&f);
        const double ms = double(t1.QuadPart - t0.QuadPart) * 1000.0 / double(f.QuadPart);
        bucket.sum += ms; if (ms > bucket.max) bucket.max = ms;
    }
};

// Every 120th call, emit ONE line with avg+max for each bucket, then reset.
void LogPhasesEvery120()
{
    if (!g_diagTiming.load(std::memory_order_relaxed)) return;   // gated: no timing → no log
    static int s_n = 0;
    if (++s_n < 120) return;
    const double inv = 1.0 / double(s_n);
    DBG_FILE_LOG("[UDodge] phase avg/max ms"
        << " sync=" << (g_tSync.sum * inv) << "/" << g_tSync.max
        << " raster=" << (g_tRaster.sum * inv) << "/" << g_tRaster.max
        << " publish=" << (g_tPublish.sum * inv) << "/" << g_tPublish.max
        << " solve=" << (g_tSolve.sum * inv) << "/" << g_tSolve.max
        << " debug=" << (g_tDebug.sum * inv) << "/" << g_tDebug.max
        << " total=" << (g_tTotal.sum * inv) << "/" << g_tTotal.max);
    g_tSync = g_tRaster = g_tPublish = g_tSolve = g_tDebug = g_tTotal = PhaseAccum{};
    s_n = 0;
}

Settings ReadSettings()
{
    Settings s{};
    s.laneTiles    = Clamp(g_laneTiles.load(std::memory_order_relaxed), 2.f, 16.f);
    const float stepT = g_stepTiles.load(std::memory_order_relaxed);
    s.stepTiles    = stepT <= 0.f ? 0.f : Clamp(stepT, 0.4f, 3.f);
    s.hitScale     = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.25f, 2.5f);
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
void FillOccGrid(Path::OccGrid& grid, Vec2 player, bool rebuildWalls)
{
    grid.center = player;
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
            }
        }
    }
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
void FillNavGrid(Path::NavGrid& grid, Vec2 player, bool safeWalk)
{
    // Stable tile centres preserve clearance in one-tile corridors; a grid
    // anchored to the player's fractional position can put every cell on a wall edge.
    grid.center = {std::floor(player.x) + 0.5f, std::floor(player.y) + 0.5f};
    const float originX = grid.center.x - static_cast<float>(kUNavRadCells) * kUNavCellTiles;
    const float originY = grid.center.y - static_cast<float>(kUNavRadCells) * kUNavCellTiles;
    WorldTAB::CopyBoxBlocked(originX, originY, kUNavSide, kUNavCellTiles,
                             kUOccPlayerHalfEdge + Navigation::kWallPadding, /*foldHazard=*/safeWalk, grid.flags);
    for (int i = 0; i < kUNavCells; ++i)
        if (grid.flags[i] & 0x8) grid.flags[i] |= 0x1; // never A* into blank map void
}

// Follow the cached nav route: project the player onto the polyline, then place the
// steering target `lookahead` tiles further along it. Reports the player's distance
// FROM the route (deviation) and whether they've reached its end — the re-plan
// triggers. Returns the raw player position when there is no usable cached route.
Vec2 NavStepFromCache(const NavCache& c, Vec2 player, float lookahead,
                      float& outDev, bool& outNearEnd, const MapInput& in)
{
    outDev = 0.f; outNearEnd = false;
    if (!c.valid || c.n < 2) return player;

    return Navigation::Follow(c.wpts, c.n, player, lookahead, outDev, outNearEnd,
        [&](Vec2 from, Vec2 to) { return Navigation::PaddedPathClear(in, from, to); });
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
        if (e.hp <= 0) continue;         // dead / despawning
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
    }
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        Worker::Stop();                  // JOIN the worker before releasing state it never touches
        UpdateAutopilotLock(false);      // release any autopilot-owned enemy lock (never a manual one)
        DangerPlanner::ClearWalkGoal();  // drop any pending walk-to spot
        g_commitment.Reset();
        g_solve = Solver::SolveResult{};
        g_route = Path::PlanResult{};
        g_lastPubSeq = 0;
        g_solveSeq = 0;
        // Clear the AutoNexus last-resort signal (plan 77): udodge is no longer
        // handling anything, so it must not report itself as covering the player.
        g_udExposed.store(false, std::memory_order_relaxed);
        g_udStandClr.store(1e9f, std::memory_order_relaxed);
        g_udMoveVx.store(0.f, std::memory_order_relaxed);
        g_udMoveVy.store(0.f, std::memory_order_relaxed);
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

void OnEnter()
{
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
    g_navAwaiting = false;
    g_navProgress.Reset();
    g_trailCount = 0;
    for (Vec2& p : g_trail) p = {};
    // Every one of these stores world coordinates/object ids and is therefore
    // location-scoped. Never carry a click/follow/lock waypoint across a realm.
    DangerPlanner::ClearWalkGoal();
    DangerPlanner::ClearFollowPlayer();
    DangerPlanner::ClearEnemyLock();
    g_lastPubSeq = 0;
    g_solveSeq = 0;
    // Reset the AutoNexus last-resort signal (plan 77) on (re)entry.
    g_udExposed.store(false, std::memory_order_relaxed);
    g_udStandClr.store(1e9f, std::memory_order_relaxed);
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) return;
    if (!DodgeRuntime::EnsureResolved()) return;

    // ── Perf probe: measure the full UDodge::Tick cost on the game thread. RAII
    // so it captures every return path (records total even on early return); the
    // per-phase breakdown is emitted by LogPhasesEvery120() at the end of Tick.
    PhaseTimer total(g_tTotal);

    const Settings settings = ReadSettings();
    const SteerInput::SteerState steer = SteerInput::Get();

    // Autopilot auto-lock — pick the highest-maxHp targetable enemy as the enemy
    // lock (or release the auto-lock when off). Runs BEFORE the map build so the
    // fresh lock is reflected in g_map.hasLock/lockPos this same tick.
    UpdateAutopilotLock(settings.autopilot);

    int32_t hp = 0, maxHp = 0;
    float spd = 0.f, tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);

    // ── NewTick sync ─────────────────────────────────────────────────────
    // The map LAYOUT is rebuilt from authoritative game state every server
    // tick (WM_TickId change). Between ticks, lanes are re-anchored to the
    // game's own live projectile positions (never extrapolated by our
    // clock). A structural change (projectile spawned/retired mid-tick)
    // forces an immediate rebuild so a new shot is visible the same frame.
    // If the tick counter is unreadable (stale offsets), rebuild every
    // frame — the fail-safe direction is fresher, never staler.
    // tick / tickOk / rebuilt are consumed later in Tick, so they are declared
    // outside the timed scope; the g_tSync scope wraps only the actual map-sync
    // work (ReadWorldTick / ReanchorMap / BuildMap).
    uint32_t tick = 0;
    bool tickOk = false;
    bool rebuilt = false;
    {
        PhaseTimer _p(g_tSync);
        tickOk = Sensors::ReadWorldTick(tick);
        bool synced = false;
        if (tickOk && g_map.tickValid && g_map.tickId == tick)
            synced = Sensors::ReanchorMap(g_map, px, py, settings);
        rebuilt = !synced;
        if (rebuilt) {
            Sensors::BuildMap(g_map, px, py, settings);
            g_map.tickId = tick;
            g_map.tickValid = tickOk;
        }
    }
    if (g_map.projectileSourceUnavailable) {
        g_commitment.Reset();
        PublishMinimal(Decision::None, { px, py });
        return;
    }

    MapInput in{};
    in.player = { px, py };

    in.speed = std::max(0.f, std::isfinite(tilesPerSec) ? tilesPerSec : 0.f) / 1000.f;
    in.stepTiles = settings.stepTiles > 0.f
        ? settings.stepTiles
        : std::clamp(std::max(0.f, tilesPerSec) * kServerTickSec, 0.f, 3.0f);
    in.tickId = g_map.tickId;
    in.movementLocked = in.speed <= 0.f;
    in.playerOnHazard = settings.safeWalk && Sensors::IsHazardAt(px, py);
    in.settings = settings;
    in.env.canOccupy = &Sensors::CanOccupy;
    in.env.isHazard = &Sensors::IsHazardAt;
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

    // ── Nav re-plan decision (walk-to route caching) ─────────────────────────
    // Follow the cached route and only re-run the A* on a real trigger. navStep is
    // the steering target ~lookahead budgets ahead along the cached polyline.
    bool navReplan = false;
    bool navWaiting = g_navAwaiting;
    Vec2 navStep{ walkX, walkY };
    if (walkActive) {
        const Vec2  wg{ walkX, walkY };
        const float lookahead = std::max(b, 1.f) * kUNavLookaheadBudgets;
        float dev = 0.f; bool nearEnd = false;
        navStep = NavStepFromCache(g_navCache, in.player, lookahead, dev, nearEnd, in);
        const bool goalMoved = g_navCache.valid &&
            LenSq(Sub(wg, g_navCache.goal)) > kNavGoalMoveTiles * kNavGoalMoveTiles;
        // Never take even one more step along the previous waypoint's corridor.
        // It may point directly behind the player after a quest/portal handoff.
        if (goalMoved) {
            g_navCache.valid = false;
            g_navAwaiting = navWaiting = false;
            navStep = wg;
        }
        navReplan = !g_navCache.valid
            || dev > kNavDeviateTiles                                                   // pushed off the route
            || (nearEnd && g_navCache.partial)                                          // consumed a partial route → extend
            || (nearEnd && LenSq(Sub(in.player, wg)) > kNavEndTiles * kNavEndTiles);    // at route end but not the goal

        // Blocked corridor: replan immediately. Small alternating nudges do
        // not count as progress; real movement around a wall does, even when
        // temporarily moving away from the final destination.
        const ULONGLONG nowNav = GetTickCount64();
        if (goalMoved) g_navProgress.Reset();
        const bool blocked = g_navCache.valid && !Navigation::PaddedPathClear(in, in.player, navStep);
        const bool stalled = in.speed > 0.f && g_navProgress.Stalled(in.player, nowNav);
        if (blocked || stalled) {
            navReplan = true;
            g_navAwaiting = navWaiting = true;
            g_navCache.valid = false;
            navStep = in.player;
        }
        g_wedged.store(blocked || stalled, std::memory_order_relaxed);
        // Plan 89: publish the wedge observation (goal, player, freshness stamp).
        g_wedgeWalkActive.store(true, std::memory_order_relaxed);
        g_wedgeGoalX.store(wg.x, std::memory_order_relaxed);
        g_wedgeGoalY.store(wg.y, std::memory_order_relaxed);
        g_wedgePlayerX.store(in.player.x, std::memory_order_relaxed);
        g_wedgePlayerY.store(in.player.y, std::memory_order_relaxed);
        g_wedgeStampMs.store(static_cast<uint32_t>(nowNav), std::memory_order_relaxed);
        if (navWaiting) navStep = in.player;
        else if (!g_navCache.valid) navStep = wg;   // no cache yet → head to the raw goal until the first plan lands
    } else {
        g_navProgress.Reset();
        g_navAwaiting = false;
        g_navCache.valid = false;              // walk-to ended → drop the cache
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
        // Orbit the locked enemy at a standoff = resolved weapon range × 0.85
        // (the SetOrbitRange override feeds the standoff directly when non-zero).
        const float weaponRange = AutoAim::IsProjRangeResolved()
            ? AutoAim::GetProjRangeTiles() : 6.f;
        // Inner-standoff annulus radius: keep the player at least this far from the
        // boss so it never fights point-blank. Fraction of weapon range (scales
        // across classes) with an absolute tile floor.
        const float innerStandoff = std::max(kUInnerStandoffMinTiles,
                                             weaponRange * kUInnerStandoffFrac);
        const float engagementRange = std::max(innerStandoff + kUDurablePocketMargin,
                                               weaponRange - kUEngagementRangeInset);
        // The orbit standoff POINT must sit inside the annulus [innerStandoff,
        // weaponRange], so clamp it above the inner radius (with a small margin)
        // and never past weapon range — the soft goal never aims point-blank.
        float standoff = settings.orbitRange > 0.f
            ? settings.orbitRange : weaponRange * 0.85f;
        standoff = std::clamp(standoff, innerStandoff + kUDurablePocketMargin,
                              engagementRange);
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
        const Vec2 gridCenter   = lockedCenter ? goal.lockPos : in.player;
        {
            PhaseTimer _p(g_tRaster);
            FillOccGrid(s_snap.grid, gridCenter, true);
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
        s_snap.settings         = settings;
        s_snap.goalActive       = goal.active;
        s_snap.goalPos          = goal.pos;
        s_snap.goalWalkTo       = goal.walkTo;
        s_snap.playerOnHazard   = in.playerOnHazard;
        s_snap.hasLock          = goal.fromLock;
        s_snap.lockPos          = goal.lockPos;
        s_snap.weaponRangeTiles = goal.fromLock ? goal.maxRange : 0.f;
        s_snap.innerStandoffTiles = goal.fromLock ? goal.innerStandoff : 0.f;
        // Plan-commitment hysteresis (plan 76): carry the last accepted route goal
        // into the snapshot so the worker Dijkstra prefers it among near-equal
        // options. g_route still holds the PREVIOUS tick's route here (it is refreshed
        // below, after this publish block), so this is exactly last tick's committed goal.
        s_snap.prevGoalValid    = g_route.found;
        s_snap.prevGoalPos      = g_route.goalPos;
        s_snap.retreatValid     = retreatValid;
        s_snap.retreatPos       = retreatPos;
        s_snap.map              = g_map;    // plain-data danger copy (lanes/zones/enemies)
        // Navigation (walk-to): only ask the worker to (re)plan — and only pay the
        // large nav-grid rasterize — when a re-plan is actually triggered (navReplan).
        // Between re-plans we FOLLOW the cached route, so the walk-to costs nothing
        // here on most ticks. This is the walk-to perf win.
        s_snap.navActive        = walkActive && navReplan;
        s_snap.navGoal          = { walkX, walkY };
        if (s_snap.navActive) {
            PhaseTimer _p(g_tRaster);
            FillNavGrid(s_snap.navGrid, in.player, settings.safeWalk);
        }
        uint32_t pub = 0;
        {
            PhaseTimer _p(g_tPublish);
            pub = Worker::PublishSnapshot(s_snap);
        }
        if (pub) g_lastPubSeq = pub;
        if (tickOk) s_lastPubTick = tick;
    }

    // Refresh the cached route when the worker isn't busy (non-blocking — keeps the
    // last route on contention / cold start).
    Worker::Result fresh{};
    bool rejectedFreshWalk = false;
    bool commitmentChanged = false;
    if (Worker::TryGetLatest(fresh)) {
        const bool seqFresh = fresh.plan.forSeq != 0 && g_lastPubSeq >= fresh.plan.forSeq
            && (g_lastPubSeq - fresh.plan.forSeq) <= kUPlanMaxStaleSeq;
        const bool walkMatches = fresh.walkActive == walkActive
            && (!walkActive || LenSq(Sub(fresh.walkGoal, Vec2{walkX, walkY})) <= 0.25f * 0.25f);
        const float maxOriginDrift = std::max(3.f, b * 2.f);
        const bool originFresh = LenSq(Sub(fresh.snapshotPlayer, in.player))
            <= maxOriginDrift * maxOriginDrift;
        const bool acceptFresh = seqFresh && walkMatches && originFresh;
        if (acceptFresh) {
            g_route = fresh.plan;
            if (g_commitment.Accepts(fresh.commitmentRevision)) {
                g_solve = fresh.solve;
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
        if (acceptFresh && g_route.navArrived) g_navAwaiting = false;
        if (acceptFresh && g_route.navFound && g_route.navWptCount >= 2) {
            g_navAwaiting = false;
            g_navCache.valid   = true;
            g_navCache.goal    = { walkX, walkY };
            g_navCache.n       = std::min(g_route.navWptCount, kMaxNavWpts);
            for (int i = 0; i < g_navCache.n; ++i) g_navCache.wpts[i] = g_route.navWpts[i];
            g_navCache.partial = g_route.navPartial;
        } else if (acceptFresh && g_route.navPops > 0 &&
                   g_route.navWptCount < 2 && !g_route.navArrived) {
            // DEADLOCK GUARD. The A* ran (navPops > 0) and came back with no usable
            // route — ComputeNav's `target == start` branch, i.e. nothing reachable
            // beat the player's own cell. The cache is (correctly) not updated with a
            // 1-point route, but leaving the OLD one valid is a trap: the player is
            // standing on its far end, so NavStepFromCache hands back that end point,
            // goal.pos lands within kUWalkArriveTiles of the player, the solver's
            // `repositionToward` goes false and it HOLDS (NO-MOVE kind=0). Holding
            // means the map never streams, so the next A* returns the same dead
            // result — a permanent stall that only broke when the walk goal itself
            // moved kNavGoalMoveTiles (for a committed quest target: minutes, or
            // never). Dropping the cache falls through to `navStep = wg` below,
            // steering straight at the raw goal exactly as on a cold start; moving
            // streams new map and the A* recovers on its own.
            g_navCache.valid = false;
        }
    }

    // Staleness gate: only feed the solver a route recent enough to trust as a
    // lookahead. Too stale (or cold) → an empty route → pure immediate dodge.
    Path::PlanResult routeForSolve{};
    if (g_route.found &&
        g_lastPubSeq >= g_route.forSeq &&
        (g_lastPubSeq - g_route.forSeq) <= kUPlanMaxStaleSeq) {
        routeForSolve = g_route;
    }

    // A cold/late worker must not stall navigation or leave an old absolute
    // target behind the player. The expensive grid search stays asynchronous;
    // this is only the small live safety solver, at server-tick cadence.
    if (navWaiting) routeForSolve = Path::PlanResult{};
    if (navWaiting || commitmentChanged ||
        (walkActive && tickChanged && (!g_navCache.valid || rejectedFreshWalk))) {
        PhaseTimer _p(g_tSolve);
        Solver::Solve(in, b, goal, routeForSolve, proposedState, g_solve);
    }

    // Normal temporal solving is performed with the path search on the worker.
    // The game thread keeps only the emergency same-frame re-solve below when a
    // live re-anchor invalidates the worker's already-published target.

    const float frameMs = Clamp(dt * 1000.f, 1.f, 250.f);
    Vec2 moveTarget = in.player;
    bool moveFailed = false;

    // Validate against this frame's map and replace unsafe decisions before
    // driving. A rebuild must not suppress the immediate solve while the worker
    // is still processing its snapshot.
    {
        PhaseTimer _p(g_tSolve);
        CoreState safetyState = g_commitment.state;
        if (Solver::RevalidateAndSolve(in, b, goal, routeForSolve, safetyState, g_solve, rebuilt))
            proposedState = safetyState;
    }

    // ── Drive toward the (possibly re-solved) target ─────────────────────────
    // Enemy bodies stay a hard no-go even after a re-solve; a target that is
    // enemy-blocked now is not driven (the next tick's fresh solve re-picks).
    const bool enemyDriveClear = (g_solve.kind == Solver::SolveKind::Fallback)
        ? !Core::EnemyBlocked(in, g_solve.target)                       // surround-escape: endpoint rule
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
        // Per-frame step, clamped to the player's speed; MoveTo clamps again
        // internally. Converges onto the target by the tick boundary without
        // ever exceeding the per-tick budget.
        moveTarget = Add(in.player, Mul(dir, std::min(d, in.speed * frameMs)));
        const bool ok = DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y);
        if (!ok) moveFailed = true;
        g_commitment.Record(proposedState, Sub(moveTarget, in.player), ok);
        static int s_mvN = 0;
        if ((s_mvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] MOVE kind=" << (int)g_solve.kind
                << (g_solve.inRangeDisk
                        ? (g_solve.outOfRange
                               ? (g_solve.prePosition ? " DISK-OOR-PREPOS" : " DISK-OOR")
                               : (g_solve.prePosition ? " INRANGE-PREPOS" : " INRANGE"))
                        : (g_solve.prePosition ? " PREPOS(temporal)" : " IMMED"))
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
                << " pocketDist=" << g_solve.pocketDist
                << " clr=" << g_solve.clearance);
    }

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
        PhaseTimer _p(g_tDebug);
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

    // Emit the per-phase breakdown once every 120 ticks (throttle matches the
    // other diagnostics). The `total` bucket is recorded by the RAII guard at
    // scope exit, so this frame's total folds into the next window — acceptable
    // for a diagnostic average.
    LogPhasesEvery120();
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
void  SetDiagTiming(bool en) { g_diagTiming.store(en, std::memory_order_relaxed); }
bool  GetDiagTiming() { return g_diagTiming.load(std::memory_order_relaxed); }
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

} // namespace UDodge
