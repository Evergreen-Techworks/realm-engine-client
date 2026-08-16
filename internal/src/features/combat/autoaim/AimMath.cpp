#include "pch-il2cpp.h"

#include "AimMath.h"
#include "RuntimeOffsets.h"
#include "core/runtime/MemRead.h"
#include "ProjectileTracking.h"

#include <cmath>
#include <cstdint>

namespace AimMath {

float QuadraticIntercept(float px, float py,
                         float ex, float ey,
                         float vx, float vy,
                         float speed,
                         float& outAimX, float& outAimY,
                         float maxLeadSeconds)
{
    const float dx = ex - px, dy = ey - py;
    const float a  = vx * vx + vy * vy - speed * speed;
    const float b  = 2.f * (dx * vx + dy * vy);
    const float c  = dx * dx + dy * dy;

    float t = -1.f;
    if (fabsf(a) < 1e-5f) {
        // Near-linear: enemy speed ≈ proj speed
        if (fabsf(b) > 1e-9f) t = -c / b;
    } else {
        const float disc = b * b - 4.f * a * c;
        if (disc >= 0.f) {
            const float sqD = sqrtf(disc);
            const float t1  = (-b + sqD) / (2.f * a);
            const float t2  = (-b - sqD) / (2.f * a);
            if (t2 > 0.f && (t1 <= 0.f || t2 < t1))
                t = t2;
            else if (t1 > 0.f)
                t = t1;
        }
    }

    if (t > 0.f && t <= maxLeadSeconds) {
        outAimX = ex + vx * t;
        outAimY = ey + vy * t;
        return t;
    }
    outAimX = ex;
    outAimY = ey;
    return -1.f;
}

static float ResolveLinearAccel(uint8_t* pp)
{
    const float a = Mem::ReadOr<float>(pp, RuntimeOffsets::PP_Acceleration, 0.f);
    if (std::isfinite(a) && fabsf(a) > 1e-6f) return a;

    const float ai = Mem::ReadOr<float>(pp, RuntimeOffsets::PP_AccelerationInv, 0.f);
    if (std::isfinite(ai) && fabsf(ai) > 1e-12f) return 1.f / ai;

    const float vr = Mem::ReadOr<float>(pp, RuntimeOffsets::PP_VelocityChangeRate, 0.f);
    if (std::isfinite(vr) && fabsf(vr) > 1e-6f) return vr;

    const float vi = Mem::ReadOr<float>(pp, RuntimeOffsets::PP_VelocityChangeRateInv, 0.f);
    if (std::isfinite(vi) && fabsf(vi) > 1e-12f) return 1.f / vi;

    return 0.f;
}

float IntegratedProjectileDistance(uint8_t* projProps, float lifetimeMs, float speedMul, float rawSpeed)
{
    const float clampedMul = (speedMul > 1e-6f && speedMul < 100.f) ? speedMul : 1.f;
    const float baseTpMs   = (rawSpeed / 10000.f) * clampedMul;
    if (!(lifetimeMs > 0.f)) return 0.f;

    float accel = ResolveLinearAccel(projProps);
    const bool isBoomerang = Mem::ReadOr<bool>(projProps, RuntimeOffsets::PP_IsBoomerang, false);
    if (fabsf(accel) <= 1e-6f && isBoomerang && lifetimeMs > 1e-3f && rawSpeed > 1.f && rawSpeed <= 50000.f)
        accel = -2.f * rawSpeed / lifetimeMs;

    if (fabsf(accel) <= 1e-6f)
        return lifetimeMs * baseTpMs;

    const float accelTpMs2 = (accel / 1000000.f) * clampedMul;
    const float rawDelay   = Mem::ReadOr<float>(projProps, RuntimeOffsets::PP_AccelDelay, 0.f);
    const float delayMs    = ProjectileTracking::NormalizeAccelDelayMs(rawDelay);
    const float scaledDelay = (delayMs > 0.f) ? delayMs / clampedMul : 0.f;

    if (lifetimeMs <= scaledDelay)
        return lifetimeMs * baseTpMs;

    const float seg0       = scaledDelay * baseTpMs;
    const float accelTime  = lifetimeMs - scaledDelay;
    float accelDist = baseTpMs * accelTime + 0.5f * accelTpMs2 * accelTime * accelTime;

    const float clampVal = Mem::ReadOr<float>(projProps, RuntimeOffsets::PP_SpeedClamp, 0.f);
    if (clampVal > 0.f && std::isfinite(clampVal)) {
        const float clampTpMs = (clampVal / 1000.f) * clampedMul;
        if (accelTpMs2 > 1e-12f && clampTpMs > baseTpMs) {
            const float tToClamp = (clampTpMs - baseTpMs) / accelTpMs2;
            if (tToClamp > 0.f && accelTime > tToClamp) {
                const float pre = baseTpMs * tToClamp + 0.5f * accelTpMs2 * tToClamp * tToClamp;
                accelDist = pre + clampTpMs * (accelTime - tToClamp);
            }
        } else if (accelTpMs2 < -1e-12f && clampTpMs < baseTpMs && clampTpMs >= 0.f) {
            const float tToFloor = (baseTpMs - clampTpMs) / (-accelTpMs2);
            if (tToFloor > 0.f && accelTime > tToFloor) {
                const float toFloor = baseTpMs * tToFloor + 0.5f * accelTpMs2 * tToFloor * tToFloor;
                accelDist = toFloor + clampTpMs * (accelTime - tToFloor);
            }
        }
    } else if (accelTpMs2 < 0.f) {
        const float tToStop = baseTpMs / (-accelTpMs2);
        if (tToStop > 0.f && accelTime > tToStop)
            accelDist = baseTpMs * tToStop + 0.5f * accelTpMs2 * tToStop * tToStop;
    }

    return seg0 + accelDist;
}

} // namespace AimMath
