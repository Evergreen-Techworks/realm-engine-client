#include "pch-il2cpp.h"
#include "GhostHit.h"
#include "../../movement/dodge/ProjectileTracking.h"
#include "DodgeHit.h"
#include "DodgeGeometry.h"
#include "XDodge.h"
#include "RolloutDodge.h"
#include "SpeedHack.h"
#include "gui/tabs/WorldTAB.h"   // WorldProjectile
#include "IpcBridge.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <vector>
#include <windows.h>

namespace GhostHit {

// ── Tunables ─────────────────────────────────────────────────────────────────
//
// kHitPadTiles — extra margin on top of (bulletHalf + playerHalf). Small
//                positive value catches grazes that the game's exact check
//                missed by a few-hundredths-of-a-tile due to frame timing.
//                Don't go too high or you'll emit hits for bullets the game
//                correctly resolved as misses → double damage.
// kSignaledTtlMs — how long after emitting a hit for (owner, bulletId) we
//                  ignore the same pair. Long enough to cover the bullet's
//                  full lifetime; short enough that ids can be recycled.
//
constexpr float    kHitPadTiles    = 0.04f;
constexpr uint64_t kSignaledTtlMs  = 2500;
constexpr int      kPrevMapSize    = 512;
constexpr int      kSignaledMapSize = 256;

// ── State ────────────────────────────────────────────────────────────────────

struct PrevPos {
    int32_t  bulletId = 0;
    float    x = 0.f;
    float    y = 0.f;
    uint64_t whenMs = 0;
    bool     used = false;
};

struct SignaledKey {
    int32_t  ownerId  = 0;
    int32_t  bulletId = 0;
    uint64_t whenMs   = 0;
    bool     used     = false;
};

static PrevPos     s_prev[kPrevMapSize];
static SignaledKey s_signaled[kSignaledMapSize];
static std::atomic<bool> s_enabled{ true };

// ── Helpers ──────────────────────────────────────────────────────────────────

// Open-addressed lookup keyed by bulletId — collision-skip on mismatch.
static PrevPos* PrevSlotFor(int32_t bulletId)
{
    int i = (bulletId & 0x7fffffff) % kPrevMapSize;
    for (int n = 0; n < kPrevMapSize; ++n, i = (i + 1) % kPrevMapSize) {
        if (s_prev[i].used && s_prev[i].bulletId == bulletId) return &s_prev[i];
        if (!s_prev[i].used) {
            s_prev[i] = PrevPos{};
            s_prev[i].bulletId = bulletId;
            s_prev[i].used = true;
            return &s_prev[i];
        }
    }
    return nullptr;
}

static bool IsSignaled(int32_t ownerId, int32_t bulletId, uint64_t nowMs)
{
    for (const auto& s : s_signaled) {
        if (!s.used) continue;
        if (s.ownerId == ownerId && s.bulletId == bulletId
            && (nowMs - s.whenMs) < kSignaledTtlMs)
            return true;
    }
    return false;
}

static void MarkSignaled(int32_t ownerId, int32_t bulletId, uint64_t nowMs)
{
    // First try to find a stale or empty slot.
    int oldestIdx = 0;
    uint64_t oldestMs = UINT64_MAX;
    for (int i = 0; i < kSignaledMapSize; ++i) {
        if (!s_signaled[i].used || (nowMs - s_signaled[i].whenMs) >= kSignaledTtlMs) {
            s_signaled[i] = SignaledKey{ ownerId, bulletId, nowMs, true };
            return;
        }
        if (s_signaled[i].whenMs < oldestMs) {
            oldestMs = s_signaled[i].whenMs;
            oldestIdx = i;
        }
    }
    // Fall back: evict oldest in-use slot.
    s_signaled[oldestIdx] = SignaledKey{ ownerId, bulletId, nowMs, true };
}

// ── Public API ───────────────────────────────────────────────────────────────

static bool PhaseThroughPossible()
{
    return SpeedHack::IsActive() || XDodge::IsEnabled() || RolloutDodge::IsEnabled();
}

void Tick(void* /*player*/, float playerX, float playerY)
{
    if (!s_enabled.load(std::memory_order_relaxed)) return;
    if (!PhaseThroughPossible()) return;

    std::vector<WorldProjectile> projs;
    ProjectileTracking::CopyActiveForDraw(projs);
    if (projs.empty()) return;

    const uint64_t nowMs = GetTickCount64();

    for (const auto& b : projs) {
        if (!b.valid) continue;

        // Predicted current position via the same model the dodge uses.
        // Falls back to the live (b.x, b.y) if ComputePosAt returns NaN.
        const float elapsed = static_cast<float>(
            nowMs > b.spawnTick ? nowMs - b.spawnTick : 0u);
        float curX = b.x, curY = b.y;
        ProjectileTracking::ComputePosAtSafe(b, elapsed, curX, curY);
        if (!std::isfinite(curX) || !std::isfinite(curY)) {
            curX = b.x; curY = b.y;
        }

        // Previous position — first sighting uses the current pos so the
        // swept segment has zero length and we degrade gracefully to a
        // point-check.
        PrevPos* prev = PrevSlotFor(b.bulletId);
        if (!prev) continue;
        const float prevX = (prev->whenMs > 0) ? prev->x : curX;
        const float prevY = (prev->whenMs > 0) ? prev->y : curY;

        // Effective hit radius — bullet's Chebyshev half + player half + pad.
        // Matches the danger-grid stamping envelope (sans the catalog
        // inflation we hard-disabled).
        const float effHalf = DodgeHit::EffectiveHalf(b, 1.f, kHitPadTiles);

        // Swept-segment-to-point distance. If the closest approach of the
        // bullet's segment to the player is inside the combined hitbox,
        // this is a hit the game's per-frame check could have missed if
        // the bullet's per-tick step exceeded the hitbox diameter.
        const float minDist = DodgeGeometry::MinDistPointToSegment(
            playerX, playerY, prevX, prevY, curX, curY);
        if (minDist < effHalf) {
            if (!IsSignaled(b.attackerObjId, b.bulletId, nowMs)) {
                MarkSignaled(b.attackerObjId, b.bulletId, nowMs);
                IpcBridge_EmitPredictedHit(b.attackerObjId, b.bulletId);
            }
        }

        // Update prev for next tick's segment.
        prev->x = curX;
        prev->y = curY;
        prev->whenMs = nowMs;
    }
}

void SetEnabled(bool en) { s_enabled.store(en, std::memory_order_relaxed); }
bool IsEnabled()         { return s_enabled.load(std::memory_order_relaxed); }

}  // namespace GhostHit
