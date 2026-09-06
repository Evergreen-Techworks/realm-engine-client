#include "pch-il2cpp.h"
#include "PJDodgeSensors.h"

#include "AoeTracking.h"
#include "ProjectileTracking.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "features/movement/sensors/TileSensor.h"
#include "gui/tabs/WorldTAB.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
#include <windows.h>

namespace PJDodge { namespace Sensors {
namespace {

constexpr float kThreatCullTiles = 16.f;
constexpr float kEnemyRadius     = 0.5f;
constexpr float kAoeCullPad      = 16.f;
constexpr float kPathPadMs       = 300.f;   // sample past the horizon so the lead never runs off the path
// Danger instant used for an AoE zone that is ALREADY live at capture (see the
// AoE block in Build). Smallest positive value that survives PJDodgeCore's
// `landingMs > 0` gates; deliberately not 0, which those gates would discard.
constexpr float kAoeLiveNowMs    = 1.f;

// Per-tick memo for the hazard lookup: the core probes CanOccupy at hundreds of
// points per frame, so each distinct tile is queried at most once per tick.
// OUR OWN instance of the shared open-addressed table (Movement::TileSensor) —
// no per-frame heap allocation. Single game-update-thread consumer; cleared at
// the top of Build.
Movement::TileSensor::HazardMemo s_hazardMemo;

using Movement::TileSensor::IsFinite;
using Movement::TileSensor::IsFinitePoint;
using Movement::TileSensor::DistSq;

void AddSample(ProjectileThreat& t, float x, float y, float tMs)
{
    if (t.sampleCount >= kMaxPathSamples || !IsFinitePoint(x, y)) return;
    t.sampleTimesMs[t.sampleCount] = std::max(0.f, tMs);
    t.samples[t.sampleCount++] = { x, y };
}

// SEH-guarded prediction. (0,0) is GetPositionAtTime's failure sentinel — no
// real in-dungeon projectile sits at the world origin, so reject it.
bool TryPredict(const WorldProjectile& p, float tMs, float& outX, float& outY)
{
    float x = 0.f, y = 0.f;
    __try { ProjectileTracking::ComputePosAt(p, tMs, x, y); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    if (x == 0.f && y == 0.f) return false;
    if (!IsFinitePoint(x, y)) return false;
    outX = x; outY = y;
    return true;
}

// Anchor a cached projectile path to its live position (falls back to elapsed
// time if the live anchor is implausible — guards against bad PosX/PosY offsets).
int CachedAnchorIndex(const WorldProjectile& p, float elapsedMs)
{
    const int count = std::clamp(p.pathSampleCount, 0, kWorldProjectilePathSampleCap);
    if (count <= 1) return 0;
    if (!IsFinitePoint(p.x, p.y)) return -1;

    int best = 0;
    float bestDistSq = 3.402823466e+38f;
    for (int i = 0; i < count; ++i) {
        const float x = p.pathX[i], y = p.pathY[i];
        if (!IsFinitePoint(x, y)) continue;
        const float d = DistSq(x, y, p.x, p.y);
        if (d < bestDistSq) { bestDistSq = d; best = i; }
    }
    constexpr float kMaxLiveAnchorDistSq = 25.f;
    if (bestDistSq <= kMaxLiveAnchorDistSq) return best;

    if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return -1;
    float bestDelta = 3.402823466e+38f;
    for (int i = 0; i < count; ++i) {
        const float tcand = p.pathSampleTimesMs[i];
        if (!IsFinite(tcand)) continue;
        const float delta = std::fabs(tcand - elapsedMs);
        if (delta < bestDelta) { bestDelta = delta; best = i; }
    }
    return best;
}

// Build a threat path from the projectile's cached path, rebased onto its live
// position. Returns false (caller falls back to ComputePosAt sampling).
bool AddCachedPath(ProjectileThreat& t, const WorldProjectile& p, float windowMs, float elapsedMs)
{
    if (!p.hasCachedPath || p.pathSampleCount < 2) return false;
    if (IsFinite(p.lifetime) && p.lifetime > 0.f && elapsedMs >= p.lifetime) return false;

    const int count = std::min(p.pathSampleCount, kWorldProjectilePathSampleCap);
    const int anchor = CachedAnchorIndex(p, elapsedMs);
    if (anchor < 0 || anchor >= count) return false;
    const float ax = p.pathX[anchor], ay = p.pathY[anchor];
    if (!IsFinitePoint(ax, ay)) return false;

    const float baseMs = IsFinite(p.pathSampleTimesMs[anchor]) ? p.pathSampleTimesMs[anchor] : elapsedMs;

    AddSample(t, p.x, p.y, 0.f);
    bool  shotEnds  = false;
    bool  spanned   = false;   // the cache reached past the window (coverage complete)
    for (int i = anchor + 1; i < count && t.sampleCount < kMaxPathSamples; ++i) {
        if (!IsFinitePoint(p.pathX[i], p.pathY[i])) break;
        const float sMs = p.pathSampleTimesMs[i];
        if (!IsFinite(sMs)) break;
        if (IsFinite(p.lifetime) && p.lifetime > 0.f && sMs > p.lifetime) break;
        const float futureMs = std::max(0.f, sMs - baseMs);
        if (futureMs > windowMs) { spanned = true; break; }   // cache reaches past the window
        AddSample(t, p.x + (p.pathX[i] - ax), p.y + (p.pathY[i] - ay), futureMs);
        shotEnds  = IsFinite(p.lifetime) && p.lifetime > 0.f && sMs >= p.lifetime - 1.f;
    }
    // TIME COVERAGE (cached path is bounded from spawn — WorldTAB.h
    // kWorldProjectilePathCoverMs). A long-lived shot outruns the cache, and a
    // path that stops short of the window while the shot is STILL ALIVE would
    // silently under-state danger. Refuse it (resetting what we appended) so the
    // caller re-samples fresh from positionAt over the full window.
    if (!spanned && !shotEnds && t.sampleCount < kMaxPathSamples) {
        t.sampleCount = 0;
        return false;
    }
    return t.sampleCount >= 2;
}

bool IsCurved(const WorldProjectile& p)
{
    return p.wavy || p.parametric || p.boomerang || p.isTurning ||
           p.isTurningDelayed || p.isCircleTurnDelayed || p.isAccelerating;
}

// Fresh per-tick resample from the game's own positionAt, anchored on the live
// position and using the CALIBRATED base time. Curved shots get a finer step so
// the polyline hugs the true arc instead of chording it. This is the
// prediction-accuracy path (toggle ON).
bool AddFreshPath(ProjectileThreat& t, const WorldProjectile& p, float windowMs, float baseElapsedMs)
{
    if (IsFinite(p.lifetime) && p.lifetime > 0.f && baseElapsedMs >= p.lifetime) return false;

    // Anchor offset: (live position) − (model position at the calibrated base
    // time). With clock calibration on this is tiny; any remainder is residual
    // cross-track error, applied as a constant near-term shift so sample 0 is
    // exactly the live position and the path stays continuous.
    float ax = 0.f, ay = 0.f;
    if (!TryPredict(p, baseElapsedMs, ax, ay)) return false;
    const float offX = p.x - ax;
    const float offY = p.y - ay;

    const float coarseStep = windowMs / static_cast<float>(kMaxPathSamples - 1);
    const float stepMs = IsCurved(p) ? std::clamp(coarseStep, 20.f, 30.f) : std::max(16.f, coarseStep);

    AddSample(t, p.x, p.y, 0.f);   // live position = t≈0 anchor
    for (int i = 1; i < kMaxPathSamples; ++i) {
        const float futureMs = stepMs * static_cast<float>(i);
        if (futureMs > windowMs) break;
        const float tMs = baseElapsedMs + futureMs;
        if (IsFinite(p.lifetime) && p.lifetime > 0.f && tMs > p.lifetime) break;
        float x = 0.f, y = 0.f;
        if (!TryPredict(p, tMs, x, y)) break;
        if (!IsFinitePoint(x, y)) break;
        AddSample(t, x + offX, y + offY, futureMs);
    }
    return t.sampleCount >= 2;
}

} // namespace

void Build(Snapshot& out, float playerX, float playerY, const Settings& settings)
{
    out.projectileCount = 0;
    out.aoeCount = 0;
    out.enemyCount = 0;
    out.projectileSourceUnavailable = false;
    out.limited = false;
    s_hazardMemo.Clear();

    if (!ProjectileTracking::IsInstalled()) {
        out.projectileSourceUnavailable = true;
        return;
    }

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    const float windowMs = std::clamp(settings.horizonMs, 200.f, 2000.f) + kPathPadMs;
    const uint64_t nowMs = GetTickCount64();
    const int32_t localId = ProjectileTracking::GetLocalPlayerObjectId();

    // Enemies → proximity blockers (scored by the core, never a hard veto).
    EnemyTracker::Tick();
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        if (DistSq(e.x, e.y, playerX, playerY) > cullSq) continue;
        if (out.enemyCount >= kMaxEnemies) { out.limited = true; break; }
        EnemyBlocker& b = out.enemies[out.enemyCount++];
        b.pos = { e.x, e.y };
        b.radius = kEnemyRadius;
    }

    // Projectiles → time-parametrized threat paths. Static buffer: the copy
    // API needs a vector, but the allocation amortizes to zero across frames.
    static std::vector<WorldProjectile> s_projs;
    s_projs.clear();
    ProjectileTracking::CopyActiveForDraw(s_projs);
    for (const WorldProjectile& p : s_projs) {
        if (!p.valid) continue;
        if (localId != 0 && p.attackerObjId == localId) continue;
        if (localId != 0 && static_cast<int32_t>(p.ownerObjId) == localId) continue;
        if (!p.canHitPlayer && p.attackerObjId == 0 && static_cast<int32_t>(p.ownerObjId) == 0) continue;
        if (!IsFinitePoint(p.x, p.y)) continue;
        if (DistSq(p.x, p.y, playerX, playerY) > cullSq) continue;
        if (out.projectileCount >= kMaxProjectiles) { out.limited = true; break; }

        ProjectileThreat& t = out.projectiles[out.projectileCount];
        t = ProjectileThreat{};
        t.id = static_cast<int32_t>(p.bulletId);

        // Prediction-accuracy toggle: the calibrated clock (elapsedCalMs, fit
        // from the live position each tick) removes GetTickCount quantization and
        // spawn-hook latency. When available, resample the game's positionAt fresh
        // at that base time (dense for curved shots). When off / unavailable, fall
        // back to the spawn-time cached path rebased on the live position.
        const float coarseElapsed = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
        const bool usePred = p.elapsedCalMs >= 0.f;
        const float baseElapsed = usePred ? p.elapsedCalMs : coarseElapsed;
        bool built = false;
        if (usePred)
            built = AddFreshPath(t, p, windowMs, baseElapsed);
        if (!built)
            built = AddCachedPath(t, p, windowMs, baseElapsed);
        if (!built) {
            const float stepMs = std::max(16.f, windowMs / static_cast<float>(kMaxPathSamples - 1));
            for (int i = 0; i < kMaxPathSamples; ++i) {
                const float futureMs = stepMs * static_cast<float>(i);
                const float tMs = baseElapsed + futureMs;
                if (p.lifetime > 0.f && tMs > p.lifetime) break;
                float x = p.x, y = p.y;
                if (i != 0 && !TryPredict(p, tMs, x, y)) break;
                if (!IsFinitePoint(x, y)) break;
                AddSample(t, x, y, futureMs);
                if (futureMs >= windowMs) break;
            }
        }
        t.hitHalf = (IsFinite(p.runtimeChebyshevHalf) && p.runtimeChebyshevHalf > 1e-4f)
                        ? p.runtimeChebyshevHalf
                        : ((IsFinite(p.projHalfSize) && p.projHalfSize > 1e-4f) ? p.projHalfSize : 0.5f);
        if (t.sampleCount > 0) ++out.projectileCount;
    }

    // AoE telegraphs → landing events. Danger is AT the landing instant, which is
    // the SHARED per-source rule (AoeTracking::LandDelayMs) — an explosion-
    // controller entry is captured AT detonation, so its arcMs is travel time
    // already spent and reading it as a landing delay parked a live blast up to
    // ~2.1 s in the future. Already-detonated telegraphed zones that persist show
    // up as damaging tiles instead.
    AoeTracking::EnsureInstalled();
    static std::vector<WorldAoe> s_aoes;
    s_aoes.clear();
    AoeTracking::CopyActiveForDraw(s_aoes);
    for (const WorldAoe& a : s_aoes) {
        if (!a.valid || !a.isDamaging) continue;
        if (a.isEnemyChecked && !a.isEnemy) continue;
        if (!IsFinitePoint(a.destX, a.destY)) continue;

        const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
        const float landAtMs = AoeTracking::LandDelayMs(a);
        // An ARMED-ON-CAPTURE zone is doing damage RIGHT NOW, so its danger instant
        // is t=0. AoeThreat models a single instant and every consumer gates on
        // landingMs > 0 (PJDodgeCore), so "now" is expressed as the smallest
        // positive instant — a literal 0 would silently drop the zone, which is the
        // same under-count in a different disguise. CopyActiveForDraw has already
        // pruned anything past its lifetime, so this only emits live blasts.
        float landingMs = landAtMs - elapsedMs;
        if (landAtMs <= 0.f)                              landingMs = kAoeLiveNowMs;
        else if (landingMs <= 0.f || landingMs > windowMs) continue;

        const float radius = (IsFinite(a.radius) && a.radius > 0.f) ? std::clamp(a.radius, 0.2f, 12.f) : 1.5f;
        const float cull = kAoeCullPad + radius;
        if (DistSq(a.destX, a.destY, playerX, playerY) > cull * cull) continue;
        if (out.aoeCount >= kMaxAoes) { out.limited = true; break; }

        AoeThreat& t = out.aoes[out.aoeCount++];
        t.pos = { a.destX, a.destY };
        t.radius = radius;
        t.landingMs = landingMs;
    }
}

bool IsHazardAt(float worldX, float worldY)
{
    return Movement::TileSensor::IsHazardAt(s_hazardMemo, worldX, worldY);
}

bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    return Movement::TileSensor::CanOccupy(s_hazardMemo, worldX, worldY, safeWalk);
}

} } // namespace PJDodge::Sensors
