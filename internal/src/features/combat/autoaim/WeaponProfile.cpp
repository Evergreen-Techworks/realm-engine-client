#include "pch-il2cpp.h"

#include "WeaponProfile.h"
#include "AimMath.h"
#include "RuntimeOffsets.h"
#include "ProjectileTracking.h"

#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

// Projectile tuning fields come from the self-healing RuntimeOffsets table.
// They used to be hardcoded here and rotted every patch: the reads returned
// garbage, clamp1() folded the multipliers back to 1.0, and Recalculate()
// bailed before setting isResolved, so the profile fell back to default
// range/speed.
//
// The range multiplier has no known offset on 6.13.0.1.0 (the old 0x6B8 is an
// object reference, not a float) so it stays pinned at 1.0 until the field is
// identified live via Test -> UnityExplorer.

static inline bool AddrOk(const void* p) {
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

static std::atomic<void*> s_projProps{ nullptr };
static WeaponProfile      s_profile;

static bool ReadPlayerTuners(void* local, float& outSpeedMul, float& outLifetimeMul, float& outRangeMul)
{
    if (!AddrOk(local)) return false;
    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(local);
        outSpeedMul    = *reinterpret_cast<float*>(p + RuntimeOffsets::Mo_ProjSpeedMul);
        outLifetimeMul = *reinterpret_cast<float*>(p + RuntimeOffsets::Mo_ProjLifetimeMul);
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }

    // See the note above: no known offset for the range multiplier on this build.
    outRangeMul = 1.f;

    auto clamp1 = [](float v) { return (std::isfinite(v) && v > 0.f && v < 100.f) ? v : 1.f; };
    outSpeedMul    = clamp1(outSpeedMul);
    outLifetimeMul = clamp1(outLifetimeMul);
    outRangeMul    = clamp1(outRangeMul);
    return true;
}

static void Recalculate(void* local)
{
    void* pp = s_projProps.load(std::memory_order_relaxed);
    if (!AddrOk(pp) || !AddrOk(local))
        return;

    float speedMul = 1.f, lifetimeMul = 1.f, rangeMul = 1.f;
    if (!ReadPlayerTuners(local, speedMul, lifetimeMul, rangeMul))
        return;

    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(pp);

        const bool isParam      = *reinterpret_cast<bool*>(p + RuntimeOffsets::PP_IsParametric);
        const int32_t rawSpeedI = *reinterpret_cast<int32_t*>(p + RuntimeOffsets::PP_Speed);
        const float rawLife     = *reinterpret_cast<float*>(p + RuntimeOffsets::PP_Lifetime);
        const float mag         = *reinterpret_cast<float*>(p + RuntimeOffsets::PP_Magnitude);

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
            reinterpret_cast<uint8_t*>(projProps) + RuntimeOffsets::PP_Id);
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
