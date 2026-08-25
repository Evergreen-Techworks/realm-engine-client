#include "pch-il2cpp.h"
#include "ZDodge.h"

#include "ZDodgeDebug.h"
#include "ZDodgePlanner.h"
#include "ZDodgeSensors.h"

#include "MovementRuntime.h"
#include "ProjectileTracking.h"
#include "SteerInput.h"
#include "ZDodgeTarget.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/TestTAB.h"

#include <imgui/imgui.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>

namespace ZDodge {
namespace {

std::atomic<bool> g_enabled{ false };
std::atomic<float> g_reactWindowMs{ 1200.f };
std::atomic<float> g_maxMoveTiles{ 0.55f };
std::atomic<float> g_playerRadius{ 0.05f };
std::atomic<float> g_projectileHitScale{ 0.9f };
std::atomic<float> g_projectileRadiusFallback{ 0.02f };
std::atomic<float> g_damageThresholdPct{ 0.f };
std::atomic<float> g_clearanceTiles{ 0.03f };
std::atomic<float> g_sampleStepMs{ 40.f };
std::atomic<float> g_perpWeight{ 6.0f };
std::atomic<float> g_intentWeight{ 2.5f };
std::atomic<float> g_clearanceWeight{ 1.5f };
std::atomic<float> g_backpedalPenalty{ 3.0f };
std::atomic<float> g_enemyAvoidanceRadius{ 2.0f };
std::atomic<bool> g_debugOverlay{ true };
std::atomic<bool> g_candidateOverlay{ true };
std::mutex g_debugMutex;

// Heap-backed on purpose: as a plain global, MSVC (LTCG) placed this 45 KB
// constant-initialized blob in read-only .rdata while the identical snapshots in
// RePP/PJDodge landed in .data, so PublishDebug's memcpy access-violated on the
// first byte. Runtime-allocated storage cannot be const-promoted. Intentionally
// never freed — the render thread may publish during DLL unload.
DebugSnapshot& DebugSlot()
{
    static DebugSnapshot* const slot = new DebugSnapshot();
    return *slot;
}
constexpr uint64_t kCommitDwellMs = 250;
constexpr float kSharpFlipDot = -0.15f;
bool g_haveCommittedDir = false;
Vec2 g_committedDir{};
uint64_t g_lastCommitMs = 0;

float Clamp(float value, float lo, float hi)
{
    if (!std::isfinite(value)) return lo;
    return std::clamp(value, lo, hi);
}

Settings ReadSettings()
{
    Settings s{};
    s.reactWindowMs = Clamp(g_reactWindowMs.load(std::memory_order_relaxed), 100.f, 2500.f);
    s.maxMoveTiles = Clamp(g_maxMoveTiles.load(std::memory_order_relaxed), 0.2f, 4.f);
    s.playerRadius = Clamp(g_playerRadius.load(std::memory_order_relaxed), 0.f, 1.f);
    s.projectileHitScale = Clamp(g_projectileHitScale.load(std::memory_order_relaxed), 0.f, 3.f);
    s.projectileRadiusFallback = Clamp(g_projectileRadiusFallback.load(std::memory_order_relaxed), 0.f, 1.f);
    s.damageThresholdPct = Clamp(g_damageThresholdPct.load(std::memory_order_relaxed), 0.f, 1.f);
    s.clearanceTiles = Clamp(g_clearanceTiles.load(std::memory_order_relaxed), 0.f, 1.f);
    s.sampleStepMs = Clamp(g_sampleStepMs.load(std::memory_order_relaxed), 8.f, 100.f);
    s.perpWeight = Clamp(g_perpWeight.load(std::memory_order_relaxed), 0.f, 10.f);
    s.intentWeight = Clamp(g_intentWeight.load(std::memory_order_relaxed), 0.f, 10.f);
    s.clearanceWeight = Clamp(g_clearanceWeight.load(std::memory_order_relaxed), 0.f, 5.f);
    s.backpedalPenalty = Clamp(g_backpedalPenalty.load(std::memory_order_relaxed), 0.f, 10.f);
    s.enemyAvoidanceRadius = Clamp(g_enemyAvoidanceRadius.load(std::memory_order_relaxed), 0.f, 3.f);
    s.debugOverlay = g_debugOverlay.load(std::memory_order_relaxed);
    s.candidateOverlay = g_candidateOverlay.load(std::memory_order_relaxed);
    return s;
}

float MoveBudget(float tilesPerSec, float dt, float maxMoveTiles)
{
    if (!std::isfinite(tilesPerSec) || tilesPerSec < 0.f) tilesPerSec = 0.f;
    if (!std::isfinite(dt) || dt < 0.f) dt = 0.f;
    return std::min(maxMoveTiles, std::max(0.02f, tilesPerSec * dt));
}

float Dot(Vec2 a, Vec2 b) { return a.x * b.x + a.y * b.y; }
float LenSq(Vec2 v) { return Dot(v, v); }
float Len(Vec2 v) { return std::sqrt(LenSq(v)); }
Vec2 Add(Vec2 a, Vec2 b) { return { a.x + b.x, a.y + b.y }; }
Vec2 Sub(Vec2 a, Vec2 b) { return { a.x - b.x, a.y - b.y }; }
Vec2 Mul(Vec2 v, float s) { return { v.x * s, v.y * s }; }

Vec2 Normalize(Vec2 v)
{
    const float n = Len(v);
    return n > 0.0001f ? Mul(v, 1.f / n) : Vec2{};
}

void ResetCommit()
{
    g_haveCommittedDir = false;
    g_committedDir = {};
    g_lastCommitMs = 0;
}

Vec2 ResolveMoveTarget(Vec2 player, Vec2 target, float moveBudget, float frameMs, const Settings& settings, const SensorSnapshot& sensors)
{
    const Vec2 desired = Sub(target, player);
    const float dist = Len(desired);
    if (dist <= 0.0001f || moveBudget <= 0.f) return player;

    Vec2 dir = Mul(desired, 1.f / dist);
    const uint64_t now = GetTickCount64();
    if (g_haveCommittedDir && (now - g_lastCommitMs) < kCommitDwellMs && Dot(dir, g_committedDir) < kSharpFlipDot) {
        const Vec2 heldTarget = Add(player, Mul(g_committedDir, moveBudget));
        if (Planner::IsSweepSafe(player, heldTarget, settings, sensors, frameMs))
            dir = g_committedDir;
    }

    const Vec2 moveTarget = Add(player, Mul(dir, std::min(moveBudget, dist)));
    g_committedDir = dir;
    g_haveCommittedDir = true;
    g_lastCommitMs = now;
    return moveTarget;
}

void PublishDebug(const DebugSnapshot& snapshot)
{
    std::lock_guard<std::mutex> lock(g_debugMutex);
    DebugSlot() = snapshot;
}

DebugSnapshot ReadDebugSnapshot()
{
    std::lock_guard<std::mutex> lock(g_debugMutex);
    return DebugSlot();
}

void PublishStatus(FrameStatus status)
{
    if (!IsEnabled()) return;
    auto snapshot = std::make_unique<DebugSnapshot>();
    snapshot->status = status;
    PublishDebug(*snapshot);
}

void ApplyDamageThreshold(SensorSnapshot& sensors, int32_t maxHp, float damageThresholdPct)
{
    if (maxHp <= 0 || damageThresholdPct <= 0.f) return;
    const float minDamage = static_cast<float>(maxHp) * damageThresholdPct;
    int kept = 0;
    for (int i = 0; i < std::min(sensors.threatCount, kMaxThreats); ++i) {
        if (sensors.threats[i].damage < minDamage) continue;
        if (kept != i) sensors.threats[kept] = sensors.threats[i];
        ++kept;
    }
    sensors.threatCount = kept;
}

} // namespace

void SetEnabled(bool enabled)
{
    if (enabled) ProjectileTracking::Install();
    g_enabled.store(enabled, std::memory_order_relaxed);
    if (!enabled) {
        ResetCommit();
        auto snapshot = std::make_unique<DebugSnapshot>();
        PublishDebug(*snapshot);
    }
}
bool IsEnabled() { return g_enabled.load(std::memory_order_relaxed); }
void OnEnter()
{
    ProjectileTracking::Install();
    ResetCommit();
    auto snapshot = std::make_unique<DebugSnapshot>();
    PublishDebug(*snapshot);
}

void Tick(void* player, float px, float py, float dt)
{
    if (!IsEnabled()) return;
    if (!player || !std::isfinite(px) || !std::isfinite(py)) { PublishStatus(FrameStatus::NoPlayer); return; }
    if (!DodgeRuntime::EnsureResolved()) { PublishStatus(FrameStatus::MovementFailed); return; }

    SteerInput::Tick();
    const SteerInput::SteerState steer = SteerInput::Get();
    const Settings settings = ReadSettings();

    int32_t hp = 0;
    int32_t maxHp = 0;
    float spd = 0.f;
    float tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);
    const float moveBudget = MoveBudget(tilesPerSec, dt, settings.maxMoveTiles);

    PlanRequest req{};
    req.settings  = settings;
    req.player    = { px, py };
    req.moveBudget = moveBudget;
    req.frameMs   = Clamp(dt * 1000.f, 1.f, 250.f);

    // Build sensors before deciding intent so threat state informs movement.
    req.sensors = Sensors::Build(px, py, settings);
    ApplyDamageThreshold(req.sensors, maxHp, settings.damageThresholdPct);

    // ── Target range-keeping intent ───────────────────────────────────────────
    // Only active when no threats are present so dodge behaviour is completely
    // unaffected when bullets are incoming.  When threats exist the player's
    // WASD intent drives the planner as normal.
    Vec2 steerIntent = steer.active ? Vec2{ steer.dirX, steer.dirY } : Vec2{};
    if (Target::HasTarget() && req.sensors.threatCount == 0) {
        float tx = 0.f, ty = 0.f;
        if (WorldTAB::GetEntityLivePos(Target::GetId(), tx, ty)) {
            const float weaponRange = std::clamp(
                AutoAim::IsProjRangeResolved() ? AutoAim::GetProjRangeTiles() : 6.f,
                2.f, 16.f);
            const float desired = weaponRange * 0.85f;
            const float dx = tx - px;
            const float dy = ty - py;
            const float dist = std::sqrt(dx * dx + dy * dy);
            if (dist > 0.001f) {
                const float invDist = 1.f / dist;
                if (dist > desired + 0.5f)       // too far  → close in
                    steerIntent = { dx * invDist, dy * invDist };
                else if (dist < desired - 0.5f)  // too close → back off
                    steerIntent = { -dx * invDist, -dy * invDist };
            }
        } else {
            Target::Clear();
        }
    }
    req.intentDir = steerIntent;

    if (req.sensors.projectileSourceUnavailable) {
        ResetCommit();
        if (settings.debugOverlay && IsEnabled()) {
            DebugSnapshot debug{};
            debug.status = FrameStatus::SensorLimited;
            debug.player = req.player;
            debug.intentDir = req.intentDir;
            debug.intendedTarget = { px + req.intentDir.x * moveBudget, py + req.intentDir.y * moveBudget };
            debug.sensors = req.sensors;
            PublishDebug(debug);
        }
        return;
    }

    const PlanResult plan = Planner::Evaluate(req);

    Vec2 moveTarget = plan.target;
    FrameStatus status = plan.status;
    if (!plan.shouldMove) ResetCommit();
    if (status == FrameStatus::NoThreats && (req.sensors.projectileLimited || req.sensors.aoeLimited || req.sensors.blockerLimited))
        status = FrameStatus::SensorLimited;

    if (plan.shouldMove) {
        moveTarget = ResolveMoveTarget(req.player, plan.target, moveBudget, req.frameMs, settings, req.sensors);
        if (!DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y))
            status = FrameStatus::MovementFailed;
    }

    if (settings.debugOverlay && IsEnabled()) {
        auto debug = std::make_unique<DebugSnapshot>();
        debug->status = status;
        debug->player = req.player;
        debug->intentDir = req.intentDir;
        debug->intendedTarget = { px + req.intentDir.x * moveBudget, py + req.intentDir.y * moveBudget };
        debug->slideDir = plan.slideDir;
        debug->selectedTarget = moveTarget;
        debug->hasSelectedTarget = plan.shouldMove;
        debug->sensors = req.sensors;
        debug->candidateCount = settings.candidateOverlay ? std::min(plan.candidateCount, kMaxCandidates) : 0;
        for (int i = 0; i < debug->candidateCount; ++i) debug->candidates[i] = plan.candidates[i];
        PublishDebug(*debug);
    }
}

void RenderSettings()
{
    float react = GetReactWindowMs();
    float maxMove = GetMaxMoveTiles();
    float playerRadius = GetPlayerRadius();
    float hitScale = GetProjectileHitScale();
    float projRadius = GetProjectileRadiusFallback();
    float clearance = GetClearanceTiles();
    float sampleStep = GetSampleStepMs();
    float perpWeight = GetPerpWeight();
    float intentWeight = GetIntentWeight();
    float clearanceWeight = GetClearanceWeight();
    float backpedal = GetBackpedalPenalty();
    float enemyAvoidance = GetEnemyAvoidanceRadius();
    float dmg = GetDamageThresholdPct();
    bool debug = GetDebugOverlay();
    bool candidates = GetCandidateOverlay();
    if (ImGui::SliderFloat("React window ms##zdodge", &react, 100.f, 2500.f)) SetReactWindowMs(react);
    if (ImGui::SliderFloat("Max assist tiles##zdodge", &maxMove, 0.2f, 4.f)) SetMaxMoveTiles(maxMove);
    if (ImGui::SliderFloat("Player radius##zdodge", &playerRadius, 0.f, 1.f)) SetPlayerRadius(playerRadius);
    if (ImGui::SliderFloat("Projectile hit scale##zdodge", &hitScale, 0.f, 3.f)) SetProjectileHitScale(hitScale);
    if (ImGui::SliderFloat("Projectile fallback radius##zdodge", &projRadius, 0.f, 1.f)) SetProjectileRadiusFallback(projRadius);
    if (ImGui::SliderFloat("Clearance tiles##zdodge", &clearance, 0.f, 1.f)) SetClearanceTiles(clearance);
    if (ImGui::SliderFloat("Sample step ms##zdodge", &sampleStep, 8.f, 100.f)) SetSampleStepMs(sampleStep);
    if (ImGui::SliderFloat("Perpendicular weight##zdodge", &perpWeight, 0.f, 10.f)) SetPerpWeight(perpWeight);
    if (ImGui::SliderFloat("Intent weight##zdodge", &intentWeight, 0.f, 10.f)) SetIntentWeight(intentWeight);
    if (ImGui::SliderFloat("Clearance weight##zdodge", &clearanceWeight, 0.f, 5.f)) SetClearanceWeight(clearanceWeight);
    if (ImGui::SliderFloat("Backpedal penalty##zdodge", &backpedal, 0.f, 10.f)) SetBackpedalPenalty(backpedal);
    if (ImGui::SliderFloat("Enemy no-go radius##zdodge", &enemyAvoidance, 0.f, 3.f)) SetEnemyAvoidanceRadius(enemyAvoidance);
    if (ImGui::SliderFloat("Damage threshold (0.01=1%)##zdodge", &dmg, 0.f, 1.f, "%.2f")) SetDamageThresholdPct(dmg);
    if (ImGui::Checkbox("Debug overlay##zdodge", &debug)) SetDebugOverlay(debug);
    if (ImGui::Checkbox("Candidate overlay##zdodge", &candidates)) SetCandidateOverlay(candidates);
}

void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!GetDebugOverlay() || !IsEnabled()) return;
    const DebugSnapshot snapshot = ReadDebugSnapshot();
    Debug::Render(snapshot, ReadSettings(), camX, camY, angle, zoom, cx, cy);
}

void SetReactWindowMs(float ms) { g_reactWindowMs.store(Clamp(ms, 100.f, 2500.f), std::memory_order_relaxed); }
float GetReactWindowMs() { return g_reactWindowMs.load(std::memory_order_relaxed); }
void SetMaxMoveTiles(float tiles) { g_maxMoveTiles.store(Clamp(tiles, 0.2f, 4.f), std::memory_order_relaxed); }
float GetMaxMoveTiles() { return g_maxMoveTiles.load(std::memory_order_relaxed); }
void SetPlayerRadius(float radius) { g_playerRadius.store(Clamp(radius, 0.f, 1.f), std::memory_order_relaxed); }
float GetPlayerRadius() { return g_playerRadius.load(std::memory_order_relaxed); }
void SetProjectileHitScale(float scale) { g_projectileHitScale.store(Clamp(scale, 0.f, 3.f), std::memory_order_relaxed); }
float GetProjectileHitScale() { return g_projectileHitScale.load(std::memory_order_relaxed); }
void SetProjectileRadiusFallback(float radius) { g_projectileRadiusFallback.store(Clamp(radius, 0.f, 1.f), std::memory_order_relaxed); }
float GetProjectileRadiusFallback() { return g_projectileRadiusFallback.load(std::memory_order_relaxed); }
void SetClearanceTiles(float tiles) { g_clearanceTiles.store(Clamp(tiles, 0.f, 1.f), std::memory_order_relaxed); }
float GetClearanceTiles() { return g_clearanceTiles.load(std::memory_order_relaxed); }
void SetSampleStepMs(float ms) { g_sampleStepMs.store(Clamp(ms, 8.f, 100.f), std::memory_order_relaxed); }
float GetSampleStepMs() { return g_sampleStepMs.load(std::memory_order_relaxed); }
void SetPerpWeight(float weight) { g_perpWeight.store(Clamp(weight, 0.f, 10.f), std::memory_order_relaxed); }
float GetPerpWeight() { return g_perpWeight.load(std::memory_order_relaxed); }
void SetIntentWeight(float weight) { g_intentWeight.store(Clamp(weight, 0.f, 10.f), std::memory_order_relaxed); }
float GetIntentWeight() { return g_intentWeight.load(std::memory_order_relaxed); }
void SetClearanceWeight(float weight) { g_clearanceWeight.store(Clamp(weight, 0.f, 5.f), std::memory_order_relaxed); }
float GetClearanceWeight() { return g_clearanceWeight.load(std::memory_order_relaxed); }
void SetBackpedalPenalty(float weight) { g_backpedalPenalty.store(Clamp(weight, 0.f, 10.f), std::memory_order_relaxed); }
float GetBackpedalPenalty() { return g_backpedalPenalty.load(std::memory_order_relaxed); }
void SetEnemyAvoidanceRadius(float radius) { g_enemyAvoidanceRadius.store(Clamp(radius, 0.f, 3.f), std::memory_order_relaxed); }
float GetEnemyAvoidanceRadius() { return g_enemyAvoidanceRadius.load(std::memory_order_relaxed); }
void SetDamageThresholdPct(float pct) { g_damageThresholdPct.store(Clamp(pct, 0.f, 1.f), std::memory_order_relaxed); }
float GetDamageThresholdPct() { return g_damageThresholdPct.load(std::memory_order_relaxed); }
void SetDebugOverlay(bool enabled) { g_debugOverlay.store(enabled, std::memory_order_relaxed); }
bool GetDebugOverlay() { return g_debugOverlay.load(std::memory_order_relaxed); }
void SetCandidateOverlay(bool enabled) { g_candidateOverlay.store(enabled, std::memory_order_relaxed); }
bool GetCandidateOverlay() { return g_candidateOverlay.load(std::memory_order_relaxed); }

} // namespace ZDodge