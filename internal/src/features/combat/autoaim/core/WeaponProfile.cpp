#include "pch-il2cpp.h"

#include "features/combat/autoaim/core/WeaponProfile.h"
#include "features/combat/autoaim/core/AimMath.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "game/objects/GameObjects.h"
#include "ProjectileTracking.h"
#include "features/movement/udodge/UDodgeCapture.h"

#include <atomic>
#include <cmath>
#include <cstdint>

namespace {

static std::atomic<void*> s_projProps{ nullptr };
static WeaponProfile      s_profile;
static std::atomic_flag s_provenanceLock=ATOMIC_FLAG_INIT;
static std::atomic<uint64_t> s_provenanceGeneration{0};
static WeaponCalibrator::Provenance s_provenance;
static void RecordProvenance(bool spawn,float speed,float life,float range,float speedMul,float lifeMul,float rangeMul){
    if(!UDodgeCapture::capture.enabled.load(std::memory_order_relaxed)||s_provenanceLock.test_and_set(std::memory_order_acquire))return;
    ++s_provenance.sequence;s_provenance.ms=GetTickCount64();s_provenance.generation=s_provenanceGeneration.load(std::memory_order_relaxed);
    s_provenance.source=spawn?1:2;s_provenance.projId=s_profile.projId;
    s_provenance.rawSpeed=speed;s_provenance.rawLife=life;s_provenance.range=range;
    s_provenance.speedMul=speedMul;s_provenance.lifeMul=lifeMul;s_provenance.rangeMul=rangeMul;
    s_provenanceLock.clear(std::memory_order_release);
}


static bool ReadPlayerTuners(void* local, float& outSpeedMul, float& outLifetimeMul, float& outRangeMul)
{
    if (!Mem::AddrOk(local)) return false;
    __try {
        uint8_t* p = reinterpret_cast<uint8_t*>(local);
        outSpeedMul    = *reinterpret_cast<float*>(p + RuntimeOffsets::Char_ProjSpeedMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
        outLifetimeMul = *reinterpret_cast<float*>(p + RuntimeOffsets::Char_ProjLifetimeMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }

    outRangeMul = 1.f;
    __try {
        outRangeMul = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(local) + RuntimeOffsets::Char_RangeMul);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) {}

    auto clamp1 = [](float v) { return (std::isfinite(v) && v > 0.f && v < 100.f) ? v : 1.f; };
    outSpeedMul    = clamp1(outSpeedMul);
    outLifetimeMul = clamp1(outLifetimeMul);
    outRangeMul    = clamp1(outRangeMul);
    return true;
}

static void Recalculate(void* local,bool spawn)
{
    void* pp = s_projProps.load(std::memory_order_relaxed);
    if (!Mem::AddrOk(pp) || !Mem::AddrOk(local))
        return;

    float speedMul = 1.f, lifetimeMul = 1.f, rangeMul = 1.f;
    if (!ReadPlayerTuners(local, speedMul, lifetimeMul, rangeMul))
        return;

    __try {
        Game::ProjProps props(pp);

        const bool isParam      = props.IsParametric();
        const int32_t rawSpeedI = props.Speed();
        const float rawLife     = props.Lifetime();
        const float mag         = props.Magnitude();

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
            RecordProvenance(spawn,static_cast<float>(rawSpeedI),rawLife,rangeTiles,speedMul,lifetimeMul,rangeMul);
            return;
        }

        // Standard speed+lifetime projectile path.
        // Lower bound is 0 (not 100) — melee weapons like swords store speed == 100
        // (0.01 tiles/ms), which a <=100 guard would wrongly reject.
        if (rawSpeedI <= 0 || rawSpeedI >= 500000) return;

        const float rawSpeed   = static_cast<float>(rawSpeedI);
        const float lifetimeMs = ProjectileTracking::NormalizeProjectileLifetimeMs(rawLife) * lifetimeMul;
        if (!(lifetimeMs > 1.f) || !std::isfinite(lifetimeMs)) return;

        float rangeTiles = AimMath::IntegratedProjectileDistance(
            reinterpret_cast<uint8_t*>(pp), lifetimeMs, speedMul, rawSpeed);
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
            RecordProvenance(spawn,static_cast<float>(rawSpeedI),rawLife,rangeTiles,speedMul,lifetimeMul,rangeMul);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

} // namespace

namespace WeaponCalibrator {
bool CopyProvenance(Provenance& out){
    if(s_provenanceLock.test_and_set(std::memory_order_acquire))return false;
    out=s_provenance;
    const bool valid=out.sequence && out.generation==s_provenanceGeneration.load(std::memory_order_relaxed);
    s_provenanceLock.clear(std::memory_order_release);return valid;
}


void OnProjectileSpawn(void* projProps, void* localPlayer)
{
    if (!projProps) return;
    s_projProps.store(projProps, std::memory_order_relaxed);

    // Read projId immediately while the pointer is hot.
    __try {
        s_profile.projId = *reinterpret_cast<int32_t*>(
            reinterpret_cast<uint8_t*>(projProps) + RuntimeOffsets::PP_ProjId);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        s_profile.projId = 0;
    }

    // Calibrate immediately — projProps is a managed IL2CPP object that may be
    // collected or reused before the next render tick, so we must read it now.
    Recalculate(localPlayer,true);
}

void Tick(void* localPlayer)
{
    // Re-read player multipliers each frame (speed/lifetime buffs can change).
    // projProps is already cached; only re-runs Recalculate, which is fast.
    Recalculate(localPlayer,false);
}

const WeaponProfile& GetProfile()
{
    return s_profile;
}

void Reset()
{
    s_provenanceGeneration.fetch_add(1,std::memory_order_relaxed);
    s_projProps.store(nullptr, std::memory_order_relaxed);
    s_profile = WeaponProfile{};
}

} // namespace WeaponCalibrator
