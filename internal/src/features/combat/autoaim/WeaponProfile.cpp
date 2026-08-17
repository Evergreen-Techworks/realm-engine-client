#include "pch-il2cpp.h"

#include "WeaponProfile.h"
#include "AimMath.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "ProjectileTracking.h"

#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

// Player character projectile tuning fields (RE'd offsets, not yet in RuntimeOffsets)
static constexpr uint32_t kOffCharSpeedMul    = 0x188;
static constexpr uint32_t kOffCharLifetimeMul = 0x18C;
static constexpr uint32_t kOffCharRangeMul    = 0x6B8;
static constexpr uint32_t kOffProjId          = 0x15C;

static std::atomic<void*> s_projProps{ nullptr };
static WeaponProfile      s_profile;

static bool ReadPlayerTuners(void* local, float& outSpeedMul, float& outLifetimeMul, float& outRangeMul)
{
    if (!Mem::AddrOk(local)) return false;
    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(local);
        outSpeedMul    = *reinterpret_cast<float*>(p + kOffCharSpeedMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        outLifetimeMul = *reinterpret_cast<float*>(p + kOffCharLifetimeMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }

    outRangeMul = 1.f;
    __try {
        outRangeMul = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(local) + kOffCharRangeMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) {}

    auto clamp1 = [](float v) { return (std::isfinite(v) && v > 0.f && v < 100.f) ? v : 1.f; };
    outSpeedMul    = clamp1(outSpeedMul);
    outLifetimeMul = clamp1(outLifetimeMul);
    outRangeMul    = clamp1(outRangeMul);
    return true;
}

static void Recalculate(void* local)
{
    void* pp = s_projProps.load(std::memory_order_relaxed);
    if (!Mem::AddrOk(pp) || !Mem::AddrOk(local))
        return;

    float speedMul = 1.f, lifetimeMul = 1.f, rangeMul = 1.f;
    if (!ReadPlayerTuners(local, speedMul, lifetimeMul, rangeMul))
        return;

    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(pp);

        const bool isParam      = Mem::ReadOr<bool>(p, RuntimeOffsets::PP_IsParametric, false);
        const int32_t rawSpeedI = Mem::ReadOr<int32_t>(p, RuntimeOffsets::PP_Speed, 0);
        const float rawLife     = Mem::ReadOr<float>(p, RuntimeOffsets::PP_Lifetime, 0.f);
        const float mag         = Mem::ReadOr<float>(p, RuntimeOffsets::PP_Magnitude, 0.f);

        // Check parametric FIRST — swords/daggers/other fixed-arc weapons store
        // PP_Speed = 0 (unused), which would fail the speed validation below.
        if (isParam) {
            if (!(std::isfinite(mag) && mag > 0.f)) return;
            float rangeTiles = mag * speedMul;
            if (rangeMul >= 0.5f && rangeMul <= 10.f)
                rangeTiles *= rangeMul;
            s_profile.speedRaw    = 0.f;
            s_profile.lifetimeMs  = 0.f;
            s_profile.rangeTiles  = rangeTiles;
            s_profile.avgSpeedTps = 200.f;
            s_profile.isResolved  = true;
            return;
        }

        // Standard speed+lifetime projectile path.
        // Lower bound is 0 (not 100) — melee weapons like swords store speed == 100
        // (0.01 tiles/ms), which a <=100 guard would wrongly reject.
        if (rawSpeedI <= 0 || rawSpeedI >= 500000) return;

        const float rawSpeed   = static_cast<float>(rawSpeedI);
        const float lifetimeMs = ProjectileTracking::NormalizeProjectileLifetimeMs(rawLife) * lifetimeMul;
        if (!(lifetimeMs > 1.f) || !std::isfinite(lifetimeMs)) return;

        float rangeTiles = AimMath::IntegratedProjectileDistance(p, lifetimeMs, speedMul, rawSpeed);
        if (!(rangeTiles > 0.f) || !std::isfinite(rangeTiles)) return;
        if (rangeMul >= 0.5f && rangeMul <= 10.f)
            rangeTiles *= rangeMul;

        float avgSpeedTps = (rangeTiles / lifetimeMs) * 1000.f;
        if (!(avgSpeedTps > 0.01f) || !std::isfinite(avgSpeedTps))
            avgSpeedTps = (rawSpeed / 10000.f) * speedMul * 1000.f;

        s_profile.speedRaw    = rawSpeed;
        s_profile.lifetimeMs  = lifetimeMs;
        s_profile.rangeTiles  = rangeTiles;
        s_profile.avgSpeedTps = avgSpeedTps;
        s_profile.isResolved  = true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

} // namespace

namespace WeaponCalibrator {

void OnProjectileSpawn(void* projProps, void* localPlayer)
{
    if (!projProps) return;
    s_projProps.store(projProps, std::memory_order_relaxed);

    // Read projId immediately while the pointer is hot.
    __try {
        s_profile.projId = *reinterpret_cast<int32_t*>(
            reinterpret_cast<uint8_t*>(projProps) + kOffProjId);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        s_profile.projId = 0;
    }

    // Calibrate immediately — projProps is a managed IL2CPP object that may be
    // collected or reused before the next render tick, so we must read it now.
    Recalculate(localPlayer);
}

void Tick(void* localPlayer)
{
    // Re-read player multipliers each frame (speed/lifetime buffs can change).
    // projProps is already cached; only re-runs Recalculate, which is fast.
    Recalculate(localPlayer);
}

const WeaponProfile& GetProfile()
{
    return s_profile;
}

void Reset()
{
    s_projProps.store(nullptr, std::memory_order_relaxed);
    s_profile = WeaponProfile{};
}

} // namespace WeaponCalibrator
