#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
#include "UDodgeSolver.h"
#include "UDodgeSensors.h"
#include "UDodgeDebug.h"
#include "UDodgePlanner.h"
#include "UDodgeWorker.h"

#include "MovementRuntime.h"
#include "DbgFileLog.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "DangerPlanner.h"
#include "AutoAim.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"

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
std::atomic<bool>  g_lockFollow{ false };
std::atomic<bool>  g_followLantern{ false };
std::atomic<int>   g_standOnType{ 0 };
std::atomic<float> g_orbitRange{ 0.f };    // boss orbit standoff (tiles); 0 = auto
std::atomic<float> g_planRadius{ 20.f };   // planner window radius (grid cells) [8,40]
std::atomic<bool>  g_drawPath{ true };     // draw the plan-60 route overlay

// Game-update thread only.
CoreState  g_state;
DangerMap  g_map;
CoreOutput g_out;
// Per-tick safe-position solver result — game-thread-owned, cached for one
// server tick and re-validated (or re-solved) every frame (plan 64).
Solver::SolveResult g_solve;
// Last plan the worker handed back — game-thread-owned cache, kept across frames
// when TryGetLatestPlan finds the worker busy (staleness is acceptable; the
// dodge safety layer runs every frame regardless — plan 59).
Planner::PlanResult g_lastPlan;
// Highest publish sequence the game thread has successfully handed the worker.
// Used to gate plan freshness so a stale/absent plan never drives movement (plan 63).
uint32_t g_lastPubSeq = 0;

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

Settings ReadSettings()
{
    Settings s{};
    s.laneTiles    = Clamp(g_laneTiles.load(std::memory_order_relaxed), 2.f, 16.f);
    const float stepT = g_stepTiles.load(std::memory_order_relaxed);
    s.stepTiles    = stepT <= 0.f ? 0.f : Clamp(stepT, 0.4f, 3.f);
    s.hitScale     = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.25f, 2.5f);
    s.reactMargin  = Clamp(g_reactMargin.load(std::memory_order_relaxed), 0.05f, 2.0f);
    s.safeWalk     = g_safeWalk.load(std::memory_order_relaxed);
    s.speedScale   = g_speedScale.load(std::memory_order_relaxed);
    s.fieldEscape  = g_fieldEscape.load(std::memory_order_relaxed);
    s.debugOverlay = g_debugOverlay.load(std::memory_order_relaxed);
    s.lockFollow   = g_lockFollow.load(std::memory_order_relaxed);
    s.followLantern = g_followLantern.load(std::memory_order_relaxed);
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

} // namespace

void SetEnabled(bool enabled)
{
    if (enabled) {
        ProjectileTracking::Install();
        Worker::Start();
    }
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        Worker::Stop();   // JOIN the worker before releasing state it never touches
        g_state.Reset();
        g_solve = Solver::SolveResult{};
        g_lastPlan = Planner::PlanResult{};
        PublishDebug(DebugSnapshot{});
    }
}

bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

void OnEnter()
{
    ProjectileTracking::Install();
    Worker::Start();
    g_state.Reset();
    g_solve = Solver::SolveResult{};
    g_lastPlan = Planner::PlanResult{};
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) return;
    if (!DodgeRuntime::EnsureResolved()) return;

    // ── TEMP perf probe: measure the full UDodge::Tick cost on the game thread.
    // RAII so it captures every return path. Logs avg/max ms every 120 ticks.
    struct TickTimer {
        LARGE_INTEGER t0;
        TickTimer() { QueryPerformanceCounter(&t0); }
        ~TickTimer() {
            LARGE_INTEGER t1, f; QueryPerformanceCounter(&t1); QueryPerformanceFrequency(&f);
            const double ms = double(t1.QuadPart - t0.QuadPart) * 1000.0 / double(f.QuadPart);
            static double s_sum = 0.0; static double s_max = 0.0; static int s_n = 0;
            s_sum += ms; if (ms > s_max) s_max = ms;
            if (++s_n >= 120) {
                DBG_FILE_LOG("[UDodge] Tick avg=" << (s_sum / s_n) << "ms max=" << s_max << "ms");
                s_sum = 0.0; s_max = 0.0; s_n = 0;
            }
        }
    } _tickTimer;

    const Settings settings = ReadSettings();
    const SteerInput::SteerState steer = SteerInput::Get();

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
    uint32_t tick = 0;
    const bool tickOk = Sensors::ReadWorldTick(tick);
    bool synced = false;
    if (tickOk && g_map.tickValid && g_map.tickId == tick)
        synced = Sensors::ReanchorMap(g_map, px, py, settings);
    const bool rebuilt = !synced;
    if (rebuilt) {
        Sensors::BuildMap(g_map, px, py, settings);
        g_map.tickId = tick;
        g_map.tickValid = tickOk;
    }
    if (g_map.projectileSourceUnavailable) {
        g_state.Reset();
        PublishMinimal(Decision::None, { px, py });
        return;
    }

    MapInput in{};
    in.player = { px, py };

    in.speed = std::max(0.f, std::isfinite(tilesPerSec) ? tilesPerSec : 0.f) / 1000.f;
    in.stepTiles = settings.stepTiles > 0.f
        ? settings.stepTiles
        : std::clamp(std::max(0.f, tilesPerSec) * kServerTickSec, 0.4f, 3.0f);
    in.tickId = g_map.tickId;
    in.movementLocked = false;
    in.playerOnHazard = settings.safeWalk && Sensors::IsHazardAt(px, py);
    in.settings = settings;
    in.env.canOccupy = &Sensors::CanOccupy;
    in.env.isHazard = &Sensors::IsHazardAt;
    in.map = &g_map;

    // in.stepTiles IS the per-tick move budget (tilesPerSec × kServerTickSec).
    const float b = in.stepTiles;

    // ── Goal (soft preference only) ─────────────────────────────────────────
    // The goal is consumed ONLY through the solver's wGoal term over the SAFE set,
    // so it can never move the player into a shot: it is just how we rank safe
    // options. Priority: WASD steer → user-locked enemy orbit standoff → none
    // (pure dodge that never wanders).
    Solver::Goal goal{};
    if (steer.active && (steer.dirX != 0.f || steer.dirY != 0.f)) {
        const Vec2 dir = Normalize(Vec2{ steer.dirX, steer.dirY });
        if (LenSq(dir) > 1e-6f) {
            goal.active = true;
            goal.pos = Add(in.player, Mul(dir, b));   // WASD intent one budget ahead
        }
    } else if (g_map.hasLock) {
        // Orbit the locked enemy at a standoff = resolved weapon range × 0.85
        // (the SetOrbitRange override feeds the standoff directly when non-zero).
        const float weaponRange = AutoAim::IsProjRangeResolved()
            ? AutoAim::GetProjRangeTiles() : 6.f;
        const float standoff = settings.orbitRange > 0.f
            ? settings.orbitRange : weaponRange * 0.85f;
        const Vec2 fromLock = Sub(in.player, g_map.lockPos);
        const float dist = Len(fromLock);
        if (dist > 1e-3f) {
            const Vec2 dir = Mul(fromLock, 1.f / dist);
            goal.active = true;
            goal.pos = Add(g_map.lockPos, Mul(dir, standoff));  // on the player-side ray
        }
    }

    // ── Solve once per server tick ──────────────────────────────────────────
    // A rebuild means the tick id changed or a structural projectile change forced
    // it — re-solve then and cache; between ticks the cached target is held and
    // merely re-validated + walked below.
    if (rebuilt)
        Solver::Solve(in, b, goal, g_state, g_solve);

    const float frameMs = Clamp(dt * 1000.f, 1.f, 250.f);
    Vec2 moveTarget = in.player;
    bool moveFailed = false;

    // ── Drive toward the solved target through the game's speed-clamped MoveTo ─
    // Every frame: re-validate the cached target against the re-anchored map. If
    // it went unsafe mid-tick (a new shot re-anchored onto it) and we did not
    // rebuild this frame, force a same-frame re-solve so the spawn is dodged
    // immediately (preserves today's structural-change reflex without a worker).
    if (g_solve.shouldMove) {
        bool targetOk = g_solve.kind == Solver::SolveKind::Fallback ||
                        Core::PointSafe(in, g_solve.target, kULatencyPad);
        if (!targetOk && !rebuilt) {
            Sensors::BuildMap(g_map, px, py, settings);
            g_map.tickId = tick;
            g_map.tickValid = tickOk;
            Solver::Solve(in, b, goal, g_state, g_solve);
            targetOk = g_solve.shouldMove;
        }
        if (g_solve.shouldMove && targetOk) {
            const Vec2 to = Sub(g_solve.target, in.player);
            const float d = Len(to);
            const Vec2 dir = d > 1e-4f ? Mul(to, 1.f / d) : Vec2{};
            // Per-frame step, clamped to the player's speed; MoveTo clamps again
            // internally. Converges onto the target by the tick boundary without
            // ever exceeding the per-tick budget.
            moveTarget = Add(in.player, Mul(dir, std::min(d, in.speed * frameMs)));
            const bool ok = DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y);
            if (!ok) moveFailed = true;
            static int s_mvN = 0;
            if ((s_mvN++ % 120) == 0)
                DBG_FILE_LOG("[UDodge] MOVE kind=" << (int)g_solve.kind
                    << " clr=" << g_solve.clearance << " frameMs=" << frameMs
                    << " -> (" << moveTarget.x << "," << moveTarget.y
                    << ") from (" << in.player.x << "," << in.player.y << ") ok=" << ok);
        }
    } else {
        static int s_noMvN = 0;
        if ((s_noMvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] NO-MOVE kind=" << (int)g_solve.kind
                << " clr=" << g_solve.clearance);
    }

    if (settings.debugOverlay) {
        static DebugSnapshot d;   // large (holds the danger map) — keep off the stack
        d.active = true;
        // SolveKind → the closest legacy Decision label for the overlay header.
        switch (g_solve.kind) {
            case Solver::SolveKind::Hold:       d.decision = Decision::NoThreat;        break;
            case Solver::SolveKind::Safe:       d.decision = Decision::GentleOverride;  break;
            case Solver::SolveKind::Fallback:   d.decision = Decision::EmergencyOverride; break;
            case Solver::SolveKind::Surrounded: d.decision = Decision::MovementLocked;  break;
        }
        d.player = in.player;
        d.intentDir = goal.active ? Normalize(Sub(goal.pos, in.player)) : Vec2{};
        d.moveTarget = g_solve.shouldMove ? g_solve.target : in.player;
        d.overrideActive = g_solve.shouldMove;
        d.moveFailed = moveFailed;
        d.candidate = kStandCandidate;
        d.speedScale = 1.f;
        d.threatCount = g_map.laneCount;
        // Server-accurate clearance at the player (≤ 0 ⇒ danger covers the stand).
        d.standClearance = Core::PointSafety(in, in.player);
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
        // No route any more — the solver drives a single reachable target (plan 64).
        d.drawPath = false;
        d.pathCount = 0;
        for (int i = 0; i < kCandidateCount; ++i) d.candidates[i] = CandidateDebug{};
        d.map = g_map;
        PublishDebug(d);
    }
}

void RenderSettings()
{
    float hit     = GetHitScale();
    bool  safe    = GetSafeWalk();
    bool  spd     = GetSpeedScale();
    bool  field   = GetFieldEscape();
    bool  dbg     = GetDebugOverlay();

    float lane = GetLaneTiles();
    if (ImGui::SliderFloat("Danger lane length (tiles)##udodge", &lane, 2.f, 16.f)) SetLaneTiles(lane);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How far ahead of each bullet its danger lane is painted.\n"
                          "Longer = react earlier to distant shots; shorter = only\n"
                          "dodge nearby bullets.");
    float stepT = GetStepTiles();
    if (ImGui::SliderFloat("Step distance (tiles, 0 = auto)##udodge", &stepT, 0.f, 3.f)) SetStepTiles(stepT);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Candidate commitment distance. 0 = one server tick of\n"
                          "motion (tilesPerSec x 0.2s) — the natural quantum of a\n"
                          "per-tick replanner.");
    if (ImGui::SliderFloat("Hit scale##udodge", &hit, 0.5f, 1.5f)) SetHitScale(hit);
    float react = GetReactMargin();
    if (ImGui::SliderFloat("Reaction margin (tiles)##udodge", &react, 0.05f, 2.0f)) SetReactMargin(react);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Spatial clearance the dodge keeps from bullets. This is\n"
                          "the wide reaction space that replaces the deleted time\n"
                          "dimension: higher = start dodging sooner and keep more\n"
                          "buffer (smoother); lower = brush closer.");
    if (ImGui::Checkbox("Safe walk (avoid damaging ground)##udodge", &safe)) SetSafeWalk(safe);
    if (ImGui::Checkbox("Match intent speed##udodge", &spd)) SetSpeedScale(spd);

    if (ImGui::Checkbox("Field escape (route around walls when boxed in)##udodge", &field)) SetFieldEscape(field);
    if (ImGui::Checkbox("Debug overlay##udodge", &dbg)) SetDebugOverlay(dbg);

    bool drawPath = GetDrawPath();
    if (ImGui::Checkbox("Draw planned route##udodge", &drawPath)) SetDrawPath(drawPath);
    float orbit = GetOrbitRange();
    if (ImGui::SliderFloat("Orbit range (tiles, 0 = auto)##udodge", &orbit, 0.f, 16.f)) SetOrbitRange(orbit);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Autopilot boss standoff distance. 0 = auto (resolved weapon\n"
                          "range x 0.85). The orbit keeps this distance with range bands.");
    float planR = GetPlanRadius();
    if (ImGui::SliderFloat("Plan window radius (cells)##udodge", &planR, 8.f, 40.f, "%.0f")) SetPlanRadius(planR);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Planner window half-size in grid cells. Smaller shrinks the\n"
                          "rasterized window and cuts per-frame cost if it stutters.");

    bool lockF = GetLockFollow();
    if (ImGui::Checkbox("Lock follow (walk toward lock target)##udodge", &lockF)) SetLockFollow(lockF);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("When on, consumes the enemy lock / follow target as the\n"
                          "walk direction when no WASD input is active. WASD always\n"
                          "overrides. Off = pure dodge, no auto-walk.");

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

DiagView GetDiagView()
{
    DiagView v{};
    v.enabled = IsEnabled();
    std::lock_guard<std::mutex> lock(g_debugMutex);
    const DebugSnapshot& d = DebugSlot();
    v.decision = static_cast<int>(d.decision);
    v.playerX = d.player.x;
    v.playerY = d.player.y;
    v.overrideActive = d.overrideActive;
    const Vec2 dir = d.candidates[std::clamp(d.candidate, 0, kCandidateCount - 1)].dir;
    v.velXPerSec = d.overrideActive ? dir.x * d.speed * d.speedScale * 1000.f : 0.f;
    v.velYPerSec = d.overrideActive ? dir.y * d.speed * d.speedScale * 1000.f : 0.f;
    v.candidate = d.candidate;
    v.speedScale = d.speedScale;
    v.threatCount = d.threatCount;
    v.standClearanceTiles = d.standClearance;
    v.lanes = d.map.laneCount;
    v.zones = d.map.zoneCount;
    v.enemies = d.map.enemyCount;
    v.tickId = d.tickId;
    v.tickValid = d.tickValid;
    v.fieldActive = d.fieldActive;
    v.hasLockTarget = d.hasLockTarget;
    v.lockX = d.lockTarget.x;
    v.lockY = d.lockTarget.y;
    return v;
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
void  SetLockFollow(bool en) { g_lockFollow.store(en, std::memory_order_relaxed); }
bool  GetLockFollow() { return g_lockFollow.load(std::memory_order_relaxed); }
void  SetFollowLantern(bool en) { g_followLantern.store(en, std::memory_order_relaxed); }
bool  GetFollowLantern() { return g_followLantern.load(std::memory_order_relaxed); }
void  SetStandOnType(int t) { g_standOnType.store(t, std::memory_order_relaxed); }
int   GetStandOnType() { return g_standOnType.load(std::memory_order_relaxed); }
void  SetOrbitRange(float t) { g_orbitRange.store(t <= 0.f ? 0.f : Clamp(t, 2.f, 16.f), std::memory_order_relaxed); }
float GetOrbitRange() { return g_orbitRange.load(std::memory_order_relaxed); }
void  SetPlanRadius(float cells) { g_planRadius.store(Clamp(cells, 8.f, 40.f), std::memory_order_relaxed); }
float GetPlanRadius() { return g_planRadius.load(std::memory_order_relaxed); }
void  SetDrawPath(bool en) { g_drawPath.store(en, std::memory_order_relaxed); }
bool  GetDrawPath() { return g_drawPath.load(std::memory_order_relaxed); }

} // namespace UDodge
