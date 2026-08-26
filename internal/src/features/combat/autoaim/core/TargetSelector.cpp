#include "pch-il2cpp.h"

#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/core/AimMath.h"
#include "features/combat/enemytracker/EnemyTracker.h"
#include "gui/tabs/TestTAB.h"

#include <cmath>
#include <cstdint>

namespace {

// ── Object type helpers (mirrors EnemyTracker constants, kept local to avoid coupling) ──
static constexpr int32_t kQuestTypes[] = {
    1337, 2048, 2340, 2349, 3448, 3449, 3452, 3613, 3622, 4312,
    4324, 4325, 4326, 5943, 8200, 24092, 24327, 24351, 24363, 24587,
    29003, 29021, 29039, 29341, 29342, 29723, 29764, 30026, 45104, 45371,
    45076, 28618, 28619, 32751, 29793
};
static constexpr int32_t kWhitelistedTypes[] = { 31104 };
static constexpr int32_t kFallbackTypes[]    = { 2928 };

static bool IsQuestType(int32_t t) {
    for (int32_t q : kQuestTypes) if (q == t) return true;
    return false;
}
static bool IsWhitelistedType(int32_t t) {
    for (int32_t v : kWhitelistedTypes) if (v == t) return true;
    return false;
}
static bool IsFallbackType(int32_t t) {
    for (int32_t v : kFallbackTypes) if (v == t) return true;
    return false;
}

// The weapon's own selection radius, before any lead bias or cap. Factored out
// of Select() so KillAuraSelectionRangeTiles() cannot drift from the number
// Select() actually filters on. The 15.0 fallback covers a profile whose
// rangeTiles is a placeholder or nonsense; callers that must not act on a
// placeholder check WeaponProfile::isResolved themselves.
static float WeaponSelectionRange(const WeaponProfile& weapon)
{
    return (weapon.rangeTiles > 2.f) ? weapon.rangeTiles : 15.f;
}

struct TierState {
    float   bestDist = 0.f;
    int32_t bestHp   = -1;
    float   bestX = 0.f, bestY = 0.f;
    float   bestVx = 0.f, bestVy = 0.f;
    int32_t bestId = 0;
    int32_t bestObjType = 0;
    bool    found = false;
};

static void TierUpdate(TierState& tier, bool useHighestHp,
                       float distSq, int32_t hp,
                       float x, float y, float vx, float vy,
                       int32_t id, int32_t objType)
{
    bool better = false;
    if (!tier.found) {
        better = true;
    } else if (useHighestHp) {
        better = hp > tier.bestHp || (hp == tier.bestHp && distSq < tier.bestDist);
    } else {
        better = distSq < tier.bestDist;
    }
    if (!better) return;
    tier.found = true; tier.bestDist = distSq; tier.bestHp = hp;
    tier.bestX = x; tier.bestY = y; tier.bestVx = vx; tier.bestVy = vy;
    tier.bestId = id; tier.bestObjType = objType;
}

} // namespace

namespace TargetSelector {

Result Select(const Config& cfg,
              float playerX, float playerY,
              float mouseX,  float mouseY,
              const WeaponProfile& weapon)
{
    const std::vector<EnemyTracker::Entry>& snap = EnemyTracker::GetSnapshot();

    // ── Locked mode: bypass all tier logic ──────────────────────────────────
    if (cfg.mode == Mode::Locked && cfg.lockedEnemyId >= 0) {
        for (const EnemyTracker::Entry& e : snap) {
            if (e.id != cfg.lockedEnemyId) continue;
            if (cfg.ignoreWalls && !e.hasHealthBar) break;
            if (e.isInvulnerable && !cfg.shootInvulnerable) break;

            Result r;
            r.found   = true;
            r.enemyId = e.id;
            r.objType = e.objType;

            const float vxTps = e.vx * 1000.f, vyTps = e.vy * 1000.f;
            const float spd      = (weapon.avgSpeedTps > 0.1f) ? weapon.avgSpeedTps : 10.f;
            const float maxLead  = (weapon.lifetimeMs  > 0.f)  ? weapon.lifetimeMs / 1000.f : 2.f;
            if (vxTps != 0.f || vyTps != 0.f)
                AimMath::QuadraticIntercept(playerX, playerY, e.x, e.y, vxTps, vyTps, spd, r.aimX, r.aimY, maxLead);
            else { r.aimX = e.x; r.aimY = e.y; }
            return r;
        }
        // Lock target gone/invalid — fall through to normal selection
    }

    // ── Reference point and range ────────────────────────────────────────────
    const bool useMouseRef  = (cfg.mode == Mode::ClosestToMouse);
    const bool useHighestHp = (cfg.mode == Mode::HighestHP);

    float refX = playerX, refY = playerY;
    if (useMouseRef) {
        const float mx = TestTAB::GetMouseWorldX();
        const float my = TestTAB::GetMouseWorldY();
        if (mx != 0.f || my != 0.f) { refX = mx; refY = my; }
    }

    float maxRange = WeaponSelectionRange(weapon) + cfg.rangeLeadBias;
    if (useMouseRef && cfg.mouseBoundingEnabled && cfg.mouseBoundingRange > 0.f
        && cfg.mouseBoundingRange < maxRange)
        maxRange = cfg.mouseBoundingRange;
    // SHRINK-ONLY, same shape as the mouse bound above: a cap may pull the
    // radius in, never push it out past what the weapon can actually reach.
    if (cfg.maxRangeCapTiles > 0.f && cfg.maxRangeCapTiles < maxRange)
        maxRange = cfg.maxRangeCapTiles;
    const float maxRangeSq = maxRange * maxRange;

    // ── Four-tier accumulation ───────────────────────────────────────────────
    TierState quest, normal, fallback, invuln;

    for (const EnemyTracker::Entry& e : snap) {
        // Phase-skip filter
        for (int i = 0; i < cfg.skipObjCount; ++i)
            if (e.objType == cfg.skipObjTypes[i]) goto next_entry;

        // Soft filters
        if (cfg.ignoreWalls && !e.hasHealthBar) goto next_entry;
        if (e.isInvulnerable && !cfg.shootInvulnerable) goto next_entry;

        {
            const float dx = e.x - refX, dy = e.y - refY;
            const float distSq = dx * dx + dy * dy;
            if (distSq > maxRangeSq) goto next_entry;

            const bool isQuest      = IsQuestType(e.objType);
            const bool whitelisted  = IsWhitelistedType(e.objType);
            const bool isFallback   = IsFallbackType(e.objType);

            if (cfg.prioritizeBosses && isQuest && !whitelisted) {
                TierUpdate(quest, useHighestHp, distSq, e.hp, e.x, e.y, e.vx, e.vy, e.id, e.objType);
            } else if (e.isInvulnerable) {
                // Only reachable when shootInvulnerable == true (filtered above otherwise)
                TierUpdate(invuln, useHighestHp, distSq, e.hp, e.x, e.y, e.vx, e.vy, e.id, e.objType);
            } else if (isFallback) {
                TierUpdate(fallback, useHighestHp, distSq, e.hp, e.x, e.y, e.vx, e.vy, e.id, e.objType);
            } else {
                // Normal tier: non-quest, non-fallback, non-invuln, and
                // whitelisted-quest or prioritizeBosses-off quest entities
                TierUpdate(normal, useHighestHp, distSq, e.hp, e.x, e.y, e.vx, e.vy, e.id, e.objType);
            }
        }
        next_entry:;
    }

    // ── Priority resolution: quest > normal > fallback > invuln ──────────────
    const TierState* winner = nullptr;
    if (quest.found)                          winner = &quest;
    else if (normal.found)                    winner = &normal;
    else if (fallback.found)                  winner = &fallback;
    else if (invuln.found)                    winner = &invuln;

    if (!winner) return {};

    Result r;
    r.found   = true;
    r.enemyId = winner->bestId;
    r.objType = winner->bestObjType;

    // Apply lead prediction
    const float vxTps   = winner->bestVx * 1000.f;
    const float vyTps   = winner->bestVy * 1000.f;
    const float spd     = (weapon.avgSpeedTps > 0.1f) ? weapon.avgSpeedTps : 10.f;
    const float maxLead = (weapon.lifetimeMs  > 0.f)  ? weapon.lifetimeMs / 1000.f : 2.f;
    if (vxTps != 0.f || vyTps != 0.f)
        AimMath::QuadraticIntercept(playerX, playerY,
                                    winner->bestX, winner->bestY,
                                    vxTps, vyTps, spd,
                                    r.aimX, r.aimY, maxLead);
    else { r.aimX = winner->bestX; r.aimY = winner->bestY; }

    return r;
}

Result SelectKillAura(bool atMouse, float rangeCapTiles,
                      float playerX, float playerY,
                      int32_t forcedEnemyId,
                      const WeaponProfile& weapon)
{
    Config cfg;
    cfg.mode                 = forcedEnemyId != 0 ? Mode::Locked
                             : (atMouse ? Mode::ClosestToMouse : Mode::ClosestToPlayer);
    cfg.lockedEnemyId        = forcedEnemyId != 0 ? forcedEnemyId : -1;
    cfg.shootInvulnerable    = false;
    cfg.prioritizeBosses     = false;
    // A forced target may be a breakable wall (noHealthBar) — do not filter it.
    cfg.ignoreWalls          = (forcedEnemyId == 0);
    cfg.mouseBoundingEnabled = false;
    cfg.maxRangeCapTiles     = (rangeCapTiles > 0.f) ? rangeCapTiles : 0.f;

    Result r = Select(cfg, playerX, playerY, 0.f, 0.f, weapon);
    // Select()'s Locked branch falls through to normal selection when the lock
    // is gone. That is right for AutoAim (keep shooting) but wrong here: a
    // forced killaura target must be reported as GONE, never silently swapped
    // for a live enemy the user never chose.
    if (forcedEnemyId != 0 && (!r.found || r.enemyId != forcedEnemyId)) return {};
    return r;
}

float KillAuraSelectionRangeTiles(const WeaponProfile& weapon, float capTiles)
{
    // A default Config carries the SAME rangeLeadBias SelectKillAura leaves in
    // place (it overrides only mode/filters/cap), so reading it back here is
    // what keeps this in lockstep with Select() rather than restating 1.0.
    const Config defaults;
    float r = WeaponSelectionRange(weapon) + defaults.rangeLeadBias;
    if (capTiles > 0.f && capTiles < r) r = capTiles;
    return r;
}

int KillAuraTierRank(int32_t objType)
{
    // SelectKillAura pins prioritizeBosses=false and shootInvulnerable=false,
    // so the quest and invuln tiers are unreachable from that path: only the
    // normal (0) and fallback (1) tiers can ever win there.
    return IsFallbackType(objType) ? 1 : 0;
}

} // namespace TargetSelector
