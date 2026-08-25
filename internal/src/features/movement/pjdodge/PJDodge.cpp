#include "pch-il2cpp.h"
#include "PJDodge.h"
#include "PJDodgeTypes.h"
#include "PJDodgeCore.h"
#include "PJDodgeSensors.h"
#include "PJDodgeDebug.h"

#include "MovementRuntime.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "DangerPlanner.h"
#include "gui/tabs/TestTAB.h"

#include <imgui/imgui.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <windows.h>

namespace PJDodge {
namespace {

std::atomic<bool>  g_enabled{ false };
std::atomic<float> g_horizonMs{ 600.f };
std::atomic<float> g_leadMs{ 40.f };
std::atomic<float> g_hitScale{ 1.0f };
std::atomic<bool>  g_safeWalk{ true };
std::atomic<bool>  g_speedScale{ true };
std::atomic<bool>  g_predictionAccuracy{ true };
std::atomic<bool>  g_debugOverlay{ true };
std::atomic<bool>  g_lockFollow{ false };

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

Settings ReadSettings()
{
    Settings s{};
    s.horizonMs    = Clamp(g_horizonMs.load(std::memory_order_relaxed), 200.f, 2000.f);
    s.leadMs       = Clamp(g_leadMs.load(std::memory_order_relaxed), 0.f, 250.f);
    s.hitScale     = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.25f, 2.5f);
    s.safeWalk     = g_safeWalk.load(std::memory_order_relaxed);
    s.speedScale   = g_speedScale.load(std::memory_order_relaxed);
    s.predictionAccuracy = g_predictionAccuracy.load(std::memory_order_relaxed);
    s.debugOverlay = g_debugOverlay.load(std::memory_order_relaxed);
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
    in.intentDir = steer.active ? Vec2{ steer.dirX, steer.dirY } : Vec2{};

    if (!steer.active && g_lockFollow.load(std::memory_order_relaxed)) {
        float gx = 0.f, gy = 0.f;
        if (DangerPlanner::GetExternalGoal(gx, gy)) {
            const float dx = gx - px, dy = gy - py;
            const float d = std::sqrt(dx * dx + dy * dy);
            if (d > 0.3f)
                in.intentDir = { dx / d, dy / d };
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

    // Lock follow auto-walk: when the core says the intent is safe (NoThreat or
    // PreserveSafeIntent → overrideActive=false), walk the intent ourselves.
    // NoThreat returns before wall validation runs, so probe the move target
    // against walls here to avoid walking into them.
    bool lockWalk = false;
    if (!g_out.overrideActive &&
        g_lockFollow.load(std::memory_order_relaxed) &&
        LenSq(in.intentDir) > 1e-6f &&
        (g_out.decision == Decision::NoThreat || g_out.decision == Decision::PreserveSafeIntent)) {
        const Vec2 probe = Add(in.player, Mul(g_out.velocity, std::max(frameMs, 100.f)));
        lockWalk = Sensors::CanOccupy(probe.x, probe.y, settings.safeWalk);
    }

    if (g_out.overrideActive || lockWalk) {
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
        d.overrideActive = g_out.overrideActive || lockWalk;
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
    bool  dbg     = GetDebugOverlay();

    if (ImGui::SliderFloat("Horizon ms##pjdodge", &horizon, 300.f, 1200.f)) SetHorizonMs(horizon);
    if (ImGui::SliderFloat("Command lead ms##pjdodge", &lead, 0.f, 150.f)) SetLeadMs(lead);
    if (ImGui::SliderFloat("Hit scale##pjdodge", &hit, 0.5f, 1.5f)) SetHitScale(hit);
    if (ImGui::Checkbox("Safe walk (avoid damaging ground)##pjdodge", &safe)) SetSafeWalk(safe);
    if (ImGui::Checkbox("Match intent speed##pjdodge", &spd)) SetSpeedScale(spd);

    bool pred = GetPredictionAccuracy();
    if (ImGui::Checkbox("Prediction accuracy (clock calibration)##pjdodge", &pred)) SetPredictionAccuracy(pred);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Fits a per-projectile time correction from the live position so\n"
                          "predictions sit on the true trajectory (removes clock jitter +\n"
                          "spawn-hook latency). Overlay shows clock error / model error.");
    {
        const ProjectileTracking::PredictionDiag pd = ProjectileTracking::GetPredictionDiag();
        ImGui::SameLine();
        ImGui::TextDisabled("clk %.1fms  model %.03f/%.03f", pd.emaAbsTauMs, pd.emaCrossTiles, pd.maxCrossTiles);
    }

    if (ImGui::Checkbox("Debug overlay##pjdodge", &dbg)) SetDebugOverlay(dbg);

    bool lockF = GetLockFollow();
    if (ImGui::Checkbox("Lock follow (walk toward lock target)##pjdodge", &lockF)) SetLockFollow(lockF);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("When on, consumes the enemy lock / follow target as the\n"
                          "walk direction when no WASD input is active. WASD always\n"
                          "overrides. Off = pure dodge, no auto-walk.");
}

void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!IsEnabled() || !GetDebugOverlay()) return;
    // large — keep off the render-thread stack; heap-backed for the same reason as DebugSlot()
    static DebugSnapshot* const snap = new DebugSnapshot();
    { std::lock_guard<std::mutex> lock(g_debugMutex); *snap = DebugSlot(); }
    Debug::Render(*snap, camX, camY, angle, zoom, cx, cy);
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
void  SetDebugOverlay(bool en) { g_debugOverlay.store(en, std::memory_order_relaxed); }
bool  GetDebugOverlay() { return g_debugOverlay.load(std::memory_order_relaxed); }
void  SetLockFollow(bool en) { g_lockFollow.store(en, std::memory_order_relaxed); }
bool  GetLockFollow() { return g_lockFollow.load(std::memory_order_relaxed); }

} // namespace PJDodge
