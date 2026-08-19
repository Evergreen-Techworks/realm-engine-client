#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
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
std::atomic<int>   g_mode{ 0 };
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
// Last plan the worker handed back — game-thread-owned cache, kept across frames
// when TryGetLatestPlan finds the worker busy (staleness is acceptable; the
// dodge safety layer runs every frame regardless — plan 59).
Planner::PlanResult g_lastPlan;

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
    s.mode         = ClampInt(g_mode.load(std::memory_order_relaxed), 0, 1);
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

// Autopilot Priority 1 — STAND-ON override (the Moonlight Village lantern).
// Gated behind `followLantern` (default OFF): it iterates WorldTAB's full entity
// list — the only source that includes UNTARGETABLE objects — which is a real
// per-frame cost AND carries the same game-thread-vs-render-refresh race the
// shipped zDodge already has on GetEntities. So it is opt-in for that one dungeon
// mechanic; normal play never touches GetEntities. This walks IL2CPP objects and
// therefore STAYS on the game thread (it can never move to the planner worker).
//
// Returns true and fills outTargetPos/outDir when a stand-on object is found.
bool LanternIntent(Vec2 player, const Settings& settings, Vec2& outTargetPos, Vec2& outDir)
{
    if (!(settings.followLantern && settings.standOnType != 0)) return false;

    const std::vector<WorldEntity>& ents = WorldTAB::GetEntities();
    bool found = false;
    int32_t soId = 0;
    float soX = 0.f, soY = 0.f, bestSq = 1e18f;
    for (const WorldEntity& e : ents) {
        if (e.isLocal || e.objType != settings.standOnType) continue;
        const float dx = e.x - player.x, dy = e.y - player.y;
        const float d2 = dx * dx + dy * dy;
        if (d2 < bestSq) { bestSq = d2; soId = e.objectId; soX = e.x; soY = e.y; found = true; }
    }
    if (!found) return false;

    WorldTAB::GetEntityLivePos(soId, soX, soY);   // live if available
    outTargetPos = { soX, soY };
    const Vec2 to = Sub(outTargetPos, player);
    const float dist = Len(to);
    if (dist <= 0.35f) outDir = {};                // on it → hold position
    else               outDir = Mul(to, 1.f / dist); // walk straight onto it
    return true;
}

// Rasterize the plain-data occupancy+hazard grid the worker routes over (plan 60).
// GAME THREAD ONLY: Sensors::CanOccupy / IsHazardAt touch live world memory, so this
// can never move to the worker. HOT PATH: 81×81 = 6561 CanOccupy calls is the single
// largest new game-thread cost, so WALL bits (bit0) are re-rasterized ONLY on a full
// map rebuild (walls are static within a server tick), while HAZARD bits (bit1) refresh
// every publish (cheap via the per-tick hazard memo). `grid` persists across frames
// (a static in Tick), so unrebuilt wall bits survive. Runs inside the per-tick memo
// lifetime — BuildMap/ReanchorMap cleared and repopulated the memo earlier this frame.
void FillOccGrid(Planner::OccGrid& grid, Vec2 player, bool rebuildWalls, int radiusCells)
{
    grid.center = player;
    constexpr int R = Planner::kPlanGridRadius;
    constexpr int S = Planner::kPlanGridSize;
    const int rad = std::clamp(radiusCells, 8, R);
    for (int gy = 0; gy < S; ++gy) {
        for (int gx = 0; gx < S; ++gx) {
            uint8_t& f = grid.flags[gy * S + gx];
            // Outside the (shrinkable) planner window: mark WALL and skip the CanOccupy
            // probe — this is what lets a smaller radius cut the rasterize cost.
            if (std::max(std::abs(gx - R), std::abs(gy - R)) > rad) {
                f |= 0x1; f &= static_cast<uint8_t>(~0x2);
                continue;
            }
            const float wx = player.x + static_cast<float>(gx - R) * Planner::kPlanCellTiles;
            const float wy = player.y + static_cast<float>(gy - R) * Planner::kPlanCellTiles;
            if (rebuildWalls) {
                // Walls only (safeWalk=false) so hazard is a routing COST, not a block —
                // matching UDodgeField::IsWall.
                if (!Sensors::CanOccupy(wx, wy, false)) f |= 0x1; else f &= static_cast<uint8_t>(~0x1);
            }
            if (Sensors::IsHazardAt(wx, wy)) f |= 0x2; else f &= static_cast<uint8_t>(~0x2);
        }
    }
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
    g_lastPlan = Planner::PlanResult{};
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) return;
    if (!DodgeRuntime::EnsureResolved()) return;

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

    // Intent priority: WASD (always wins) → Autopilot goal → lock-follow
    // external goal. Machine-generated intents may be auto-walked below.
    bool intentIsAuto = false, apHasTarget = false;
    Vec2 apTarget{};
    if (steer.active) {
        in.intentDir = { steer.dirX, steer.dirY };
    } else if (settings.mode == 1 /*Autopilot*/) {
        intentIsAuto = true;
        // Priority 1 — lantern stand-on (game-thread IL2CPP entity walk).
        if (LanternIntent(in.player, settings, apTarget, in.intentDir)) {
            apHasTarget = true;
        } else {
            // Priority 2 — boss-lock orbit through the background planner worker
            // (plan 59). The weapon range is resolved HERE (game thread) into a
            // plain float, so the snapshot stays pure — no IL2CPP crosses the
            // thread boundary. We PUBLISH the snapshot (non-blocking) and CONSUME
            // the worker's latest plan (non-blocking); the game thread never
            // blocks on the worker. Core::Evaluate below still runs every frame,
            // so bullet-reaction latency is unaffected by plan staleness.
            // Large (rasterized grid + danger map) — keep off the stack; static so the
            // grid's wall bits persist across frames for the rebuild-only rasterization.
            // Every scalar field below is overwritten each publish, so no re-zeroing.
            static Planner::PlannerSnapshot snap;
            snap.tickId           = g_map.tickId;
            snap.player           = in.player;
            snap.settings         = settings;
            snap.hasLock          = g_map.hasLock;
            snap.lockPos          = g_map.lockPos;
            snap.rangeResolved    = AutoAim::IsProjRangeResolved();
            snap.weaponRangeTiles = snap.rangeResolved ? AutoAim::GetProjRangeTiles() : 6.f;
            // GAME-THREAD rasterization: walls on rebuild, hazard each publish. Copy the
            // plain-data danger map for the worker's lane/zone routing cost.
            FillOccGrid(snap.grid, in.player, rebuilt, settings.planRadius);
            snap.map = g_map;

            Worker::PublishSnapshot(snap);

            Planner::PlanResult fresh{};
            if (Worker::TryGetLatestPlan(fresh)) {
                g_lastPlan = fresh;   // refresh the cache when the worker isn't busy
                static int s_wpN = 0;
                if ((s_wpN++ % 120) == 0)
                    DBG_FILE_LOG("[UDodge] Worker plan seq=" << g_lastPlan.forSeq
                        << " hasGoal=" << g_lastPlan.hasGoal);
            }

            // Cold start (no plan yet) leaves g_lastPlan default → firstDir {} →
            // pure dodge until the first plan lands (safe, transient).
            // OVERRIDE PRECEDENCE (plan 61 §2): the plan's firstDir is fed ONLY as an
            // overridable intent — Core::Evaluate below preserves it while safe
            // (UDodgeCore.cpp:558-564) but pre-empts it the instant a bullet threatens
            // (emergency/gentle override), so the dodge always wins over the boss path.
            in.intentDir = g_lastPlan.firstDir;
            apHasTarget  = g_lastPlan.hasGoal;
            apTarget     = g_lastPlan.goalPos;
        }
    } else if (settings.lockFollow) {
        float gx = 0.f, gy = 0.f;
        if (DangerPlanner::GetExternalGoal(gx, gy)) {
            const float dx = gx - px, dy = gy - py, d = std::sqrt(dx * dx + dy * dy);
            if (d > 0.3f) { in.intentDir = { dx / d, dy / d }; intentIsAuto = true; }
        }
    }

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

    Core::Evaluate(in, g_state, g_out);

    const float frameMs = Clamp(dt * 1000.f, 1.f, 250.f);
    Vec2 moveTarget = in.player;
    bool moveFailed = false;

    // Auto-walk: when the core does not override, the intent is machine-
    // generated, and the core judged the intent safe, walk it ourselves.
    // NoThreat returns before wall validation runs, so probe the move target
    // against walls here to avoid walking into them.
    bool autoWalk = false;
    if (!g_out.overrideActive && intentIsAuto && LenSq(in.intentDir) > 1e-6f &&
        (g_out.decision == Decision::NoThreat || g_out.decision == Decision::PreserveSafeIntent)) {
        const Vec2 probe = Add(in.player, Mul(g_out.velocity, std::max(frameMs, 100.f)));
        autoWalk = Sensors::CanOccupy(probe.x, probe.y, settings.safeWalk);
    }

    if (g_out.overrideActive || autoWalk) {
        moveTarget = Add(in.player, Mul(g_out.velocity, frameMs));
        const bool ok = DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y);
        if (!ok) moveFailed = true;
        static int s_mvN = 0;
        if ((s_mvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] MOVE dec=" << (int)g_out.decision
                << " ov=" << g_out.overrideActive << " aw=" << autoWalk
                << " |v|=" << Len(g_out.velocity) << " frameMs=" << frameMs
                << " -> (" << moveTarget.x << "," << moveTarget.y
                << ") from (" << in.player.x << "," << in.player.y << ") ok=" << ok);
    } else {
        static int s_noMvN = 0;
        if ((s_noMvN++ % 120) == 0)
            DBG_FILE_LOG("[UDodge] NO-MOVE dec=" << (int)g_out.decision
                << " ov=" << g_out.overrideActive << " aw=" << autoWalk
                << " |v|=" << Len(g_out.velocity)
                << " standClr=" << g_out.standClearance
                << " threats=" << g_out.threatCount);
    }

    if (settings.debugOverlay) {
        static DebugSnapshot d;   // large (holds the danger map) — keep off the stack
        d.active = true;
        d.decision = g_out.decision;
        d.player = in.player;
        d.intentDir = in.intentDir;
        d.moveTarget = moveTarget;
        d.overrideActive = g_out.overrideActive || autoWalk;
        d.moveFailed = moveFailed;
        d.candidate = g_out.candidate;
        d.speedScale = g_out.speedScale;
        d.threatCount = g_out.threatCount;
        d.standClearance = g_out.standClearance;
        d.speed = in.speed;
        d.stepTiles = in.stepTiles;
        d.reactMargin = settings.reactMargin;
        d.tickId = g_map.tickId;
        d.tickValid = g_map.tickValid;
        d.rebuiltThisFrame = rebuilt;
        d.fieldActive = g_out.fieldActive;
        d.fieldTarget = g_out.fieldTarget;
        d.hasLockTarget = apHasTarget;
        d.lockTarget = apTarget;
        // Planned route from the consumed worker plan (plain data) — drawn on the overlay.
        // Gated by udodgeDrawPath (plan 61): when off, publish no route so the overlay
        // (and Debug::Render's polyline) draw nothing.
        d.drawPath = GetDrawPath();
        if (d.drawPath) {
            d.pathCount = std::clamp(g_lastPlan.pathCount, 0, kMaxPathPoints);
            for (int i = 0; i < d.pathCount; ++i) d.path[i] = g_lastPlan.path[i];
        } else {
            d.pathCount = 0;
        }
        for (int i = 0; i < kCandidateCount; ++i) d.candidates[i] = g_out.candidates[i];
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

    const char* modeLabels[] = { "Assist", "Autopilot" };
    int modeIdx = ClampInt(GetMode(), 0, 1);
    if (ImGui::Combo("Mode##udodge", &modeIdx, modeLabels, IM_ARRAYSIZE(modeLabels))) SetMode(modeIdx);

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
void  SetMode(int mode) { g_mode.store(ClampInt(mode, 0, 1), std::memory_order_relaxed); }
int   GetMode() { return g_mode.load(std::memory_order_relaxed); }
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
