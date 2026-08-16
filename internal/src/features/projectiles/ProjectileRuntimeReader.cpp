#include "pch-il2cpp.h"

#include "ProjectileRuntimeReader.h"
#include "ProjectileTrajectory.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "game/objects/GameObjects.h"
#include "gui/tabs/WorldTAB.h"

#include <cmath>

namespace {

// Hot-loop guard: `props` is validated by the caller (ApplyProperties null-checks
// projProps and runs the whole field sweep inside one __try). The raw reads below
// stay raw on purpose — a fault mid-sweep must abort the whole apply (return
// false via the outer __except), which per-field Mem::ReadOr fallbacks would not
// reproduce. See the note in ApplyProperties.
static void ReadCollisionHalf(WorldProjectile& dst, void* projectilePtr, uint8_t* props,
                              ProjectileCollisionFallback fallbackMode)
{
    float collMult = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_CollMult);
    if (!std::isfinite(collMult) || collMult <= 0.f || collMult > 20.f)
        collMult = 1.0f;

    const float magnitude = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Magnitude);
    dst.magnitude = magnitude;

    float baseRadius = 0.f;
    float scale = 0.f;
    float skinWidth = 0.f;
    if (Mem::AddrOk(projectilePtr)) {
        __try {
            uint8_t* proj = reinterpret_cast<uint8_t*>(projectilePtr);
            if (RuntimeOffsets::KJ_BaseRadius && RuntimeOffsets::KJ_BaseRadius < 0x8000)
                baseRadius = *reinterpret_cast<float*>(proj + RuntimeOffsets::KJ_BaseRadius);
            if (RuntimeOffsets::KJ_Scale && RuntimeOffsets::KJ_Scale < 0x8000)
                scale = *reinterpret_cast<float*>(proj + RuntimeOffsets::KJ_Scale);
            if (RuntimeOffsets::KJ_SkinWidthObj && RuntimeOffsets::KJ_SkinWidthObj < 0x8000)
                skinWidth = *reinterpret_cast<float*>(proj + RuntimeOffsets::KJ_SkinWidthObj);
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }

    if (std::isfinite(baseRadius) && baseRadius > 0.01f && baseRadius < 4.f &&
        std::isfinite(scale) && scale > 0.01f && scale < 20.f) {
        dst.projHalfSize = baseRadius * scale;
    } else if (fallbackMode == ProjectileCollisionFallback::WorldManager) {
        const float magnitudeFallback = (magnitude > 0.f) ? magnitude * 0.10f : collMult;
        dst.projHalfSize = (skinWidth > 0.f) ? skinWidth : magnitudeFallback;
    } else {
        dst.projHalfSize = collMult * 0.5f;
    }
}

} // namespace

namespace ProjectileRuntimeReader {

void* EffectivePropsFromProjectile(void* projectilePtr, void* fallbackProps)
{
    // Projectile::Props() wraps Mem::ReadPtr — nullptr unless the read succeeds AND
    // the result is itself AddrOk, matching the old read + AddrOk(props) guard exactly.
    void* props = Game::Projectile(projectilePtr).Props();
    if (props) return props;
    return fallbackProps;
}

bool TryReadRuntimeChebyshevHalf(void* projectilePtr, float& outHalf)
{
    outHalf = 0.f;
    const uint32_t off = RuntimeOffsets::Hbeak_ProjRadius;
    if (off == 0u || off >= 0x8000u) return false;
    float half = 0.f;
    if (!Mem::TryRead(projectilePtr, off, half)) return false;
    if (half > 1e-4f && half < 16.f && std::isfinite(half)) {
        outHalf = half;
        return true;
    }
    return false;
}

bool TryReadLiveDamage(void* projectilePtr, int32_t& outDamage)
{
    outDamage = 0;
    // HBEAKBIHANL.DBNNDLKNECM — per-instance damage Int32 (confirmed correct field).
    // Read live at draw time; the game populates it shortly after spawn. Projectile::
    // Damage() returns 0 on a faulted/unresolved read, which the range check rejects
    // exactly as the old Mem::TryRead-failure path did.
    const int32_t dmg = Game::Projectile(projectilePtr).Damage();
    if (dmg > 0 && dmg < 1000000) {
        outDamage = dmg;
        return true;
    }
    return false;
}

bool ApplyProperties(WorldProjectile& dst, void* projectilePtr, void* projProps,
                     ProjectileCollisionFallback collisionFallback)
{
    if (!Mem::AddrOk(projProps)) return false;
    // Hot-loop guard: the entire ~40-field sweep of the validated `props` pointer
    // runs inside this one __try. The reads stay raw *reinterpret_cast on purpose
    // — a fault on any field must abort the whole apply (return false via the
    // __except), and per-field Mem::TryRead/ReadOr would instead continue with
    // fallbacks and report success, which is not behavior-preserving here.
    __try {
        uint8_t* props = reinterpret_cast<uint8_t*>(projProps);
        dst.projPropsPtr = projProps;
        dst.lifetime = ProjectileTrajectory::NormalizeLifetimeMs(
            *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Lifetime));
        dst.speed = static_cast<float>(*reinterpret_cast<int32_t*>(props + RuntimeOffsets::PP_Speed));
        dst.wavy = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsWavy);
        dst.hasCustomAmplitude = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_HasCustomAmplitude);
        dst.boomerang = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsBoomerang);
        dst.parametric = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsParametric);
        dst.frequency = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Frequency);
        dst.amplitude = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Amplitude);
        // Damage: HBEAKBIHANL.DBNNDLKNECM (per-instance). May still be 0 at spawn
        // time; the authoritative value is refreshed live at draw time via
        // TryReadLiveDamage (see ProjectileStore::FillOutFromSlot).
        dst.damage = 0;
        dst.minDamage = 0;
        if (Mem::AddrOk(projectilePtr)) {
            int32_t instDamage = *reinterpret_cast<int32_t*>(
                reinterpret_cast<uint8_t*>(projectilePtr) + RuntimeOffsets::Hbeak_InstanceDamage);
            if (instDamage > 0) {
                dst.damage = instDamage;
                dst.minDamage = instDamage;
            }
        }
        dst.isAccelerating = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsAccel);
        dst.useAccel = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_UseAccel);
        dst.acceleration = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Acceleration);
        dst.accelerationInv = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_AccelerationInv);
        dst.velocityChangeRate = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_VelocityChangeRate);
        dst.velocityChangeRateInv = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_VelocityChangeRateInv);
        dst.accelDelay = ProjectileTrajectory::NormalizeAccelDelayMs(
            *reinterpret_cast<float*>(props + RuntimeOffsets::PP_AccelDelay));
        dst.speedClamp = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_SpeedClamp);
        ReadCollisionHalf(dst, projectilePtr, props, collisionFallback);

        const float laserDist = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_LaserDist);
        dst.laserDistance = (laserDist > 1e-4f && std::isfinite(laserDist)) ? laserDist : 0.f;
        dst.laser = dst.laserDistance > 1e-3f;
        dst.isTurning = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsTurning);
        dst.isCircleTurnDelayed = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsTurning + 1);
        dst.isTurningDelayed = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsTurningDelayed);
        dst.turnSnapsToStraight = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsTurning + 5);
        dst.isTurningAccelerated = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsTurning + 3);
        dst.turnRate = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnRate);
        if (!std::isfinite(dst.turnRate)) dst.turnRate = 0.f;

        const float turnStopTime = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnStopTime);
        dst.turnStopTime = (std::isfinite(turnStopTime) && turnStopTime > 0.f) ? turnStopTime : 0.f;
        dst.turnRateDelay = ProjectileTrajectory::NormalizeAccelDelayMs(
            *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnRateDelay));
        const float circleTurnAngle = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_CircleTurnAngle);
        dst.circleTurnAngle = std::isfinite(circleTurnAngle) ? circleTurnAngle : 0.f;
        const float circleTurnDelay = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_CircleTurnDelay);
        dst.circleTurnDelay = (std::isfinite(circleTurnDelay) && circleTurnDelay > 0.f) ? circleTurnDelay : 0.f;
        const float turnAcceleration = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnAcceleration);
        dst.turnAcceleration = std::isfinite(turnAcceleration) ? turnAcceleration : 0.f;
        const float turnAccelDelay = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnAccelDelay);
        dst.turnAccelDelay = std::isfinite(turnAccelDelay) ? turnAccelDelay : 0.f;
        const float turnClamp = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnClamp);
        dst.turnClamp = std::isfinite(turnClamp) ? turnClamp : 0.f;
        const float turnAccelInv = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_TurnAccelInv);
        dst.turnAccelInv = std::isfinite(turnAccelInv) ? turnAccelInv : 0.f;

        dst.hasCustomHitbox = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_HasCustomHitbox);
        if (dst.hasCustomHitbox) {
            void* customHitbox = *reinterpret_cast<void**>(props + RuntimeOffsets::PP_CustomHitbox);
            if (Mem::AddrOk(customHitbox)) {
                uint8_t* hitbox = reinterpret_cast<uint8_t*>(customHitbox);
                dst.customOffsetX = *reinterpret_cast<float*>(hitbox + RuntimeOffsets::CH_OffsetX);
                dst.customOffsetY = *reinterpret_cast<float*>(hitbox + RuntimeOffsets::CH_OffsetY);
                const float hx = fabsf(dst.customOffsetX);
                const float hy = fabsf(dst.customOffsetY);
                dst.projHalfSize = (hx > hy) ? hx : hy;
            }
        }

        TryReadRuntimeChebyshevHalf(projectilePtr, dst.runtimeChebyshevHalf);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return false;
}

} // namespace ProjectileRuntimeReader
