#include "pch-il2cpp.h"
#include "UDodge.h"
#include "UDodgeTypes.h"
#include "UDodgeCore.h"
#include "UDodgeSensors.h"
#include "UDodgeDebug.h"

#include "MovementRuntime.h"
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
std::atomic<float> g_horizonMs{ 600.f };
std::atomic<float> g_leadMs{ 40.f };
std::atomic<float> g_hitScale{ 1.0f };
std::atomic<bool>  g_safeWalk{ true };
std::atomic<bool>  g_speedScale{ true };
std::atomic<bool>  g_predictionAccuracy{ true };
std::atomic<bool>  g_fieldEscape{ true };
std::atomic<bool>  g_debugOverlay{ true };
std::atomic<int>   g_mode{ 0 };
std::atomic<bool>  g_lockFollow{ false };
std::atomic<bool>  g_followLantern{ false };
std::atomic<int>   g_standOnType{ 0 };

// Game-update thread only.
CoreState  g_state;
Snapshot   g_snapshot;
CoreOutput g_out;

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
    s.horizonMs    = Clamp(g_horizonMs.load(std::memory_order_relaxed), 200.f, 2000.f);
    s.leadMs       = Clamp(g_leadMs.load(std::memory_order_relaxed), 0.f, 250.f);
    s.hitScale     = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.25f, 2.5f);
    s.safeWalk     = g_safeWalk.load(std::memory_order_relaxed);
    s.speedScale   = g_speedScale.load(std::memory_order_relaxed);
    s.predictionAccuracy = g_predictionAccuracy.load(std::memory_order_relaxed);
    s.fieldEscape  = g_fieldEscape.load(std::memory_order_relaxed);
    s.debugOverlay = g_debugOverlay.load(std::memory_order_relaxed);
    s.mode         = ClampInt(g_mode.load(std::memory_order_relaxed), 0, 1);
    s.lockFollow   = g_lockFollow.load(std::memory_order_relaxed);
    s.followLantern = g_followLantern.load(std::memory_order_relaxed);
    s.standOnType   = g_standOnType.load(std::memory_order_relaxed);
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

// Orbit / keep-weapon-range steering toward a target at world (tx, ty).
Vec2 OrbitIntent(Vec2 player, float tx, float ty)
{
    const Vec2 to = Sub(Vec2{ tx, ty }, player);
    const float dist = Len(to);
    if (dist < 1e-3f) return {};
    const Vec2 dir = Mul(to, 1.f / dist);
    const float range = std::clamp(AutoAim::IsProjRangeResolved() ? AutoAim::GetProjRangeTiles() : 6.f, 2.f, 16.f);
    const float desired = range * 0.85f;
    if (dist > desired + 0.5f) return dir;             // too far → close in
    if (dist < desired - 0.5f) return Mul(dir, -1.f);  // too close → back off
    return Vec2{ -dir.y, dir.x };                       // in band → orbit (tangential)
}

// Autopilot intent.
//
// Priority 1 — STAND-ON override (the Moonlight Village lantern). Gated behind
// `followLantern` (default OFF): it iterates WorldTAB's full entity list — the
// only source that includes UNTARGETABLE objects — which is a real per-frame
// cost AND carries the same game-thread-vs-render-refresh race the shipped
// zDodge already has on GetEntities. So it is opt-in for that one dungeon
// mechanic; normal play never touches GetEntities.
//
// Priority 2 — BOSS lock from the sensor's fresh, game-thread enemy pass
// (highest-maxHp; sticky even at low current HP). No GetEntities here.
//
// Survival always dominates: this is only the goal the planner pursues; the
// dodge layer overrides it the instant the goal move is unsafe (flee for free).
Vec2 AutopilotIntent(const Snapshot& sn, Vec2 player, const Settings& settings,
                     bool& outHasTarget, Vec2& outTargetPos)
{
    outHasTarget = false;

    if (settings.followLantern && settings.standOnType != 0) {
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
        if (found) {
            WorldTAB::GetEntityLivePos(soId, soX, soY);   // live if available
            outHasTarget = true;
            outTargetPos = { soX, soY };
            const Vec2 to = Sub(outTargetPos, player);
            const float dist = Len(to);
            if (dist <= 0.35f) return {};                  // on it → hold position
            return Mul(to, 1.f / dist);                    // walk straight onto it
        }
    }

    if (!sn.hasLock) return {};
    outHasTarget = true;
    outTargetPos = sn.lockPos;
    return OrbitIntent(player, sn.lockPos.x, sn.lockPos.y);
}

} // namespace

void SetEnabled(bool enabled)
{
    if (enabled) ProjectileTracking::Install();
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        g_state.Reset();
        PublishDebug(DebugSnapshot{});
    }
}

bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

void OnEnter()
{
    ProjectileTracking::Install();
    g_state.Reset();
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) return;
    if (!DodgeRuntime::EnsureResolved()) return;

    const Settings settings = ReadSettings();
    ProjectileTracking::SetPredictionAccuracy(settings.predictionAccuracy);
    const SteerInput::SteerState steer = SteerInput::Get();

    int32_t hp = 0, maxHp = 0;
    float spd = 0.f, tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);

    Sensors::Build(g_snapshot, px, py, settings);
    if (g_snapshot.projectileSourceUnavailable) {
        g_state.Reset();
        PublishMinimal(Decision::None, { px, py });
        return;
    }

    CoreInput in{};
    in.player = { px, py };

    // Intent priority: WASD (always wins) → Autopilot goal → lock-follow
    // external goal. Machine-generated intents may be auto-walked below.
    bool intentIsAuto = false, apHasTarget = false;
    Vec2 apTarget{};
    if (steer.active) {
        in.intentDir = { steer.dirX, steer.dirY };
    } else if (settings.mode == 1 /*Autopilot*/) {
        in.intentDir = AutopilotIntent(g_snapshot, in.player, settings, apHasTarget, apTarget);
        intentIsAuto = true;
    } else if (settings.lockFollow) {
        float gx = 0.f, gy = 0.f;
        if (DangerPlanner::GetExternalGoal(gx, gy)) {
            const float dx = gx - px, dy = gy - py, d = std::sqrt(dx * dx + dy * dy);
            if (d > 0.3f) { in.intentDir = { dx / d, dy / d }; intentIsAuto = true; }
        }
    }

    in.moveSpeed = std::max(0.f, std::isfinite(tilesPerSec) ? tilesPerSec : 0.f) / 1000.f;
    in.nowMs = static_cast<double>(GetTickCount64());
    in.movementLocked = false;
    in.playerOnHazard = settings.safeWalk && Sensors::IsHazardAt(px, py);
    in.settings = settings;
    in.env.canOccupy = &Sensors::CanOccupy;
    in.env.isHazard = &Sensors::IsHazardAt;
    in.sensors = &g_snapshot;

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
        if (!DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y))
            moveFailed = true;
    }

    if (settings.debugOverlay) {
        static DebugSnapshot d;   // large (holds the sensor snapshot) — keep off the stack
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
        d.earliestImpactMs = g_out.earliestImpactMs;
        d.speed = in.moveSpeed;
        d.leadMs = settings.leadMs;
        d.horizonMs = settings.horizonMs;
        {
            const ProjectileTracking::PredictionDiag pd = ProjectileTracking::GetPredictionDiag();
            d.predEnabled = pd.enabled;
            d.predClockErrMs = pd.emaAbsTauMs;
            d.predModelErrTiles = pd.emaCrossTiles;
        }
        d.fieldActive = g_out.fieldActive;
        d.fieldTarget = g_out.fieldTarget;
        d.hasLockTarget = apHasTarget;
        d.lockTarget = apTarget;
        for (int i = 0; i < kCandidateCount; ++i) d.candidates[i] = g_out.candidates[i];
        d.sensors = g_snapshot;
        PublishDebug(d);
    }
}

void RenderSettings()
{
    float horizon = GetHorizonMs();
    float lead    = GetLeadMs();
    float hit     = GetHitScale();
    bool  safe    = GetSafeWalk();
    bool  spd     = GetSpeedScale();
    bool  field   = GetFieldEscape();
    bool  dbg     = GetDebugOverlay();

    if (ImGui::SliderFloat("Horizon ms##udodge", &horizon, 300.f, 1200.f)) SetHorizonMs(horizon);
    if (ImGui::SliderFloat("Command lead ms##udodge", &lead, 0.f, 150.f)) SetLeadMs(lead);
    if (ImGui::SliderFloat("Hit scale##udodge", &hit, 0.5f, 1.5f)) SetHitScale(hit);
    if (ImGui::Checkbox("Safe walk (avoid damaging ground)##udodge", &safe)) SetSafeWalk(safe);
    if (ImGui::Checkbox("Match intent speed##udodge", &spd)) SetSpeedScale(spd);

    bool pred = GetPredictionAccuracy();
    if (ImGui::Checkbox("Prediction accuracy (clock calibration)##udodge", &pred)) SetPredictionAccuracy(pred);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Fits a per-projectile time correction from the live position so\n"
                          "predictions sit on the true trajectory (removes clock jitter +\n"
                          "spawn-hook latency). Overlay shows clock error / model error.");
    {
        const ProjectileTracking::PredictionDiag pd = ProjectileTracking::GetPredictionDiag();
        ImGui::SameLine();
        ImGui::TextDisabled("clk %.1fms  model %.03f/%.03f", pd.emaAbsTauMs, pd.emaCrossTiles, pd.maxCrossTiles);
    }

    if (ImGui::Checkbox("Field escape (route around walls when boxed in)##udodge", &field)) SetFieldEscape(field);
    if (ImGui::Checkbox("Debug overlay##udodge", &dbg)) SetDebugOverlay(dbg);

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
    v.earliestImpactMs = d.earliestImpactMs >= kMaxTimeMs ? -1.f : d.earliestImpactMs;
    v.projectiles = d.sensors.projectileCount;
    v.aoes = d.sensors.aoeCount;
    v.enemies = d.sensors.enemyCount;
    v.fieldActive = d.fieldActive;
    v.hasLockTarget = d.hasLockTarget;
    v.lockX = d.lockTarget.x;
    v.lockY = d.lockTarget.y;
    const ProjectileTracking::PredictionDiag pd = ProjectileTracking::GetPredictionDiag();
    v.predEnabled       = pd.enabled;
    v.predCalibrated    = pd.calibrated;
    v.predClockErrMs    = pd.emaAbsTauMs;
    v.predModelErrTiles = pd.emaCrossTiles;
    v.predModelMaxTiles = pd.maxCrossTiles;
    return v;
}

void  SetHorizonMs(float ms) { g_horizonMs.store(Clamp(ms, 200.f, 2000.f), std::memory_order_relaxed); }
float GetHorizonMs() { return g_horizonMs.load(std::memory_order_relaxed); }
void  SetLeadMs(float ms) { g_leadMs.store(Clamp(ms, 0.f, 250.f), std::memory_order_relaxed); }
float GetLeadMs() { return g_leadMs.load(std::memory_order_relaxed); }
void  SetHitScale(float s) { g_hitScale.store(Clamp(s, 0.25f, 2.5f), std::memory_order_relaxed); }
float GetHitScale() { return g_hitScale.load(std::memory_order_relaxed); }
void  SetSafeWalk(bool en) { g_safeWalk.store(en, std::memory_order_relaxed); }
bool  GetSafeWalk() { return g_safeWalk.load(std::memory_order_relaxed); }
void  SetSpeedScale(bool en) { g_speedScale.store(en, std::memory_order_relaxed); }
bool  GetSpeedScale() { return g_speedScale.load(std::memory_order_relaxed); }
void  SetPredictionAccuracy(bool en) {
    g_predictionAccuracy.store(en, std::memory_order_relaxed);
    ProjectileTracking::SetPredictionAccuracy(en);
}
bool  GetPredictionAccuracy() { return g_predictionAccuracy.load(std::memory_order_relaxed); }
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

} // namespace UDodge
