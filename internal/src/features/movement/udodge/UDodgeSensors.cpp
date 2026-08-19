#include "pch-il2cpp.h"
#include "UDodgeSensors.h"

#include "AoeTracking.h"
#include "ProjectileTracking.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "gui/tabs/WorldTAB.h"
#include "gui/tabs/TestTAB.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
#include <windows.h>

namespace UDodge { namespace Sensors {
namespace {

constexpr float kThreatCullTiles = 16.f;
constexpr float kEnemyRadius     = 0.5f;
constexpr float kAoeCullPad      = 16.f;
constexpr float kPathPadMs       = 300.f;   // sample past the horizon so the lead never runs off the path

// Per-tick memo for the hazard lookup: the core probes CanOccupy at hundreds of
// points per frame, so each distinct tile is queried at most once per tick.
// Fixed-size open-addressing hash table — no per-frame heap allocation.
// Single game-update-thread consumer; cleared at the top of Build.
constexpr uint32_t kMemoSlots    = 512;      // power of 2
constexpr uint32_t kMemoMask     = kMemoSlots - 1;
constexpr uint32_t kMemoEmpty    = 0xFFFFFFFFu;

struct MemoEntry { uint32_t key; uint8_t value; };
MemoEntry s_hazardMemo[kMemoSlots];

void MemoClear()
{
    for (uint32_t i = 0; i < kMemoSlots; ++i)
        s_hazardMemo[i].key = kMemoEmpty;
}

bool MemoFind(uint32_t key, uint8_t& outValue)
{
    uint32_t idx = key & kMemoMask;
    for (uint32_t probe = 0; probe < kMemoSlots; ++probe) {
        const MemoEntry& e = s_hazardMemo[idx];
        if (e.key == key) { outValue = e.value; return true; }
        if (e.key == kMemoEmpty) return false;
        idx = (idx + 1) & kMemoMask;
    }
    return false;
}

void MemoInsert(uint32_t key, uint8_t value)
{
    uint32_t idx = key & kMemoMask;
    for (uint32_t probe = 0; probe < kMemoSlots; ++probe) {
        MemoEntry& e = s_hazardMemo[idx];
        if (e.key == kMemoEmpty || e.key == key) {
            e.key = key; e.value = value;
            return;
        }
        idx = (idx + 1) & kMemoMask;
    }
}

uint32_t TileKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}

bool IsFinite(float v) { return std::isfinite(v); }
bool IsFinitePoint(float x, float y) { return IsFinite(x) && IsFinite(y); }

float DistSq(float ax, float ay, float bx, float by)
{
    const float dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
}

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
    for (int i = anchor + 1; i < count && t.sampleCount < kMaxPathSamples; ++i) {
        if (!IsFinitePoint(p.pathX[i], p.pathY[i])) break;
        const float sMs = p.pathSampleTimesMs[i];
        if (!IsFinite(sMs)) break;
        if (IsFinite(p.lifetime) && p.lifetime > 0.f && sMs > p.lifetime) break;
        const float futureMs = std::max(0.f, sMs - baseMs);
        if (futureMs > windowMs) break;
        AddSample(t, p.x + (p.pathX[i] - ax), p.y + (p.pathY[i] - ay), futureMs);
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
    out.hasLock = false;
    out.lockId = 0;
    out.lockPos = {};
    MemoClear();

    if (!ProjectileTracking::IsInstalled()) {
        out.projectileSourceUnavailable = true;
        return;
    }

    const float cullSq = kThreatCullTiles * kThreatCullTiles;
    const float windowMs = std::clamp(settings.horizonMs, 200.f, 2000.f) + kPathPadMs;
    const uint64_t nowMs = GetTickCount64();
    const int32_t localId = ProjectileTracking::GetLocalPlayerObjectId();

    // Enemies → proximity blockers (scored by the core, never a hard veto),
    // plus the Autopilot boss lock in the same pass. No break on `limited` —
    // the lock scan must see all enemies.
    EnemyTracker::Tick();
    int32_t lockId = 0, lockMaxHp = -1;
    float   lockX = 0.f, lockY = 0.f;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        if (DistSq(e.x, e.y, playerX, playerY) <= cullSq) {
            if (out.enemyCount >= kMaxEnemies) { out.limited = true; }
            else {
                EnemyBlocker& b = out.enemies[out.enemyCount++];
                b.pos = { e.x, e.y };
                b.radius = kEnemyRadius;
            }
        }
        // Boss lock: biggest real-HP enemy (sticky via constant maxHp), NOT
        // range-culled so autopilot keeps range to a far boss.
        if (e.hasHealthBar && e.hp > 0 && e.maxHp > 0 &&
            (e.maxHp > lockMaxHp || (e.maxHp == lockMaxHp && e.id < lockId))) {
            lockMaxHp = e.maxHp; lockId = e.id; lockX = e.x; lockY = e.y;
        }
    }
    if (lockMaxHp >= 0) { out.hasLock = true; out.lockId = lockId; out.lockPos = { lockX, lockY }; }

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

    // AoE telegraphs → landing events. Danger is AT the landing instant
    // (arcMs = flight/arming time when known, else the full lifetime).
    // Already-detonated zones with lifetime remaining persist as always-active
    // discs (activeNow) so lingering burn zones are not lost.
    AoeTracking::EnsureInstalled();
    static std::vector<WorldAoe> s_aoes;
    s_aoes.clear();
    AoeTracking::CopyActiveForDraw(s_aoes);
    for (const WorldAoe& a : s_aoes) {
        if (!a.valid || !a.isDamaging) continue;
        if (a.isEnemyChecked && !a.isEnemy) continue;
        if (!IsFinitePoint(a.destX, a.destY)) continue;

        const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
        const float lifeMs = IsFinite(a.lifetime) && a.lifetime > 0.f ? a.lifetime : 2000.f;
        const float landAtMs = (IsFinite(a.arcMs) && a.arcMs > 0.f) ? a.arcMs : lifeMs;
        const float landingMs = landAtMs - elapsedMs;
        const float remainMs = lifeMs - elapsedMs;
        if (landingMs > windowMs) continue;           // lands beyond the window
        const bool activeNow = landingMs <= 0.f;
        if (activeNow && remainMs <= 25.f) continue;  // effectively expired

        const float radius = (IsFinite(a.radius) && a.radius > 0.f) ? std::clamp(a.radius, 0.2f, 12.f) : 1.5f;
        const float cull = kAoeCullPad + radius;
        if (DistSq(a.destX, a.destY, playerX, playerY) > cull * cull) continue;
        if (out.aoeCount >= kMaxAoes) { out.limited = true; break; }

        AoeThreat& t = out.aoes[out.aoeCount++];
        t.pos = { a.destX, a.destY };
        t.radius = radius;
        t.activeNow = activeNow;
        t.landingMs = activeNow ? 0.f : landingMs;
        t.remainMs  = activeNow ? remainMs : 0.f;
    }
}

bool IsHazardAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return false;
    const int tx = static_cast<int>(std::floor(worldX));
    const int ty = static_cast<int>(std::floor(worldY));
    const uint32_t key = TileKey(tx, ty);
    uint8_t cached = 0;
    if (MemoFind(key, cached)) return cached != 0;
    const bool hz = WorldTAB::IsTileDamagingLive(tx, ty);
    MemoInsert(key, hz ? 1 : 0);
    return hz;
}

bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    if (!IsFinitePoint(worldX, worldY)) return false;   // unknown → treat as blocked
    if (TestTAB::IsWalkPositionBlocked(worldX, worldY)) return false;
    if (safeWalk && IsHazardAt(worldX, worldY)) return false;
    return true;
}

} } // namespace UDodge::Sensors
