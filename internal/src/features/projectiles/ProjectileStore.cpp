#include "pch-il2cpp.h"

#include "ProjectileStore.h"
#include "ProjectileRuntimeReader.h"
#include "ProjectileTrajectory.h"
#include "RuntimeOffsets.h"
#include "gui/tabs/WorldTAB.h"

#include <atomic>

namespace {

constexpr int kMaxTrackedProj = 256;
constexpr int kMaxLocalProj = 64;
constexpr float kProjVisualTimeOffsetMs = 0.f;

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

static bool AddrOk(const void* p)
{
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

static bool TryReadLivePos(void* projInst, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    if (!AddrOk(projInst)) return false;
    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(projInst);
        outX = *reinterpret_cast<float*>(p + RuntimeOffsets::PosX);
        outY = *reinterpret_cast<float*>(p + RuntimeOffsets::PosY);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}

static void EnsureLocalCs()
{
    if (!g_LocalCsInit) {
        InitializeCriticalSection(&g_LocalCs);
        g_LocalCsInit = true;
    }
}

static void FillOutFromSlot(WorldProjectile& dst, const WorldProjectile& src, ULONGLONG now, bool livePos)
{
    dst = src;
    if (!src.valid) return;
    if (AddrOk(src.ptr)) {
        float runtimeHalf = 0.f;
        ProjectileRuntimeReader::TryReadRuntimeChebyshevHalf(src.ptr, runtimeHalf);
        dst.runtimeChebyshevHalf = (runtimeHalf > 1e-5f) ? runtimeHalf : src.runtimeChebyshevHalf;
    }

    const float elapsed = static_cast<float>(now - src.spawnTick);
    if (livePos && AddrOk(src.ptr) && TryReadLivePos(src.ptr, dst.x, dst.y))
        return;

    if (elapsed >= 0.f && ProjectileTrajectory::GetPositionAtTime(
            dst, elapsed + kProjVisualTimeOffsetMs, dst.x, dst.y))
        return;

    dst.x = src.x;
    dst.y = src.y;
}

} // namespace

namespace ProjectileStore {

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

void SnapshotToWorld(std::vector<WorldProjectile>& out)
{
    out.clear();
    const ULONGLONG now = GetTickCount64();
    Initialize();
    EnterCriticalSection(&g_RingCs);
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        const WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        const float elapsed = static_cast<float>(now - slot.spawnTick);
        if (slot.lifetime > 0.f && elapsed >= slot.lifetime) continue;
        WorldProjectile row;
        FillOutFromSlot(row, slot, now, true);
        out.push_back(row);
    }
    LeaveCriticalSection(&g_RingCs);
}

void CopyActiveForDraw(std::vector<WorldProjectile>& out)
{
    out.clear();
    const ULONGLONG now = GetTickCount64();
    Initialize();
    EnterCriticalSection(&g_RingCs);
    for (int i = 0; i < kMaxTrackedProj; ++i) {
        const WorldProjectile& slot = g_Slots[i];
        if (!slot.valid) continue;
        const float elapsedViz = static_cast<float>(now - slot.spawnTick) + kProjVisualTimeOffsetMs;
        if (elapsedViz < 0.f) continue;
        if (slot.lifetime > 0.f && elapsedViz >= slot.lifetime) continue;
        WorldProjectile row;
        FillOutFromSlot(row, slot, now, true);
        out.push_back(row);
    }
    LeaveCriticalSection(&g_RingCs);
}

void CopyActiveLocalForDraw(std::vector<WorldProjectile>& out)
{
    out.clear();
    if (!g_LocalCsInit) return;
    const ULONGLONG now = GetTickCount64();
    EnterCriticalSection(&g_LocalCs);
    for (int i = 0; i < kMaxLocalProj; ++i) {
        const WorldProjectile& slot = g_LocalSlots[i];
        if (!slot.valid) continue;
        const float elapsed = static_cast<float>(now - slot.spawnTick);
        if (slot.lifetime <= 0.f || elapsed >= slot.lifetime) continue;
        WorldProjectile row;
        FillOutFromSlot(row, slot, now, true);
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
