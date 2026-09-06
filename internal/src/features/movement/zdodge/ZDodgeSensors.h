#pragma once

#include "ZDodgeTypes.h"

#include "features/movement/sensors/TileSensor.h"
#include "gui/tabs/WorldTAB.h"

#include <algorithm>
#include <cmath>

namespace ZDodge::Sensors {

namespace Detail {

// Finiteness / distance primitives live in Movement::TileSensor — this module
// carried its own copies of all three until they were unified. SafeRadius and
// SafeReactWindowMs below stay local: SafeReactWindowMs closes over ZDodge's
// OWN Settings default, so it is not shareable as-is.
using Movement::TileSensor::IsFinite;
using Movement::TileSensor::IsFinitePoint;
using Movement::TileSensor::DistSq;

inline float SafeRadius(float value, float fallback)
{
	if (!IsFinite(value) || value <= 0.f) return fallback;
	return std::clamp(value, 0.02f, 5.f);
}

inline float SafeReactWindowMs(float value)
{
	if (!IsFinite(value) || value <= 0.f) return Settings{}.reactWindowMs;
	return std::clamp(value, 100.f, 2500.f);
}

inline void AddAoeSample(Threat& threat, float x, float y, float tMs)
{
	if (threat.sampleCount >= kMaxPathSamples || !IsFinitePoint(x, y)) return;
	threat.sampleTimesMs[threat.sampleCount] = std::max(0.f, tMs);
	threat.samples[threat.sampleCount++] = { x, y };
	if (!threat.hasBounds) {
		threat.boundsMin = { x, y };
		threat.boundsMax = { x, y };
		threat.hasBounds = true;
	} else {
		threat.boundsMin.x = std::min(threat.boundsMin.x, x);
		threat.boundsMin.y = std::min(threat.boundsMin.y, y);
		threat.boundsMax.x = std::max(threat.boundsMax.x, x);
		threat.boundsMax.y = std::max(threat.boundsMax.y, y);
	}
}

inline void AddThreatSample(Threat& threat, float x, float y, float tMs)
{
	if (threat.sampleCount >= kMaxPathSamples || !IsFinitePoint(x, y)) return;
	threat.sampleTimesMs[threat.sampleCount] = std::max(0.f, tMs);
	threat.samples[threat.sampleCount++] = { x, y };
	if (!threat.hasBounds) {
		threat.boundsMin = { x, y };
		threat.boundsMax = { x, y };
		threat.hasBounds = true;
	} else {
		threat.boundsMin.x = std::min(threat.boundsMin.x, x);
		threat.boundsMin.y = std::min(threat.boundsMin.y, y);
		threat.boundsMax.x = std::max(threat.boundsMax.x, x);
		threat.boundsMax.y = std::max(threat.boundsMax.y, y);
	}
}

inline int CachedPathIndexAtElapsed(const WorldProjectile& projectile, float elapsedMs)
{
	const int count = std::clamp(projectile.pathSampleCount, 0, kWorldProjectilePathSampleCap);
	if (count <= 1) return 0;
	if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return 0;
	int best = 0;
	float bestDelta = 3.402823466e+38f;
	for (int i = 0; i < count; ++i) {
		const float t = projectile.pathSampleTimesMs[i];
		if (!IsFinite(t)) continue;
		const float delta = std::fabs(t - elapsedMs);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = i;
		}
	}
	return best;
}

inline int CachedPathIndexAtLivePositionOrElapsed(const WorldProjectile& projectile, float elapsedMs)
{
	const int count = std::clamp(projectile.pathSampleCount, 0, kWorldProjectilePathSampleCap);
	if (count <= 1) return 0;
	if (!IsFinitePoint(projectile.x, projectile.y)) return -1;

	int best = 0;
	float bestDistSq = 3.402823466e+38f;
	for (int i = 0; i < count; ++i) {
		const float x = projectile.pathX[i];
		const float y = projectile.pathY[i];
		if (!IsFinitePoint(x, y)) continue;
		const float dx = x - projectile.x;
		const float dy = y - projectile.y;
		const float distSq = dx * dx + dy * dy;
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			best = i;
		}
	}

	constexpr float kMaxLiveAnchorDistSq = 25.f;
	if (bestDistSq <= kMaxLiveAnchorDistSq)
		return best;
	// Live position anchoring failed (likely wrong PosX/PosY offsets).
	// Fall back to elapsed-time anchoring using cached path timestamps.
	if (!IsFinite(elapsedMs) || elapsedMs <= 0.f) return -1;
	float bestDelta = 3.402823466e+38f;
	for (int i = 0; i < count; ++i) {
		const float t = projectile.pathSampleTimesMs[i];
		if (!IsFinite(t)) continue;
		const float delta = std::fabs(t - elapsedMs);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = i;
		}
	}
	return best;
}

} // namespace Detail

SensorSnapshot Build(float playerX, float playerY, const Settings& settings);

inline bool AddProjectilePathThreat(Threat& threat, const WorldProjectile& projectile,
	float reactWindowMs, float elapsedMs)
{
	if (!projectile.hasCachedPath || projectile.pathSampleCount < 2) return false;
	if (Detail::IsFinite(projectile.lifetime) && projectile.lifetime > 0.f && elapsedMs >= projectile.lifetime) return false;

	const int count = std::min(projectile.pathSampleCount, kWorldProjectilePathSampleCap);
	const int anchorIdx = Detail::CachedPathIndexAtLivePositionOrElapsed(projectile, elapsedMs);
	if (anchorIdx < 0 || anchorIdx >= count) return false;
	const float anchorX = projectile.pathX[anchorIdx];
	const float anchorY = projectile.pathY[anchorIdx];
	if (!Detail::IsFinitePoint(anchorX, anchorY)) return false;

	const float baseTimeMs = Detail::IsFinite(projectile.pathSampleTimesMs[anchorIdx])
		? projectile.pathSampleTimesMs[anchorIdx]
		: elapsedMs;

	// First sample uses the live world-space position (projectile.x/y).
	// Subsequent samples rebase cached-path deltas onto the live position
	// so the path is correct even when the cache is in offset coordinates.
	Detail::AddThreatSample(threat, projectile.x, projectile.y, 0.f);
	bool  shotEnds  = false;
	bool  spanned   = false;   // the cache reached past the window (coverage complete)
	for (int i = anchorIdx + 1; i < count && threat.sampleCount < kMaxPathSamples; ++i) {
		if (!Detail::IsFinitePoint(projectile.pathX[i], projectile.pathY[i])) break;
		const float sampleTimeMs = projectile.pathSampleTimesMs[i];
		if (!Detail::IsFinite(sampleTimeMs)) break;
		if (Detail::IsFinite(projectile.lifetime) && projectile.lifetime > 0.f && sampleTimeMs > projectile.lifetime) break;
		const float futureMs = std::max(0.f, sampleTimeMs - baseTimeMs);
		if (futureMs > reactWindowMs) { spanned = true; break; }   // cache reaches past the window
		const float dx = projectile.pathX[i] - anchorX;
		const float dy = projectile.pathY[i] - anchorY;
		Detail::AddThreatSample(threat, projectile.x + dx, projectile.y + dy, futureMs);
		shotEnds  = Detail::IsFinite(projectile.lifetime) && projectile.lifetime > 0.f
		         && sampleTimeMs >= projectile.lifetime - 1.f;
	}
	// TIME COVERAGE (cached path is bounded from spawn — WorldTAB.h
	// kWorldProjectilePathCoverMs). A long-lived shot outruns the cache, and a
	// path that stops short of the window while the shot is STILL ALIVE would
	// silently under-state danger. Refuse it (resetting what we appended) so the
	// caller re-samples fresh from positionAt over the full window.
	if (!spanned && !shotEnds && threat.sampleCount < kMaxPathSamples) {
		threat.sampleCount = 0;
		return false;
	}
	return threat.sampleCount >= 2;
}

inline void AddAoeThreats(SensorSnapshot& out, const WorldAoe* aoes, int aoeCount,
	float playerX, float playerY, const Settings& settings, uint64_t nowMs)
{
	if (!aoes || aoeCount <= 0) return;
	const float fallbackRadius = Detail::SafeRadius(settings.projectileRadiusFallback, Settings{}.projectileRadiusFallback);
	const float reactWindowMs = Detail::SafeReactWindowMs(settings.reactWindowMs);

	for (int i = 0; i < aoeCount; ++i) {
		const WorldAoe& a = aoes[i];
		if (!a.valid || !a.isDamaging) continue;
		if (a.isEnemyChecked && !a.isEnemy) continue;
		if (!Detail::IsFinitePoint(a.destX, a.destY)) continue;

		const float elapsedMs = static_cast<float>(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0u);
		const float lifetimeMs = Detail::IsFinite(a.lifetime) && a.lifetime > 0.f ? a.lifetime : 2000.f;
		const float remainingMs = lifetimeMs - elapsedMs;
		if (remainingMs <= 25.f) continue;

		const float radius = Detail::SafeRadius(a.radius, fallbackRadius);
		const float cull = 14.f + radius + std::clamp(settings.playerRadius, 0.f, 2.f);
		if (Detail::DistSq(a.destX, a.destY, playerX, playerY) > cull * cull) continue;
		if (out.threatCount >= kMaxThreats) {
			out.aoeLimited = true;
			return;
		}

		Threat& threat = out.threats[out.threatCount];
		threat.id = 10000 + out.threatCount;
		threat.radius = radius;
		threat.damage = 9999.f;

		const float horizonMs = std::min(reactWindowMs, remainingMs);
		const float stepMs = std::max(16.f, horizonMs / static_cast<float>(kMaxPathSamples - 1));
		for (int sample = 0; sample < kMaxPathSamples; ++sample) {
			const float futureMs = std::min(stepMs * static_cast<float>(sample), horizonMs);
			Detail::AddAoeSample(threat, a.destX, a.destY, futureMs);
			if (futureMs >= horizonMs) break;
		}
		if (threat.sampleCount > 0) ++out.threatCount;
	}
}

} // namespace ZDodge::Sensors
