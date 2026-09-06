#pragma once

#include <cstdint>

// Pure, stateless math utilities for aim lead and projectile range calculations.
namespace AimMath {

// Closed-form quadratic intercept (multitool sub_180003e20 equivalent).
// Solves for the smallest positive t such that |enemyPos + enemyVel*t - playerPos| == speed*t.
// t, enemyVel, and speed are all in the same unit (seconds + tiles/sec, or ms + tiles/ms).
// maxLeadSeconds clamps t so lead never predicts beyond what the projectile can physically reach.
// Returns t > 0 and sets outAimX/Y on success; returns -1 and sets outAimX/Y = enemyPos on failure.
float QuadraticIntercept(float px, float py,
                         float ex, float ey,
                         float vx, float vy,          // enemy velocity (tiles/sec)
                         float speed,                  // projectile speed (tiles/sec)
                         float& outAimX, float& outAimY,
                         float maxLeadSeconds = 2.f);

// Integrates projectile distance accounting for speed, acceleration, deceleration,
// boomerang heuristic, and speed clamps.  Uses RuntimeOffsets::PP_* fields.
// lifetimeMs must already have the player lifetime multiplier applied.
// speedMul is the player projectile speed multiplier.
float IntegratedProjectileDistance(uint8_t* projProps, float lifetimeMs, float speedMul, float rawSpeed);

} // namespace AimMath
