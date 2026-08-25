#include "pch-il2cpp.h"
#include "RolloutDodge.h"
#include "ThreatIndex.h"
#include "GridThreatIndex.h"
#include "QuadtreeThreatIndex.h"
#include "DodgeHit.h"
#include "DodgeSpeed.h"
#include "DangerPlanner.h"
#include "ProjectileTracking.h"
#include "features/combat/autoaim/modes/AutoAim.h"
#include "gui/tabs/TestTAB.h"
#include "gui/tabs/WorldTAB.h"
#include "DbgFileLog.h"

#include <imgui/imgui.h>
#include "W2S.h"
#include <algorithm>
#include <atomic>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>
#include <windows.h>

// ─────────────────────────────────────────────────────────────────────────────
// RolloutDodge — per-input forward simulation with a broad-phase over predicted
// bullet trajectories. See RolloutDodge.h for the design narrative.
// ─────────────────────────────────────────────────────────────────────────────

namespace {

using Threats::Threat;
using Threats::Aabb;
using Threats::ThreatIndex;
using Threats::BruteForceIndex;
using Threats::GridThreatIndex;
using Threats::QuadtreeThreatIndex;
using Threats::kMaxThreatSamples;

// ── Constants ────────────────────────────────────────────────────────────────
constexpr float kTickMs          = 200.f;   // server tick (~5 Hz)
constexpr float kCcdPad          = 0.03f;   // command-latency hair (tiles)
constexpr float kEnemyContactHalf = 0.5f;   // matches XDodge enemy-body stamp
constexpr int   kMaxThreats      = 256;     // swarm cap (perf guardrail)
constexpr float kCullRadius      = 18.f;    // tiles: pre-cull bullets beyond this
constexpr int   kGridThreshold   = 48;      // threats >= this ⇒ grid broad-phase
constexpr int   kMaxHeadings     = 24;      // upper bound for the input fan
constexpr float kGoalDeadzone    = 0.6f;    // tiles: at-goal ⇒ prefer Hold
constexpr float kWallProbeStep   = 0.2f;    // tiles between wall march samples
constexpr float kWallProbeMax    = 8.0f;    // tiles: cache reach out to here
                                            // (caps simulated travel — beyond
                                            // this, prediction drift dominates)
constexpr uint64_t kWallRefreshMs = 500;    // wall-reach re-probe (doors etc.)
constexpr uint64_t kCommitDwellMs = 250;    // hold heading before a sharp flip
constexpr float kImminentMs      = 150.f;   // τ below this ⇒ override dwell

// ── Enabled + tunables ───────────────────────────────────────────────────────
bool  g_enabled = false;
std::atomic<float> g_horizonTicks { 4.0f };
std::atomic<float> g_sampleStepMs { 25.0f };
std::atomic<int>   g_headingCount { 16 };
std::atomic<float> g_hitScale     { 1.0f };
std::atomic<float> g_intentWeight { 1.0f };
std::atomic<int>   g_rebuildN     { 2 };
std::atomic<int>   g_broadPhase   { 0 };    // 0=Auto 1=Brute 2=Grid 3=Quad
std::atomic<bool>  g_avoidEnemies { true };
std::atomic<bool>  g_wasdYield    { true };
std::atomic<bool>  g_commitDwell  { true };
std::atomic<bool>  g_drawPath     { false };

// ── Per-rebuild state ────────────────────────────────────────────────────────
std::vector<Threat> g_threats;
BruteForceIndex     g_brute;
GridThreatIndex     g_grid;
QuadtreeThreatIndex g_quad;
DodgeSpeed::ObsSpeed g_obs;

int      g_frameCount = 0;
std::atomic<bool> g_newProjSinceRebuild { false };

// Committed plan (set on rebuild, issued every frame).
bool  g_havePlan = false;
float g_dirX = 0.f, g_dirY = 0.f;   // unit heading; (0,0) = Hold

// Commit-dwell memory.
int      g_lastSgnX = 0, g_lastSgnY = 0;
uint64_t g_lastStepMs = 0;

// Wall-reach cache: max walkable distance along each heading, keyed on the
// player's tile (walls are static) + a slow refresh. Mirrors XDodge's
// walkability-cache discipline so we don't spam IsWalkPositionBlocked.
int      g_wallCellX = INT_MIN, g_wallCellY = INT_MIN;
int      g_wallN     = 0;
uint64_t g_wallMs    = 0;
float    g_wallReach[kMaxHeadings] = { 0.f };

// ── Debug snapshot (overlay only) ────────────────────────────────────────────
struct VizInput { float dirX, dirY, reach, tau; bool chosen; };
VizInput g_viz[kMaxHeadings + 1];
int      g_vizN = 0;
float    g_lastTau = 0.f;
const char* g_lastBackend = "brute";
int      g_lastThreatCount = 0;

void OnHazardSpawn(const WorldProjectile& /*p*/, void* /*u*/)
{
    g_newProjSinceRebuild.store(true, std::memory_order_relaxed);
}

bool ManualMoveHeld()
{
    if (!g_wasdYield.load(std::memory_order_relaxed)) return false;
    auto down = [](int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; };
    return down('W') || down('A') || down('S') || down('D')
        || down(VK_LEFT) || down(VK_RIGHT) || down(VK_UP) || down(VK_DOWN);
}

// Effective sample count for the current horizon/step (clamped to the cache).
int SampleCount()
{
    const float horizonMs = g_horizonTicks.load(std::memory_order_relaxed) * kTickMs;
    const float step      = std::max(1.f, g_sampleStepMs.load(std::memory_order_relaxed));
    int k = static_cast<int>(horizonMs / step) + 1;
    if (k < 2) k = 2;
    if (k > kMaxThreatSamples) k = kMaxThreatSamples;
    return k;
}

// ── Build the threat set: sample each bullet's trajectory + swept AABB ────────
void BuildThreats(const std::vector<WorldProjectile>& projs, float px, float py)
{
    g_threats.clear();
    const int   K       = SampleCount();
    const float step    = std::max(1.f, g_sampleStepMs.load(std::memory_order_relaxed));
    const float scale   = g_hitScale.load(std::memory_order_relaxed);
    const uint64_t nowMs = GetTickCount64();

    for (const auto& b : projs) {
        if (!b.valid) continue;
        if (static_cast<int>(g_threats.size()) >= kMaxThreats) break;

        // Pre-cull: a bullet far from the player can't reach the reachable
        // region within the horizon — skip it before the costly trajectory
        // sampling. This is the real perf win; the broad-phase is secondary.
        const float dxp = b.x - px, dyp = b.y - py;
        if (dxp * dxp + dyp * dyp > kCullRadius * kCullRadius) continue;

        const float half = DodgeHit::EffectiveHalf(b, scale, kCcdPad);
        if (half <= 0.f) continue;

        const float elapsed = static_cast<float>(nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);

        Threat t;
        t.bulletIdx = static_cast<int>(&b - &projs[0]);
        t.half      = half;
        int n = 0;
        float lo_x = 0, lo_y = 0, hi_x = 0, hi_y = 0;
        for (int k = 0; k < K; ++k) {
            const float tMs = elapsed + static_cast<float>(k) * step;
            if (b.lifetime > 0.f && tMs >= b.lifetime) break;     // expired
            float bx, by;
            if (k == 0) { bx = b.x; by = b.y; }                   // live position now
            else {
                ProjectileTracking::ComputePosAtSafe(b, tMs, bx, by);
                if (!std::isfinite(bx) || !std::isfinite(by)) break;
            }
            t.cx[k] = bx; t.cy[k] = by;
            if (n == 0) { lo_x = hi_x = bx; lo_y = hi_y = by; }
            else { lo_x = std::min(lo_x, bx); hi_x = std::max(hi_x, bx);
                   lo_y = std::min(lo_y, by); hi_y = std::max(hi_y, by); }
            ++n;
        }
        if (n < 1) continue;
        t.nSamples = n;
        t.box = { lo_x - half, lo_y - half, hi_x + half, hi_y + half };
        g_threats.push_back(t);
    }

    // ── Enemy bodies (contact damage) as static, full-horizon threats ─────────
    if (g_avoidEnemies.load(std::memory_order_relaxed)) {
        struct Ctx { int K; } ctx{ K };
        AutoAim::EnumerateLiveEnemies(
            [](float ex, float ey, int32_t /*eid*/, void* u) {
                auto* k = static_cast<Ctx*>(u);
                if (static_cast<int>(g_threats.size()) >= kMaxThreats) return;
                const float half = kEnemyContactHalf + DodgeHit::kPlayerHalf;
                Threat t;
                t.bulletIdx = -1;
                t.half      = half;
                t.nSamples  = k->K;
                for (int i = 0; i < k->K; ++i) { t.cx[i] = ex; t.cy[i] = ey; }
                t.box = { ex - half, ey - half, ex + half, ey + half };
                g_threats.push_back(t);
            }, &ctx);
    }
}

// ── Wall-reach cache: max walkable distance along each candidate heading ──────
void RefreshWallReach(float px, float py, int nHead, const float* dirX, const float* dirY)
{
    const int cellX = static_cast<int>(std::floor(px));
    const int cellY = static_cast<int>(std::floor(py));
    const uint64_t now = GetTickCount64();
    const bool stale = (cellX != g_wallCellX) || (cellY != g_wallCellY)
                     || (nHead != g_wallN) || ((now - g_wallMs) >= kWallRefreshMs);
    if (!stale) return;

    for (int i = 0; i < nHead; ++i) {
        float reach = kWallProbeMax;
        for (float s = kWallProbeStep; s <= kWallProbeMax; s += kWallProbeStep) {
            const float wx = px + dirX[i] * s;
            const float wy = py + dirY[i] * s;
            if (TestTAB::IsWalkPositionBlocked(wx, wy)) { reach = s - kWallProbeStep; break; }
        }
        g_wallReach[i] = std::max(0.f, reach);
    }
    g_wallCellX = cellX; g_wallCellY = cellY; g_wallN = nHead; g_wallMs = now;
}

// ── Rollout one input: earliest time-to-collision (ms), horizon if none ───────
float RolloutInput(float px, float py, float dirX, float dirY, float reach,
                   float speed, const ThreatIndex* index,
                   std::vector<int>& candScratch)
{
    const int   K    = SampleCount();
    const float step = std::max(1.f, g_sampleStepMs.load(std::memory_order_relaxed));
    const float horizonMs = static_cast<float>(K - 1) * step;

    // End of the player's swept path of CENTERS (wall-clamped). Threat boxes are
    // already inflated by the collision half, so the query box is the raw center
    // path — overlap with a threat box == "player center could be hit here".
    const float travel = std::min(speed * horizonMs / 1000.f, reach);
    const float ex = px + dirX * travel;
    const float ey = py + dirY * travel;
    Aabb q{ std::min(px, ex), std::min(py, ey), std::max(px, ex), std::max(py, ey) };

    candScratch.clear();
    index->Query(q, candScratch);
    if (candScratch.empty()) return horizonMs;   // nothing on this path → safe

    for (int k = 0; k < K; ++k) {
        const float tMs = static_cast<float>(k) * step;
        const float d   = std::min(speed * tMs / 1000.f, reach);
        const float plx = px + dirX * d;
        const float ply = py + dirY * d;
        for (int ci : candScratch) {
            const Threat& t = g_threats[ci];
            if (k >= t.nSamples) continue;
            if (DodgeGeometry::InProjAabb(t.cx[k], t.cy[k], plx, ply, t.half))
                return tMs;                       // first collision on this input
        }
    }
    return horizonMs;                             // survived the whole horizon
}

ThreatIndex* ChooseIndex(int threatCount)
{
    // Broad-phase selector (A/B). Explicit Brute / Grid / Quad pin a backend;
    // Auto uses the uniform grid when the field is dense, else the brute-force
    // AABB scan (the always-correct reference).
    switch (g_broadPhase.load(std::memory_order_relaxed)) {
        case 1: g_lastBackend = "brute"; return &g_brute;
        case 2: g_lastBackend = "grid";  return &g_grid;
        case 3: g_lastBackend = "quad";  return &g_quad;
        default: break;   // Auto
    }
    if (threatCount >= kGridThreshold) { g_lastBackend = "grid"; return &g_grid; }
    g_lastBackend = "brute"; return &g_brute;
}

// ── The planner: pick the best input this rebuild ─────────────────────────────
void Replan(float px, float py)
{
    const int   nHead   = std::clamp(g_headingCount.load(std::memory_order_relaxed), 8, kMaxHeadings);
    const float speed   = g_obs.spd;
    const float intentW = g_intentWeight.load(std::memory_order_relaxed);

    // Candidate headings (unit vectors). Index 0..nHead-1 are headings; Hold is
    // handled separately (no motion).
    float hdX[kMaxHeadings], hdY[kMaxHeadings];
    for (int i = 0; i < nHead; ++i) {
        const float a = (6.28318530718f * static_cast<float>(i)) / static_cast<float>(nHead);
        hdX[i] = std::cos(a);
        hdY[i] = std::sin(a);
    }
    RefreshWallReach(px, py, nHead, hdX, hdY);

    // Strategic intent: the shared external goal (also fed by enemy-lock standoff
    // via ResolveEnemyLock). Aligns equally-safe inputs toward where we want to be.
    float gX = 0.f, gY = 0.f;
    bool hasGoal = DangerPlanner::GetExternalGoal(gX, gY);
    float goalDist = 0.f, gnx = 0.f, gny = 0.f;
    if (hasGoal) {
        const float dx = gX - px, dy = gY - py;
        goalDist = std::sqrt(dx * dx + dy * dy);
        if (goalDist <= kGoalDeadzone) hasGoal = false;          // at goal ⇒ prefer Hold
        else { gnx = dx / goalDist; gny = dy / goalDist; }
    }

    ThreatIndex* index = ChooseIndex(static_cast<int>(g_threats.size()));
    index->Build(g_threats);

    std::vector<int> cand;
    cand.reserve(64);

    auto intentScore = [&](float dx, float dy, bool hold) -> float {
        if (hold) return hasGoal ? 0.f : 1e-3f;   // no goal ⇒ Hold wins ties
        if (!hasGoal) return 0.f;                   // no goal ⇒ headings neutral vs Hold-bias
        return (dx * gnx + dy * gny) * intentW;     // toward goal
    };

    // Evaluate Hold first.
    float bestTau   = RolloutInput(px, py, 0.f, 0.f, 0.f, speed, index, cand);
    float bestScore = intentScore(0.f, 0.f, true);
    float bestDirX = 0.f, bestDirY = 0.f;

    g_vizN = 0;
    const bool draw = g_drawPath.load(std::memory_order_relaxed);
    if (draw) g_viz[g_vizN++] = { 0.f, 0.f, 0.f, bestTau, false };

    for (int i = 0; i < nHead; ++i) {
        const float reach = g_wallReach[i];
        const float tau   = RolloutInput(px, py, hdX[i], hdY[i], reach, speed, index, cand);
        const float sc    = intentScore(hdX[i], hdY[i], false);
        if (draw && g_vizN <= kMaxHeadings)
            g_viz[g_vizN++] = { hdX[i], hdY[i], reach, tau, false };

        // Lexicographic: larger τ wins; equal τ (same sample slice) → larger
        // intent score. τ is already sample-quantized so the compare is exact.
        if (tau > bestTau || (tau == bestTau && sc > bestScore)) {
            bestTau = tau; bestScore = sc; bestDirX = hdX[i]; bestDirY = hdY[i];
        }
    }

    // ── Commit-dwell: resist a sharp reversal unless danger is imminent ───────
    const uint64_t now = GetTickCount64();
    int sgnX = (bestDirX > 0.3f) ? 1 : (bestDirX < -0.3f ? -1 : 0);
    int sgnY = (bestDirY > 0.3f) ? 1 : (bestDirY < -0.3f ? -1 : 0);
    if (g_commitDwell.load(std::memory_order_relaxed) && (bestDirX != 0.f || bestDirY != 0.f)) {
        const bool inDwell  = (now - g_lastStepMs) < kCommitDwellMs;
        const bool hadStep  = (g_lastSgnX != 0 || g_lastSgnY != 0);
        const bool sharpFlip = hadStep && (sgnX * g_lastSgnX + sgnY * g_lastSgnY) < 0;
        const bool imminent = bestTau <= kImminentMs;
        if (inDwell && sharpFlip && !imminent) {
            // Keep the previous heading this rebuild.
            bestDirX = static_cast<float>(g_lastSgnX);
            bestDirY = static_cast<float>(g_lastSgnY);
            const float m = std::sqrt(bestDirX * bestDirX + bestDirY * bestDirY);
            if (m > 1e-3f) { bestDirX /= m; bestDirY /= m; }
            sgnX = g_lastSgnX; sgnY = g_lastSgnY;
        }
    }

    g_havePlan = (bestDirX != 0.f || bestDirY != 0.f);
    g_dirX = bestDirX; g_dirY = bestDirY;
    if (g_havePlan) { g_lastSgnX = sgnX; g_lastSgnY = sgnY; g_lastStepMs = now; }

    // Debug bookkeeping.
    g_lastTau = bestTau;
    g_lastThreatCount = static_cast<int>(g_threats.size());
    if (draw) {
        for (int i = 0; i < g_vizN; ++i)
            g_viz[i].chosen = (g_viz[i].dirX == g_dirX && g_viz[i].dirY == g_dirY);
    }
}

} // namespace

namespace RolloutDodge {

void SetEnabled(bool en)
{
    g_enabled = en;
    if (!en) {
        ProjectileTracking::ClearHazardSpawnCallback();
        g_newProjSinceRebuild.store(false, std::memory_order_relaxed);
        g_havePlan = false;
    }
}
bool IsEnabled() { return g_enabled; }

void OnEnter()
{
    g_havePlan = false;
    g_frameCount = 0;
    g_obs.Reset();
    g_lastSgnX = g_lastSgnY = 0;
    g_wallCellX = g_wallCellY = INT_MIN;
    g_newProjSinceRebuild.store(false, std::memory_order_relaxed);
    ProjectileTracking::RegisterHazardSpawnCallback(OnHazardSpawn, nullptr);
}

void Tick(void* player, float px, float py, float dt)
{
    if (!player || !g_enabled) return;
    ++g_frameCount;

    // Realized-speed EMA (shared estimator). Pure observation of (px,py,dt).
    g_obs.Update(px, py, dt);

    const int  rebuildN = std::clamp(g_rebuildN.load(std::memory_order_relaxed), 1, 10);
    const bool newProj  = g_newProjSinceRebuild.exchange(false, std::memory_order_relaxed);
    if (newProj || (g_frameCount % rebuildN == 0)) {
        std::vector<WorldProjectile> projs;
        ProjectileTracking::CopyActiveForDraw(projs);
        BuildThreats(projs, px, py);
        Replan(px, py);

        static int s_diagN = 0;
        if ((s_diagN++ % 120) == 0)
            DBG_FILE_LOG("[Rollout] rebuild: threats=" << g_threats.size()
                << " backend=" << g_lastBackend
                << " havePlan=" << (int)g_havePlan
                << " tau=" << g_lastTau
                << " dir=(" << g_dirX << "," << g_dirY << ")"
                << " obsSpd=" << g_obs.spd
                << " pos=(" << px << "," << py << ")");
    }

    // Issue movement every frame toward the committed heading (one frame's
    // budget; the server also clamps). Manual WASD yields the wheel.
    if (g_havePlan && !ManualMoveHeld()) {
        const float budget = std::max(0.f, g_obs.spd) * dt;
        if (budget > 1e-4f) {
            const float tgtX = px + g_dirX * budget;
            const float tgtY = py + g_dirY * budget;
            DangerPlanner::NativeMoveTo(player, tgtX, tgtY);
        }
    }
}

// ── Debug overlay: candidate rollouts (green=safe → red=hit soon) + chosen ────
void RenderDebugPath(float camX, float camY, float angle, float zoom, float cx, float cy)
{
    if (!g_drawPath.load(std::memory_order_relaxed)) return;
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    if (!dl) return;

    const float horizonMs = static_cast<float>(SampleCount() - 1)
                          * std::max(1.f, g_sampleStepMs.load(std::memory_order_relaxed));
    for (int i = 0; i < g_vizN; ++i) {
        const VizInput& v = g_viz[i];
        if (v.dirX == 0.f && v.dirY == 0.f) continue;   // Hold has no ray
        const float reach = (v.reach > 0.1f) ? v.reach : 1.0f;
        // Cap the drawn ray at ~1.5 tiles for clarity. The camera is centered on
        // the player, so playerWorld ≈ (camX,camY); endpoint = player + dir*len.
        const float len = std::min(reach, 1.5f);
        const float wx = camX + v.dirX * len;
        const float wy = camY + v.dirY * len;
        float sx, sy;
        if (!W2S(wx, wy, sx, sy, camX, camY, angle, zoom, cx, cy)) continue;
        // Color: green (safe to horizon) → red (hit early).
        const float frac = (horizonMs > 1.f) ? std::clamp(v.tau / horizonMs, 0.f, 1.f) : 1.f;
        const int   r = static_cast<int>(255 * (1.f - frac));
        const int   g = static_cast<int>(255 * frac);
        const ImU32 col = v.chosen ? IM_COL32(255, 255, 0, 255)
                                   : IM_COL32(r, g, 60, 200);
        dl->AddLine(ImVec2(cx, cy), ImVec2(sx, sy), col, v.chosen ? 3.0f : 1.6f);
        dl->AddCircleFilled(ImVec2(sx, sy), v.chosen ? 4.f : 2.5f, col);
    }

    char buf[128];
    std::snprintf(buf, sizeof buf, "Rollout: %s  threats=%d  tau=%.0fms  spd=%.1f",
                  g_lastBackend, g_lastThreatCount, g_lastTau, g_obs.spd);
    dl->AddText(ImVec2(14.f, 130.f), IM_COL32(255, 220, 80, 230), buf);
}

void RenderSettings()
{
    ImGui::TextUnformatted("RE-Sim (rollout)");
    ImGui::Separator();
    ImGui::TextDisabled("Per-input forward simulation + uniform-grid broad-phase.");
    ImGui::Spacing();

    float ht = g_horizonTicks.load(std::memory_order_relaxed);
    if (ImGui::SliderFloat("Horizon (ticks)##rl", &ht, 1.f, 8.f, "%.0f"))
        SetHorizonTicks(ht);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How many ~200ms server ticks ahead the rollout\n"
                          "simulates each candidate input.");

    float ss = g_sampleStepMs.load(std::memory_order_relaxed);
    if (ImGui::SliderFloat("Sample step (ms)##rl", &ss, 10.f, 60.f, "%.0f"))
        SetSampleStepMs(ss);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Trajectory / CCD sample spacing. Smaller = finer\n"
                          "continuous collision detection, more compute.");

    int hc = g_headingCount.load(std::memory_order_relaxed);
    if (ImGui::SliderInt("Headings##rl", &hc, 8, kMaxHeadings))
        SetHeadingCount(hc);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Evenly-spaced candidate move directions (+ Hold).\n"
                          "More = finer gap-threading, more compute.");

    float hs = g_hitScale.load(std::memory_order_relaxed);
    if (ImGui::SliderFloat("Hit scale##rl", &hs, 0.5f, 2.0f, "%.2f"))
        SetHitScale(hs);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip(">1.0 widens the safety margin; 1.0 = exact game hitbox.");

    float iw = g_intentWeight.load(std::memory_order_relaxed);
    if (ImGui::SliderFloat("Intent weight##rl", &iw, 0.f, 3.0f, "%.2f"))
        SetIntentWeight(iw);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How strongly equally-safe inputs are pulled toward\n"
                          "the goal. Safety always dominates.");

    int rn = g_rebuildN.load(std::memory_order_relaxed);
    if (ImGui::SliderInt("Rebuild every N frames##rl", &rn, 1, 10))
        SetRebuildN(rn);

    bool ae = g_avoidEnemies.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Avoid enemy bodies##rl", &ae)) SetAvoidEnemiesEnabled(ae);
    bool wy = g_wasdYield.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Manual WASD yield##rl", &wy)) SetWasdYieldEnabled(wy);
    bool cd = g_commitDwell.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Commit dwell##rl", &cd)) SetCommitDwellEnabled(cd);
    ImGui::TextDisabled("Broad-phase: %s (set by the dodge mode)", g_lastBackend);
    bool dp = g_drawPath.load(std::memory_order_relaxed);
    if (ImGui::Checkbox("Draw candidate rollouts (debug)##rl", &dp)) SetDrawPathEnabled(dp);

    ImGui::Spacing();
    ImGui::TextDisabled("obsSpeed %.2f t/s  backend %s  threats %d",
                        g_obs.spd, g_lastBackend, g_lastThreatCount);
    ImGui::TextDisabled("Plan: %s  tau %.0f ms  dir (%.2f, %.2f)",
                        g_havePlan ? "active" : "idle", g_lastTau, g_dirX, g_dirY);
}

// ── Tunable setters/getters ──────────────────────────────────────────────────
void  SetHorizonTicks(float t)  { g_horizonTicks.store(std::clamp(t, 1.f, 8.f), std::memory_order_relaxed); }
float GetHorizonTicks()         { return g_horizonTicks.load(std::memory_order_relaxed); }
void  SetSampleStepMs(float m)  { g_sampleStepMs.store(std::clamp(m, 10.f, 60.f), std::memory_order_relaxed); }
float GetSampleStepMs()         { return g_sampleStepMs.load(std::memory_order_relaxed); }
void  SetHeadingCount(int n)    { g_headingCount.store(std::clamp(n, 8, kMaxHeadings), std::memory_order_relaxed); }
int   GetHeadingCount()         { return g_headingCount.load(std::memory_order_relaxed); }
void  SetHitScale(float s)      { g_hitScale.store(std::clamp(s, 0.5f, 2.0f), std::memory_order_relaxed); }
float GetHitScale()             { return g_hitScale.load(std::memory_order_relaxed); }
void  SetIntentWeight(float w)  { g_intentWeight.store(std::clamp(w, 0.f, 3.0f), std::memory_order_relaxed); }
float GetIntentWeight()         { return g_intentWeight.load(std::memory_order_relaxed); }
void  SetRebuildN(int n)        { g_rebuildN.store(std::clamp(n, 1, 10), std::memory_order_relaxed); }
int   GetRebuildN()             { return g_rebuildN.load(std::memory_order_relaxed); }
void  SetBroadPhase(int m)      { g_broadPhase.store(std::clamp(m, 0, 3), std::memory_order_relaxed); }
int   GetBroadPhase()           { return g_broadPhase.load(std::memory_order_relaxed); }
void  SetAvoidEnemiesEnabled(bool e){ g_avoidEnemies.store(e, std::memory_order_relaxed); }
bool  GetAvoidEnemiesEnabled()  { return g_avoidEnemies.load(std::memory_order_relaxed); }
void  SetWasdYieldEnabled(bool e){ g_wasdYield.store(e, std::memory_order_relaxed); }
bool  GetWasdYieldEnabled()     { return g_wasdYield.load(std::memory_order_relaxed); }
void  SetCommitDwellEnabled(bool e){ g_commitDwell.store(e, std::memory_order_relaxed); }
bool  GetCommitDwellEnabled()   { return g_commitDwell.load(std::memory_order_relaxed); }
void  SetDrawPathEnabled(bool e){ g_drawPath.store(e, std::memory_order_relaxed); }
bool  GetDrawPathEnabled()      { return g_drawPath.load(std::memory_order_relaxed); }

} // namespace RolloutDodge
