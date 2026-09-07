#include "pch-il2cpp.h"

#include "ProjectileStore.h"
#include "ProjectileRuntimeReader.h"
#include "ProjectileTrajectory.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "game/objects/GameObjects.h"
#include "gui/tabs/WorldTAB.h"

#include <atomic>
#include <cmath>
#include <windows.h>

namespace {

constexpr int kMaxTrackedProj = 1024;
constexpr int kMaxLocalProj = 64;
constexpr float kProjVisualTimeOffsetMs = 0.f;

// ── Prediction-accuracy stack ────────────────────────────────────────────────
std::atomic<bool> g_predAccuracy{ true };

constexpr double kCalibThrottleMs   = 15.0;   // per-slot: at most one fit per ~tick
constexpr float  kCalibFdStepMs     = 16.f;   // finite-difference step for local velocity
constexpr float  kCalibMaxTauMs     = 120.f;  // reject absurd clock corrections
constexpr float  kCalibTauEmaAlpha  = 0.5f;   // correction smoothing
constexpr float  kCalibMinSpeedSq   = 1e-8f;  // (tiles/ms)^2 — below this the fit is ill-posed

// Residual stats, mutated only under g_RingCs.
struct PredStats {
    float emaAbsTauMs = 0.f;
    float maxAbsTauMs = 0.f;
    float emaCrossTiles = 0.f;
    float maxCrossTiles = 0.f;
    int   calibrated = 0;
};
PredStats g_predStats{};

CRITICAL_SECTION g_RingCs;
CRITICAL_SECTION g_LocalCs;
std::atomic<uint32_t> g_WriteIdx{0};
std::atomic<uint32_t> g_LocalWriteIdx{0};
WorldProjectile g_Slots[kMaxTrackedProj]{};
WorldProjectile g_LocalSlots[kMaxLocalProj]{};
bool g_CsInit = false;
bool g_LocalCsInit = false;
ProjectileStore::HazardSpawnCb g_HazardCb = nullptr;
void* g_HazardCbUser = nullptr;

static bool TryReadLivePos(void* projInst, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    return Game::Entity(projInst).TryPos(outX, outY);
}

static void EnsureLocalCs()
{
    if (!g_LocalCsInit) {
        InitializeCriticalSection(&g_LocalCs);
        g_LocalCsInit = true;
    }
}

// Fit the per-projectile clock correction τ so the game's own positionAt lands
// on the live position: decompose (live − predicted) into an along-track part
// (= clock error, absorbed into clockOffsetMs) and a cross-track remainder
// (= true model error, recorded as residual). Caller holds the slot lock.
static void CalibrateSlotClock(WorldProjectile& slot, double qpcNow)
{
    if (slot.spawnQpcMs <= 0.0 || !Mem::AddrOk(slot.ptr)) return;
    if (qpcNow - slot.lastCalibQpcMs < kCalibThrottleMs) return;
    slot.lastCalibQpcMs = qpcNow;

    float liveX = 0.f, liveY = 0.f;
    if (!TryReadLivePos(slot.ptr, liveX, liveY)) return;
    if (fabsf(liveX) < 0.5f && fabsf(liveY) < 0.5f) return;    // origin sentinel

    const float elapsed = static_cast<float>(qpcNow - slot.spawnQpcMs) + slot.clockOffsetMs;
    if (elapsed < 0.f || (slot.lifetime > 0.f && elapsed >= slot.lifetime)) return;

    float px = 0.f, py = 0.f;
    if (!ProjectileTrajectory::GetPositionAtTime(slot, elapsed, px, py)) return;
    if (px == 0.f && py == 0.f) return;
    float qx = 0.f, qy = 0.f;
    if (!ProjectileTrajectory::GetPositionAtTime(slot, elapsed + kCalibFdStepMs, qx, qy)) return;
    if (qx == 0.f && qy == 0.f) return;

    const float vx = (qx - px) / kCalibFdStepMs;               // tiles per ms
    const float vy = (qy - py) / kCalibFdStepMs;
    const float speedSq = vx * vx + vy * vy;
    if (speedSq < kCalibMinSpeedSq) return;                    // apex/stationary → ill-posed

    const float ex = liveX - px;
    const float ey = liveY - py;
    const float tau = (ex * vx + ey * vy) / speedSq;
    if (!std::isfinite(tau)) return;
    const float crossX = ex - vx * tau;
    const float crossY = ey - vy * tau;
    const float cross = std::sqrt(crossX * crossX + crossY * crossY);
    const float absTau = fabsf(tau);

    // Absurd τ = wrong anchor (offset drift / server reposition) — record, don't apply.
    if (absTau <= kCalibMaxTauMs) {
        slot.clockOffsetMs += tau * kCalibTauEmaAlpha;
        if (slot.clockOffsetMs > 250.f)  slot.clockOffsetMs = 250.f;
        if (slot.clockOffsetMs < -250.f) slot.clockOffsetMs = -250.f;
    }
    slot.residAlongMs    = slot.predCalibrated ? slot.residAlongMs * 0.7f + absTau * 0.3f : absTau;
    slot.residCrossTiles = slot.predCalibrated ? slot.residCrossTiles * 0.7f + cross * 0.3f : cross;
    slot.predCalibrated = true;

    g_predStats.emaAbsTauMs   = g_predStats.emaAbsTauMs * 0.98f + absTau * 0.02f;
    g_predStats.emaCrossTiles = g_predStats.emaCrossTiles * 0.98f + cross * 0.02f;
    if (absTau > g_predStats.maxAbsTauMs)   g_predStats.maxAbsTauMs = absTau;
    if (cross > g_predStats.maxCrossTiles)  g_predStats.maxCrossTiles = cross;
    ++g_predStats.calibrated;
}

static void FillOutFromSlot(WorldProjectile& dst, WorldProjectile& src, ULONGLONG now, bool livePos,
                            bool calibrate, double qpcNow)
{
    if (calibrate && src.valid && g_predAccuracy.load(std::memory_order_relaxed))
        CalibrateSlotClock(src, qpcNow);

    dst = src;
    if (!src.valid) return;
    if (Mem::AddrOk(src.ptr)) {
        // Rotating beams keep their origin; their live angle is the geometry.
        if (src.laser) {
            const float angle = Mem::ReadOr<float>(src.ptr, RuntimeOffsets::Hbeak_Angle, src.angle);
            if (std::isfinite(angle)) dst.angle = angle;
        }
        float runtimeHalf = 0.f;
        ProjectileRuntimeReader::TryReadRuntimeChebyshevHalf(src.ptr, runtimeHalf);
        dst.runtimeChebyshevHalf = (runtimeHalf > 1e-5f) ? runtimeHalf : src.runtimeChebyshevHalf;

        int32_t liveDamage = 0;
        if (ProjectileRuntimeReader::TryReadLiveDamage(src.ptr, liveDamage)) {
            dst.damage = liveDamage;
            if (dst.minDamage <= 0 || dst.minDamage > liveDamage) dst.minDamage = liveDamage;
        }
    }

    // Publish the calibrated elapsed for consumers (sensors); -1 = unavailable.
    dst.elapsedCalMs = -1.f;
    if (g_predAccuracy.load(std::memory_order_relaxed) && src.spawnQpcMs > 0.0) {
        const float e = static_cast<float>(qpcNow - src.spawnQpcMs) + src.clockOffsetMs;
        if (e >= 0.f) dst.elapsedCalMs = e;
    }

    const float elapsed = static_cast<float>(now - src.spawnTick);
    if (livePos && Mem::AddrOk(src.ptr) && TryReadLivePos(src.ptr, dst.x, dst.y))
        return;

    if (elapsed >= 0.f && ProjectileTrajectory::GetPositionAtTime(
            dst, elapsed + kProjVisualTimeOffsetMs, dst.x, dst.y))
        return;

    dst.x = src.x;
    dst.y = src.y;
}

} // namespace

namespace ProjectileStore {

double QpcNowMs()
{
    static LARGE_INTEGER s_freq{};
    static bool s_have = false;
    if (!s_have) { QueryPerformanceFrequency(&s_freq); s_have = s_freq.QuadPart != 0; }
    if (!s_have) return static_cast<double>(GetTickCount64());
    LARGE_INTEGER c{};
    QueryPerformanceCounter(&c);
    return (static_cast<double>(c.QuadPart) * 1000.0) / static_cast<double>(s_freq.QuadPart);
}

void SetPredictionAccuracy(bool enabled)
{
    g_predAccuracy.store(enabled, std::memory_order_relaxed);
}

bool GetPredictionAccuracy()
{
    return g_predAccuracy.load(std::memory_order_relaxed);
}

PredictionDiag GetPredictionDiag()
{
    PredictionDiag d{};
    d.enabled = g_predAccuracy.load(std::memory_order_relaxed);
    if (!g_CsInit) return d;
    EnterCriticalSection(&g_RingCs);
    d.calibrated    = g_predStats.calibrated;
    d.emaAbsTauMs   = g_predStats.emaAbsTauMs;
    d.maxAbsTauMs   = g_predStats.maxAbsTauMs;
    d.emaCrossTiles = g_predStats.emaCrossTiles;
    d.maxCrossTiles = g_predStats.maxCrossTiles;
    // Slow decay on the maxima so a one-off spike (e.g. a realm hop) fades.
    g_predStats.maxAbsTauMs  *= 0.995f;
    g_predStats.maxCrossTiles *= 0.995f;
    LeaveCriticalSection(&g_RingCs);
    return d;
}

void Initialize()
{
    if (g_CsInit) return;
    InitializeCriticalSection(&g_RingCs);
    g_CsInit = true;
}

void Shutdown()
{
    if (g_LocalCsInit) {
        DeleteCriticalSection(&g_LocalCs);
        g_LocalCsInit = false;
    }
    if (g_CsInit) {
        DeleteCriticalSection(&g_RingCs);
        g_CsInit = false;
    }
    g_HazardCb = nullptr;
    g_HazardCbUser = nullptr;
}

WorldProjectile StoreProjectile(bool enemyShot, const WorldProjectile& projectile)
{
    Initialize();
    CRITICAL_SECTION* cs = &g_RingCs;
    WorldProjectile* slots = g_Slots;
    uint32_t maxSlots = kMaxTrackedProj;
    std::atomic<uint32_t>* writeIdx = &g_WriteIdx;
    if (!enemyShot) {
        EnsureLocalCs();
        cs = &g_LocalCs;
        slots = g_LocalSlots;
        maxSlots = kMaxLocalProj;
        writeIdx = &g_LocalWriteIdx;
    }

    EnterCriticalSection(cs);
    const uint32_t idx = writeIdx->fetch_add(1, std::memory_order_relaxed) % maxSlots;
    slots[idx] = projectile;
    const WorldProjectile snap = slots[idx];
    LeaveCriticalSection(cs);
    return snap;
}

bool RetireProjectile(const WorldProjectile& projectile)
{
    Initialize();
    bool retired = false;
    EnterCriticalSection(&g_RingCs);
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        if (slot.bulletId != projectile.bulletId) continue;
        if (slot.spawnTick != projectile.spawnTick) continue;
        if (slot.ptr && projectile.ptr && slot.ptr != projectile.ptr) continue;
        slot.valid = false;
        retired = true;
        break;
    }
    LeaveCriticalSection(&g_RingCs);
    return retired;
}

// A single reconcile should only ever catch a handful of just-deleted shots. If it
// would retire MORE than this, the live-pool read is INCOMPLETE (it didn't see shots
// that are actually alive — observed live=1 during a boss firing dozens), and pruning
// them would drop LIVE shots → the dodge misses them → death. In that case we abort
// and prune NOTHING. A lingering phantom lane is safe; a wrongly-dropped live shot is
// not. Genuine mass-deletions above this just wait for the next reconcile.
static constexpr int kMaxSafeRetirePerReconcile = 4;

int RetireNotInLiveSet(const std::unordered_set<uintptr_t>& live, float minAgeMs)
{
    if (live.empty()) return 0;   // SAFETY: empty = failed/partial pool read → prune NOTHING
    Initialize();
    const ULONGLONG now = GetTickCount64();

    EnterCriticalSection(&g_RingCs);
    // Pass 1 — DRY COUNT how many would be retired; if implausibly many, the read is
    // incomplete and we must not trust it. Abort without touching a single slot.
    int wouldRetire = 0;
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        const WorldProjectile& slot = g_Slots[i];
        if (!slot.valid || !slot.ptr) continue;
        if (static_cast<float>(now - slot.spawnTick) < minAgeMs) continue;
        if (live.count(reinterpret_cast<uintptr_t>(slot.ptr)) == 0) ++wouldRetire;
    }
    if (wouldRetire > kMaxSafeRetirePerReconcile) {
        LeaveCriticalSection(&g_RingCs);
        return 0;   // incomplete read → prune nothing (never risk a live shot)
    }

    // Pass 2 — actually retire the (few, confidently-dead) slots.
    int retired = 0;
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        WorldProjectile& slot = g_Slots[i];
        if (!slot.valid || !slot.ptr) continue;
        if (static_cast<float>(now - slot.spawnTick) < minAgeMs) continue;
        if (live.count(reinterpret_cast<uintptr_t>(slot.ptr)) != 0) continue;  // still alive → keep
        slot.valid = false;                                                    // game deleted it → drop the lane
        ++retired;
    }
    LeaveCriticalSection(&g_RingCs);
    return retired;
}

void SnapshotToWorld(std::vector<WorldProjectile>& out)
{
    out.clear();
    const ULONGLONG now = GetTickCount64();
    const double qpcNow = QpcNowMs();
    Initialize();
    EnterCriticalSection(&g_RingCs);
    g_predStats.calibrated = 0;
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        const float elapsed = static_cast<float>(now - slot.spawnTick);
        if (slot.lifetime > 0.f && elapsed >= slot.lifetime) continue;
        WorldProjectile row;
        FillOutFromSlot(row, slot, now, true, /*calibrate*/true, qpcNow);
        out.push_back(row);
    }
    LeaveCriticalSection(&g_RingCs);
}

void CopyActiveForDraw(std::vector<WorldProjectile>& out)
{
    out.clear();
    const ULONGLONG now = GetTickCount64();
    const double qpcNow = QpcNowMs();
    Initialize();
    EnterCriticalSection(&g_RingCs);
    g_predStats.calibrated = 0;
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        const float elapsedViz = static_cast<float>(now - slot.spawnTick) + kProjVisualTimeOffsetMs;
        if (elapsedViz < 0.f) continue;
        if (slot.lifetime > 0.f && elapsedViz >= slot.lifetime) continue;
        WorldProjectile row;
        FillOutFromSlot(row, slot, now, true, /*calibrate*/true, qpcNow);
        out.push_back(row);
    }
    LeaveCriticalSection(&g_RingCs);
}

void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out)
{
    out.clear();
    if (!g_LocalCsInit) return;
    const ULONGLONG now = GetTickCount64();
    const double qpcNow = QpcNowMs();
    EnterCriticalSection(&g_LocalCs);
    for (int i = 0; i < kMaxLocalProj; ++i) {
        WorldProjectile& slot = g_LocalSlots[i];
        if (!slot.valid) continue;
        const float elapsed = static_cast<float>(now - slot.spawnTick);
        if (slot.lifetime <= 0.f || elapsed >= slot.lifetime) continue;
        WorldProjectile row;
        // Local (our own) shots are not threats — no calibration needed.
        FillOutFromSlot(row, slot, now, true, /*calibrate*/false, qpcNow);
        out.push_back(row);
    }
    LeaveCriticalSection(&g_LocalCs);
}

int CountValidForDiagnostics()
{
    const ULONGLONG now = GetTickCount64();
    int count = 0;
    Initialize();
    EnterCriticalSection(&g_RingCs);
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        const WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        const float elapsed = static_cast<float>(now - slot.spawnTick);
        if (slot.lifetime > 0.f && elapsed >= slot.lifetime) continue;
        ++count;
    }
    LeaveCriticalSection(&g_RingCs);
    return count;
}

void RegisterHazardSpawnCallback(HazardSpawnCb cb, void* user)
{
    Initialize();
    EnterCriticalSection(&g_RingCs);
    g_HazardCb = cb;
    g_HazardCbUser = user;
    LeaveCriticalSection(&g_RingCs);
}

void ClearHazardSpawnCallback()
{
    if (!g_CsInit) {
        g_HazardCb = nullptr;
        g_HazardCbUser = nullptr;
        return;
    }
    EnterCriticalSection(&g_RingCs);
    g_HazardCb = nullptr;
    g_HazardCbUser = nullptr;
    LeaveCriticalSection(&g_RingCs);
}

void NotifyHazardSpawn(const WorldProjectile& projectile)
{
    HazardSpawnCb cb = nullptr;
    void* user = nullptr;
    if (g_CsInit) {
        EnterCriticalSection(&g_RingCs);
        cb = g_HazardCb;
        user = g_HazardCbUser;
        LeaveCriticalSection(&g_RingCs);
    }
    if (cb) {
        __try {
            cb(projectile, user);
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
}

} // namespace ProjectileStore
