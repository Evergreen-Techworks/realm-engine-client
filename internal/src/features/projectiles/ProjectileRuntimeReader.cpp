#include "pch-il2cpp.h"

#include "ProjectileRuntimeReader.h"
#include "ProjectileTrajectory.h"
#include "RuntimeOffsets.h"
#include "gui/tabs/WorldTAB.h"

#include <cmath>

namespace {

static bool AddrOk(const void* p)
{
    const uintptr_t a = reinterpret_cast<uintptr_t>(p);
    return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
}

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
    if (AddrOk(projectilePtr)) {
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
    if (AddrOk(projectilePtr)) {
        __try {
            void* props = *reinterpret_cast<void**>(
                reinterpret_cast<uint8_t*>(projectilePtr) + RuntimeOffsets::Hbeak_ProjPropsPtr);
            if (AddrOk(props)) return props;
        } __except (EXCEPTION_EXECUTE_HANDLER) {}
    }
    return fallbackProps;
}

bool TryReadRuntimeChebyshevHalf(void* projectilePtr, float& outHalf)
{
    outHalf = 0.f;
    if (!AddrOk(projectilePtr)) return false;
    const uint32_t off = RuntimeOffsets::Hbeak_ProjRadius;
    if (off == 0u || off >= 0x8000u) return false;
    __try {
        const float half = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(projectilePtr) + off);
        if (half > 1e-4f && half < 16.f && std::isfinite(half)) {
            outHalf = half;
            return true;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
    return false;
}

bool ApplyProperties(WorldProjectile& dst, void* projectilePtr, void* projProps,
                     ProjectileCollisionFallback collisionFallback)
{
    if (!AddrOk(projProps)) return false;
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
        dst.minDamage = *reinterpret_cast<int32_t*>(props + RuntimeOffsets::PP_MinDamage);
        dst.damage = *reinterpret_cast<int32_t*>(props + RuntimeOffsets::PP_MaxDamage);
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
            if (AddrOk(customHitbox)) {
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
