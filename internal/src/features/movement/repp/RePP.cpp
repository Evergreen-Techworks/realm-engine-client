#include "pch-il2cpp.h"
#include "RePP.h"
#include "ReppTypes.h"
#include "ReppSensors.h"
#include "ReppPlanner.h"
#include "ReppCommit.h"
#include "ReppDebug.h"

#include "MovementRuntime.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"

#include <imgui/imgui.h>
#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <windows.h>

namespace RePP {
namespace {

std::atomic<bool>  g_enabled{ false };
std::atomic<float> g_reactWindowMs{ 650.f };
std::atomic<float> g_maxMoveTiles{ 1.0f };
std::atomic<float> g_hitScale{ 1.0f };
std::atomic<float> g_dangerWeight{ 2.0f };
std::atomic<int>   g_mode{ static_cast<int>(Mode::Assist) };
std::atomic<bool>  g_avoidHazards{ true };
std::atomic<bool>  g_debugOverlay{ true };
std::atomic<bool>  g_followLantern{ false };
std::atomic<int>   g_standOnType{ 0 };

// ── Commit-dwell (anti flip-flop) ───────────────────────────────────────────
constexpr uint64_t kCommitDwellMs = 250;
constexpr float    kSharpFlipDot  = -0.15f;
bool     g_haveCommittedDir = false;
Vec2     g_committedDir{};
uint64_t g_lastCommitMs = 0;

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
    s.reactWindowMs = Clamp(g_reactWindowMs.load(std::memory_order_relaxed), 100.f, 2500.f);
    s.maxMoveTiles  = Clamp(g_maxMoveTiles.load(std::memory_order_relaxed), 0.2f, 4.f);
    s.hitScale      = Clamp(g_hitScale.load(std::memory_order_relaxed), 0.5f, 2.f);
    s.dangerWeight  = Clamp(g_dangerWeight.load(std::memory_order_relaxed), 0.f, 5.f);
    s.mode          = ClampInt(g_mode.load(std::memory_order_relaxed), 0, 1);
    s.avoidHazards  = g_avoidHazards.load(std::memory_order_relaxed);
    s.debugOverlay  = g_debugOverlay.load(std::memory_order_relaxed);
    s.followLantern = g_followLantern.load(std::memory_order_relaxed);
    s.standOnType   = g_standOnType.load(std::memory_order_relaxed);
    return s;
}

void ResetCommit()
{
    g_haveCommittedDir = false;
    g_committedDir = {};
    g_lastCommitMs = 0;
}

float MoveBudget(float tilesPerSec, float dt, float maxMoveTiles)
{
    if (!std::isfinite(tilesPerSec) || tilesPerSec < 0.f) tilesPerSec = 0.f;
    if (!std::isfinite(dt) || dt < 0.f) dt = 0.f;
    return std::min(maxMoveTiles, std::max(0.02f, tilesPerSec * dt));
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

// Autopilot intent (R5/R6).
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
Vec2 AutopilotIntent(const SensorSnapshot& sn, Vec2 player, bool followLantern, int standOnType,
                     bool& outHasTarget, Vec2& outTargetPos)
{
    outHasTarget = false;

    if (followLantern && standOnType != 0) {
        const std::vector<WorldEntity>& ents = WorldTAB::GetEntities();
        bool found = false;
        int32_t soId = 0;
        float soX = 0.f, soY = 0.f, bestSq = 1e18f;
        for (const WorldEntity& e : ents) {
            if (e.isLocal || e.objType != standOnType) continue;
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

// Clamp the per-frame commanded step toward the plan target; hold the committed
// direction briefly against sharp reversals (only when the held step is safe).
Vec2 ResolveMoveTarget(Vec2 player, Vec2 target, float moveBudget, float frameMs,
                       const Settings& settings, const SensorSnapshot& sensors)
{
    const Vec2 desired = Sub(target, player);
    const float dist = Len(desired);
    if (dist <= 1e-4f || moveBudget <= 0.f) return player;

    Vec2 dir = Mul(desired, 1.f / dist);
    const uint64_t now = GetTickCount64();
    if (g_haveCommittedDir && (now - g_lastCommitMs) < kCommitDwellMs && Dot(dir, g_committedDir) < kSharpFlipDot) {
        const Vec2 held = Add(player, Mul(g_committedDir, moveBudget));
        if (Planner::IsSweepSafe(player, held, settings, sensors, moveBudget, frameMs))
            dir = g_committedDir;
    }

    const Vec2 moveTarget = Add(player, Mul(dir, std::min(moveBudget, dist)));
    g_committedDir = dir;
    g_haveCommittedDir = true;
    g_lastCommitMs = now;
    return moveTarget;
}

void PublishDebug(const DebugSnapshot& snap)
{
    std::lock_guard<std::mutex> lock(g_debugMutex);
    DebugSlot() = snap;
}

} // namespace

void SetEnabled(bool enabled)
{
    if (enabled) ProjectileTracking::Install();
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) { ResetCommit(); PublishDebug(DebugSnapshot{}); }
}
bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }

void OnEnter()
{
    ProjectileTracking::Install();
    ResetCommit();
    PublishDebug(DebugSnapshot{});
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) { ResetCommit(); return; }
    if (!DodgeRuntime::EnsureResolved()) { ResetCommit(); return; }

    const Settings settings = ReadSettings();

    const SteerInput::SteerState steer = SteerInput::Get();

    int32_t hp = 0, maxHp = 0;
    float spd = 0.f, tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);
    const float moveBudget = MoveBudget(tilesPerSec, dt, settings.maxMoveTiles);

    PlanRequest req{};
    req.settings   = settings;
    req.player     = { px, py };
    req.moveBudget = moveBudget;
    req.frameMs    = Clamp(dt * 1000.f, 1.f, 250.f);
    req.sensors    = Sensors::Build(px, py, settings);
    const bool autopilot = settings.mode == static_cast<int>(Mode::Autopilot);
    bool apHasTarget = false;
    Vec2 apTargetPos{};
    req.intentDir  = autopilot ? AutopilotIntent(req.sensors, req.player, settings.followLantern, settings.standOnType, apHasTarget, apTargetPos)
                               : (steer.active ? Vec2{ steer.dirX, steer.dirY } : Vec2{});

    if (req.sensors.projectileSourceUnavailable) {
        ResetCommit();
        if (settings.debugOverlay) {
            DebugSnapshot d{};
            d.status = FrameStatus::SensorLimited;
            d.player = req.player;
            d.sensors = req.sensors;
            PublishDebug(d);
        }
        return;
    }

    const PlanResult plan = Planner::Evaluate(req);

    Vec2 moveTarget = plan.target;
    FrameStatus status = plan.status;
    if (!plan.shouldMove) ResetCommit();

    if (plan.shouldMove) {
        moveTarget = ResolveMoveTarget(req.player, plan.target, moveBudget, req.frameMs, settings, req.sensors);
        // CCD-exact tight commit — shorten the step if the full move would graze.
        moveTarget = Commit::Refine(req.player, moveTarget, settings, req.sensors, moveBudget, req.frameMs);
        if (!DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y))
            status = FrameStatus::MovementFailed;
    }

    if (settings.debugOverlay) {
        DebugSnapshot d{};
        d.status = status;
        d.player = req.player;
        d.intentDir = req.intentDir;
        d.intendedTarget = { px + req.intentDir.x * moveBudget, py + req.intentDir.y * moveBudget };
        d.slideDir = plan.slideDir;
        d.selectedTarget = moveTarget;
        d.hasSelectedTarget = plan.shouldMove;
        d.sensors = req.sensors;
        d.hasLockTarget = apHasTarget;
        d.lockTarget = apTargetPos;
        d.candidateCount = std::min(plan.candidateCount, kMaxCandidates);
        for (int i = 0; i < d.candidateCount; ++i) d.candidates[i] = plan.candidates[i];
        PublishDebug(d);
    }
}

void RenderSettings()
{
    float react   = GetReactWindowMs();
    float maxMove = GetMaxMoveTiles();
    float hitScale = GetHitScale();
    float danger  = GetDangerWeight();
    int   mode    = GetMode();
    bool  avoid   = GetAvoidHazards();
    bool  debug   = GetDebugOverlay();

    if (ImGui::SliderFloat("React window ms##repp", &react, 100.f, 2500.f)) SetReactWindowMs(react);
    if (ImGui::SliderFloat("Max assist tiles##repp", &maxMove, 0.2f, 4.f)) SetMaxMoveTiles(maxMove);
    if (ImGui::SliderFloat("Hit scale##repp", &hitScale, 0.5f, 2.f)) SetHitScale(hitScale);
    if (ImGui::SliderFloat("Danger weight (lower=tighter)##repp", &danger, 0.f, 5.f)) SetDangerWeight(danger);

    const char* modeLabels[] = { "Assist", "Autopilot" };
    int modeIdx = ClampInt(mode, 0, 1);
    if (ImGui::Combo("Mode##repp", &modeIdx, modeLabels, IM_ARRAYSIZE(modeLabels))) SetMode(modeIdx);

    if (ImGui::Checkbox("Avoid hazards (damaging ground)##repp", &avoid)) SetAvoidHazards(avoid);
    if (ImGui::Checkbox("Debug overlay##repp", &debug)) SetDebugOverlay(debug);

    bool followLantern = GetFollowLantern();
    if (ImGui::Checkbox("Autopilot: follow stand-on object (perf cost)##repp", &followLantern)) SetFollowLantern(followLantern);
    int standOn = GetStandOnType();
    if (ImGui::InputInt("Autopilot stand-on objType (0=off)##repp", &standOn)) SetStandOnType(standOn);
}

void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!IsEnabled() || !GetDebugOverlay()) return;
    DebugSnapshot snap;
    { std::lock_guard<std::mutex> lock(g_debugMutex); snap = DebugSlot(); }
    Debug::Render(snap, ReadSettings(), camX, camY, angle, zoom, cx, cy);
}

void SetReactWindowMs(float ms) { g_reactWindowMs.store(Clamp(ms, 100.f, 2500.f), std::memory_order_relaxed); }
float GetReactWindowMs() { return g_reactWindowMs.load(std::memory_order_relaxed); }
void SetMaxMoveTiles(float tiles) { g_maxMoveTiles.store(Clamp(tiles, 0.2f, 4.f), std::memory_order_relaxed); }
float GetMaxMoveTiles() { return g_maxMoveTiles.load(std::memory_order_relaxed); }
void SetHitScale(float s) { g_hitScale.store(Clamp(s, 0.5f, 2.f), std::memory_order_relaxed); }
float GetHitScale() { return g_hitScale.load(std::memory_order_relaxed); }
void SetDangerWeight(float v) { g_dangerWeight.store(Clamp(v, 0.f, 5.f), std::memory_order_relaxed); }
float GetDangerWeight() { return g_dangerWeight.load(std::memory_order_relaxed); }
void SetMode(int mode) { g_mode.store(ClampInt(mode, 0, 1), std::memory_order_relaxed); }
int GetMode() { return g_mode.load(std::memory_order_relaxed); }
void SetAvoidHazards(bool en) { g_avoidHazards.store(en, std::memory_order_relaxed); }
bool GetAvoidHazards() { return g_avoidHazards.load(std::memory_order_relaxed); }
void SetDebugOverlay(bool en) { g_debugOverlay.store(en, std::memory_order_relaxed); }
bool GetDebugOverlay() { return g_debugOverlay.load(std::memory_order_relaxed); }
void SetFollowLantern(bool en) { g_followLantern.store(en, std::memory_order_relaxed); }
bool GetFollowLantern() { return g_followLantern.load(std::memory_order_relaxed); }
void SetStandOnType(int t) { g_standOnType.store(t, std::memory_order_relaxed); }
int  GetStandOnType() { return g_standOnType.load(std::memory_order_relaxed); }

} // namespace RePP

