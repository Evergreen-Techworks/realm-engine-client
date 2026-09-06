#include "pch-il2cpp.h"
#include "ReppSensors.h"

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

namespace RePP { namespace Sensors {
namespace {

constexpr float kThreatCullTiles = 14.f;
constexpr float kEnemyRadius     = 0.5f;
constexpr float kAoeCullPad      = 14.f;

// Per-tick memo for the LIVE hazard check: the planner queries IsHazardAt at
// hundreds of points/frame, so each distinct tile is square_lookup'd at most
// once per tick (cleared at the top of Build). Single game-update thread.
// OUR OWN instance of the shared open-addressed table (Movement::TileSensor) —
// it replaces a std::unordered_map, so lookups no longer allocate.
Movement::TileSensor::HazardMemo s_hazardMemo;

using Movement::TileSensor::IsFinite;
using Movement::TileSensor::IsFinitePoint;

float SafeRadius(float value, float fallback)
{
    if (!IsFinite(value) || value <= 0.f) return fallback;
    return std::clamp(value, 0.02f, 5.f);
}

float SafeReactWindowMs(float value)
{
    if (!IsFinite(value) || value <= 0.f) return Settings{}.reactWindowMs;
    return std::clamp(value, 100.f, 2500.f);
}

float ProjectileRadius(const WorldProjectile& p, float fallback)
{
    if (IsFinite(p.projHalfSize) && p.projHalfSize > 0.005f && p.projHalfSize < 2.f)
        return SafeRadius(p.projHalfSize, fallback);
    return fallback;
}

using Movement::TileSensor::DistSq;

void AddSample(Threat& t, float x, float y, float tMs)
{
    if (t.sampleCount >= kMaxPathSamples || !IsFinitePoint(x, y)) return;
    t.sampleTimesMs[t.sampleCount] = std::max(0.f, tMs);
    t.samples[t.sampleCount++] = { x, y };
    if (!t.hasBounds) {
        t.boundsMin = { x, y };
        t.boundsMax = { x, y };
        t.hasBounds = true;
    } else {
        t.boundsMin.x = std::min(t.boundsMin.x, x);
        t.boundsMin.y = std::min(t.boundsMin.y, y);
        t.boundsMax.x = std::max(t.boundsMax.x, x);
        t.boundsMax.y = std::max(t.boundsMax.y, y);
    }
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
        const float dx = x - p.x, dy = y - p.y;
        const float d = dx * dx + dy * dy;
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
bool AddCachedPath(Threat& t, const WorldProjectile& p, float reactWindowMs, float elapsedMs)
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
        if (futureMs > reactWindowMs) { spanned = true; break; }   // cache reaches past the window
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

void AddAoe(SensorSnapshot& out, const WorldAoe* aoes, int aoeCount,
            float playerX, float playerY, const Settings& settings, uint64_t nowMs)
{
    if (!aoes || aoeCount <= 0) return;
    const float fallback = SafeRadius(Settings{}.hitScale * 0.10f, 0.10f);
    const float reactWindowMs = SafeReactWindowMs(settings.reactWindowMs);

    for (int i = 0; i < aoeCount; ++i) {
        const WorldAoe& a = aoes[i];
        if (!a.valid || !a.isDamaging) continue;
        if (a.isEnemyChecked && !a.isEnemy) continue;
        if (!IsFinitePoint(a.destX, a.destY)) continue;

        const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
        const float lifeMs = IsFinite(a.lifetime) && a.lifetime > 0.f ? a.lifetime : 2000.f;
        const float remainMs = lifeMs - elapsedMs;
        if (remainMs <= 25.f) continue;

        const float radius = SafeRadius(a.radius, fallback);
        const float cull = kAoeCullPad + radius;
        if (DistSq(a.destX, a.destY, playerX, playerY) > cull * cull) continue;
        if (out.threatCount >= kMaxThreats) { out.aoeLimited = true; return; }

        Threat& t = out.threats[out.threatCount];
        t = Threat{};
        t.id = 10000 + out.threatCount;
        t.radius = radius;
        t.damage = 9999.f;
        const float horizonMs = std::min(reactWindowMs, remainMs);
        const float stepMs = std::max(16.f, horizonMs / static_cast<float>(kMaxPathSamples - 1));
        for (int s = 0; s < kMaxPathSamples; ++s) {
            const float futureMs = std::min(stepMs * static_cast<float>(s), horizonMs);
            AddSample(t, a.destX, a.destY, futureMs);
            if (futureMs >= horizonMs) break;
        }
        if (t.sampleCount > 0) ++out.threatCount;
    }
}

} // namespace

SensorSnapshot Build(float playerX, float playerY, const Settings& settings)
{
    SensorSnapshot out{};
    s_hazardMemo.Clear();   // fresh live-hazard memo for this tick

    if (!ProjectileTracking::IsInstalled()) {
        out.projectileSourceUnavailable = true;
        return out;
    }

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    const float fallbackRadius = SafeRadius(settings.hitScale * 0.10f, 0.10f);
    const float reactWindowMs = SafeReactWindowMs(settings.reactWindowMs);
    const uint64_t nowMs = GetTickCount64();
    const int32_t localId = ProjectileTracking::GetLocalPlayerObjectId();

    out.tileSpeedAtPlayer = TileSpeedAt(playerX, playerY);

    // Enemies → blockers (range-culled, contact damage) + the Autopilot boss
    // lock (highest-maxHp enemy, FULL range). One game-thread pass over the
    // self-refreshing EnemyTracker snapshot — keeps the lock fresh and avoids
    // any WorldTAB::GetEntities cost for normal play.
    EnemyTracker::Tick();
    int32_t lockId = 0, lockMaxHp = -1;
    float   lockX = 0.f, lockY = 0.f;
    const std::vector<EnemyTracker::Entry>& enemies = EnemyTracker::GetSnapshot();
    for (const EnemyTracker::Entry& e : enemies) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        if (DistSq(e.x, e.y, playerX, playerY) <= cullSq) {
            if (out.blockerCount >= kMaxBlockers) {
                out.blockerLimited = true;
            } else {
                Blocker& b = out.blockers[out.blockerCount++];
                b.kind = Blocker::Kind::Enemy;
                b.id = e.id;
                b.pos = { e.x, e.y };
                b.radius = kEnemyRadius;
            }
        }
        // Boss lock: biggest real-HP enemy (sticky via constant maxHp), NOT
        // range-culled so we keep range to a far boss.
        if (e.hasHealthBar && e.hp > 0 && e.maxHp > 0 &&
            (e.maxHp > lockMaxHp || (e.maxHp == lockMaxHp && e.id < lockId))) {
            lockMaxHp = e.maxHp; lockId = e.id; lockX = e.x; lockY = e.y;
        }
    }
    if (lockMaxHp >= 0) { out.hasLock = true; out.lockId = lockId; out.lockPos = { lockX, lockY }; }

    // Projectiles → time-parametrized threats. Static reusable buffer: the
    // CopyActiveForDraw API needs a vector, but we keep it static so the
    // allocation amortizes to zero across frames.
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
        if (out.threatCount >= kMaxThreats) { out.projectileLimited = true; break; }

        Threat& t = out.threats[out.threatCount];
        t = Threat{};
        t.id = static_cast<int32_t>(out.threatCount + 1);
        t.radius = ProjectileRadius(p, fallbackRadius);
        t.damage = static_cast<float>(std::max(p.damage, 0));

        const float elapsedMs = static_cast<float>(nowMs > p.spawnTick ? nowMs - p.spawnTick : 0u);
        if (!AddCachedPath(t, p, reactWindowMs, elapsedMs)) {
            const float stepMs = std::max(16.f, reactWindowMs / static_cast<float>(kMaxPathSamples - 1));
            for (int i = 0; i < kMaxPathSamples; ++i) {
                const float futureMs = stepMs * static_cast<float>(i);
                const float tMs = elapsedMs + futureMs;
                if (p.lifetime > 0.f && tMs > p.lifetime) break;
                float x = p.x, y = p.y;
                if (i != 0 && !TryPredict(p, tMs, x, y)) break;
                if (!IsFinitePoint(x, y)) break;
                AddSample(t, x, y, futureMs);
                if (stepMs * static_cast<float>(i) >= reactWindowMs) break;
            }
        }
        if (t.sampleCount > 0) ++out.threatCount;
    }

    // AoE telegraphs.
    AoeTracking::EnsureInstalled();
    static std::vector<WorldAoe> s_aoes;
    s_aoes.clear();
    AoeTracking::CopyActiveForDraw(s_aoes);
    AddAoe(out, s_aoes.data(), static_cast<int>(s_aoes.size()), playerX, playerY, settings, nowMs);

    return out;
}

bool IsWallAt(float worldX, float worldY)
{
    return Movement::TileSensor::IsWallAt(worldX, worldY);
}

bool IsHazardAt(float worldX, float worldY)
{
    return Movement::TileSensor::IsHazardAt(s_hazardMemo, worldX, worldY);
}

float TileSpeedAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return 1.f;
    const float s = WorldTAB::GetTileSpeed(static_cast<int>(std::floor(worldX)),
                                           static_cast<int>(std::floor(worldY)));
    if (!IsFinite(s) || s <= 0.f) return 1.f;   // 0 = no modifier
    return std::clamp(s, 0.1f, 4.f);
}

} } // namespace RePP::Sensors

