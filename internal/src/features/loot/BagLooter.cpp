#include "pch-il2cpp.h"
#include "BagLooter.h"
#include "DangerPlanner.h"
#include "LocalPlayer.h"
#include "DbgFileLog.h"
#include "gui/tabs/WorldTAB.h"

#include <atomic>
#include <cmath>
#include <Windows.h>

namespace {

// Loot-bag object types, verified against the 86ad651b objects.xml: every
// Class=Container "Loot Bag" object and its Boost variant. The colour is the
// bag's lofiObj4 sprite sampled from mapObjects.png (0xd0-0xd9 base, 0xe0-0xe9
// Boost); Loot Bag 6 is the only white one (its MinimapIcon is 0xFFFFFF), and
// Loot Bag 5 is the dark-blue potion bag (potions carry <BagType>5).
struct BagTypeEntry {
    int32_t            type;
    BagLooter::BagTier tier;
};
constexpr BagTypeEntry kBagTypes[] = {
    { 0x0500, BagLooter::Brown     },   // Loot Bag 0
    { 0x06ad, BagLooter::Brown     },   // Loot Bag 0 Boost
    { 0x0506, BagLooter::Pink      },   // Loot Bag 1
    { 0x06ae, BagLooter::Pink      },   // Loot Bag 1 Boost
    { 0x0507, BagLooter::Purple    },   // Loot Bag 2
    { 0x06ba, BagLooter::Purple    },   // Loot Bag 2 Boost
    { 0x0508, BagLooter::Egg       },   // Loot Bag 3 (egg basket)
    { 0x06bb, BagLooter::Egg       },   // Loot Bag 3 Boost
    { 0x0509, BagLooter::LightBlue },   // Loot Bag 4
    { 0x06bd, BagLooter::LightBlue },   // Loot Bag 4 Boost
    { 0x050b, BagLooter::DarkBlue  },   // Loot Bag 5 (potions)
    { 0x06be, BagLooter::DarkBlue  },   // Loot Bag 5 Boost
    { 0x050c, BagLooter::White     },   // Loot Bag 6
    { 0x0510, BagLooter::White     },   // Loot Bag 6 Boost
    { 0x050e, BagLooter::Gold      },   // Loot Bag 7
    { 0x06bc, BagLooter::Gold      },   // Loot Bag 7 Boost
    { 0x050f, BagLooter::Orange    },   // Loot Bag 8
    { 0x06bf, BagLooter::Orange    },   // Loot Bag 8 Boost
    { 0x06ac, BagLooter::Red       },   // Loot Bag 9
    { 0x06c0, BagLooter::Red       },   // Loot Bag 9 Boost
    { 0x0503, BagLooter::Soulbound },   // Soulbound Loot Bag
};

constexpr int kBagTypeCount = sizeof(kBagTypes) / sizeof(kBagTypes[0]);

std::atomic<bool>  s_enabled       { false };
// Defaults keep every bag walked before still walked: the old Cyan tier was the egg
// basket, old Blue the light-blue bag, and old White held the dark-blue, white,
// gold, orange and red Boost bags. Brown, pink and purple stay off.
std::atomic<bool>  s_tierEnabled[BagLooter::TierCount_] = {
    {false}, {false}, {false},           // Brown, Pink, Purple
    {true},  {true},  {true},  {true},   // Egg, LightBlue, DarkBlue, White
    {true},  {true},  {true},  {true}    // Gold, Orange, Red, Soulbound
};
std::atomic<float> s_maxWalkDist   { 12.f };

std::atomic<int32_t> s_activeBagId      { 0 };
std::atomic<float>   s_activeBagDist    { 0.f };
std::atomic<const char*> s_statusTag    { "off" };

ULONGLONG s_lastTickMs = 0;
constexpr ULONGLONG kTickIntervalMs = 250;
// Distance at which we consider the player "on" the bag — clear the
// external goal so the planner returns to lock-follow / idle. The
// game's pickup-panel proximity is ~0.6 tiles in vanilla, we use 0.4
// to make sure we're squarely on top.
constexpr float kArriveDistTiles = 0.4f;

BagLooter::BagTier TierForType(int32_t objType)
{
    for (int i = 0; i < kBagTypeCount; ++i) {
        if (kBagTypes[i].type == objType) return kBagTypes[i].tier;
    }
    return BagLooter::TierCount_;  // sentinel: not a bag
}

} // namespace

namespace BagLooter {

void Tick()
{
    if (!s_enabled.load(std::memory_order_relaxed)) {
        if (s_activeBagId.load(std::memory_order_relaxed) != 0) {
            DangerPlanner::ClearExternalGoal();
            s_activeBagId.store(0, std::memory_order_relaxed);
            s_activeBagDist.store(0.f, std::memory_order_relaxed);
        }
        s_statusTag.store("off", std::memory_order_relaxed);
        return;
    }

    // Throttled heartbeat log — once every ~5 s while enabled, so the
    // trace shows whether the looter is alive without flooding.
    static ULONGLONG s_lastHeartbeatMs = 0;
    {
        const ULONGLONG hb = GetTickCount64();
        if (hb - s_lastHeartbeatMs >= 5000) {
            s_lastHeartbeatMs = hb;
            DBG_FILE_LOG("[looter] tick heartbeat enabled=1 maxDist="
                         << s_maxWalkDist.load(std::memory_order_relaxed));
        }
    }

    const ULONGLONG now = GetTickCount64();
    if (now - s_lastTickMs < kTickIntervalMs) return;
    s_lastTickMs = now;

    const float playerX = LocalPlayer::GetX();
    const float playerY = LocalPlayer::GetY();
    if (!std::isfinite(playerX) || !std::isfinite(playerY)) {
        s_statusTag.store("no-player", std::memory_order_relaxed);
        return;
    }

    // HP gate — never pursue a bag when health is critical. Bags aren't
    // worth dying for, and the planner's external-engagement mode
    // commits through ambient threat (threatScale=0.6), which is the
    // wrong call when one more hit kills you.
    {
        const int32_t hp    = LocalPlayer::GetHP();
        const int32_t maxHp = LocalPlayer::GetMaxHP();
        if (hp > 0 && maxHp > 0) {
            const float pct = static_cast<float>(hp) / static_cast<float>(maxHp);
            if (pct < 0.40f) {
                if (s_activeBagId.load(std::memory_order_relaxed) != 0) {
                    DangerPlanner::ClearExternalGoal();
                    s_activeBagId.store(0, std::memory_order_relaxed);
                    s_activeBagDist.store(0.f, std::memory_order_relaxed);
                }
                s_statusTag.store("hp-gated", std::memory_order_relaxed);
                return;
            }
        }
    }

    // Force-refresh the entity snapshot before scanning. Without this,
    // WorldTAB::GetEntities() returns whatever was last refreshed by
    // the World tab's UI render path — which only runs while the World
    // tab is visible. With the menu closed the snapshot is stale or
    // empty, so the looter would see no bags. ForceRefresh self-
    // coalesces to 50 ms, fine to call at our 250 ms tick cadence.
    WorldTAB::ForceRefresh();
    const std::vector<WorldEntity>& ents = WorldTAB::GetEntities();
    const float maxDist = s_maxWalkDist.load(std::memory_order_relaxed);
    const float maxDistSq = maxDist * maxDist;

    int32_t bestId   = 0;
    float   bestX    = 0.f, bestY = 0.f;
    float   bestSq   = maxDistSq;
    BagTier bestTier = TierCount_;

    int seenAny = 0, seenEnabledTier = 0, seenInRange = 0;
    for (const auto& e : ents) {
        const BagTier tier = TierForType(e.objType);
        if (tier == TierCount_) continue;
        ++seenAny;
        if (!s_tierEnabled[tier].load(std::memory_order_relaxed)) continue;
        ++seenEnabledTier;

        const float dx = e.x - playerX;
        const float dy = e.y - playerY;
        const float distSq = dx * dx + dy * dy;
        if (distSq > maxDistSq) continue;
        ++seenInRange;

        // Tier priority: a later tier wins ties; closer wins within a tier.
        // Each tier step is worth 16 tiles² of squared distance.
        const float rankSq = distSq - static_cast<float>(tier) * 16.f;
        if (rankSq < bestSq) {
            bestSq   = rankSq;
            bestId   = e.objectId;
            bestX    = e.x;
            bestY    = e.y;
            bestTier = tier;
        }
    }

    if (bestId == 0) {
        // One-shot log when scan transitions from "found bag" to "no bag",
        // OR every ~5 s while idle, so we can see WHY no bag was picked.
        static ULONGLONG s_lastNoBagsLogMs = 0;
        const ULONGLONG nbNow = GetTickCount64();
        const bool wasActive = s_activeBagId.load(std::memory_order_relaxed) != 0;
        if (wasActive || nbNow - s_lastNoBagsLogMs >= 5000) {
            s_lastNoBagsLogMs = nbNow;
            DBG_FILE_LOG("[looter] no-bags entitySnapshot=" << ents.size()
                         << " bagsAnyTier=" << seenAny
                         << " bagsEnabledTier=" << seenEnabledTier
                         << " bagsInRange=" << seenInRange);
        }
        if (wasActive) {
            DangerPlanner::ClearExternalGoal();
            s_activeBagId.store(0, std::memory_order_relaxed);
            s_activeBagDist.store(0.f, std::memory_order_relaxed);
        }
        s_statusTag.store("no-bags", std::memory_order_relaxed);
        return;
    }
    (void)bestTier;

    const float dx = bestX - playerX;
    const float dy = bestY - playerY;
    const float dist = sqrtf(dx * dx + dy * dy);

    if (dist <= kArriveDistTiles) {
        // On top of the bag: hand movement back to the planner. Picking up
        // the items is the external auto-loot plugin's job.
        DangerPlanner::ClearExternalGoal();
        s_activeBagId.store(bestId, std::memory_order_relaxed);
        s_activeBagDist.store(dist, std::memory_order_relaxed);
        s_statusTag.store("arrived", std::memory_order_relaxed);
        return;
    }

    DangerPlanner::SetExternalGoal(bestX, bestY);
    // Log on bag-id transitions only — once per pickup target.
    if (s_activeBagId.load(std::memory_order_relaxed) != bestId) {
        DBG_FILE_LOG("[looter] new target id=" << bestId
                     << " tier=" << bestTier
                     << " bagPos=(" << bestX << "," << bestY << ")"
                     << " dist=" << dist);
    }
    s_activeBagId.store(bestId, std::memory_order_relaxed);
    s_activeBagDist.store(dist, std::memory_order_relaxed);
    s_statusTag.store("walking", std::memory_order_relaxed);
}

void Reset()
{
    if (s_activeBagId.load(std::memory_order_relaxed) != 0) {
        DangerPlanner::ClearExternalGoal();
    }
    s_activeBagId.store(0, std::memory_order_relaxed);
    s_activeBagDist.store(0.f, std::memory_order_relaxed);
    s_statusTag.store("off", std::memory_order_relaxed);
    s_lastTickMs = 0;
}

void SetEnabled(bool on)
{
    const bool prev = s_enabled.exchange(on, std::memory_order_acq_rel);
    if (prev && !on) Reset();
}
bool IsEnabled() { return s_enabled.load(std::memory_order_relaxed); }

void SetTierEnabled(BagTier t, bool on)
{
    if (t < 0 || t >= TierCount_) return;
    s_tierEnabled[t].store(on, std::memory_order_relaxed);
}
bool IsTierEnabled(BagTier t)
{
    if (t < 0 || t >= TierCount_) return false;
    return s_tierEnabled[t].load(std::memory_order_relaxed);
}

void SetMaxWalkDistance(float tiles)
{
    if (!std::isfinite(tiles)) tiles = 12.f;
    if (tiles < 1.f)  tiles = 1.f;
    if (tiles > 40.f) tiles = 40.f;
    s_maxWalkDist.store(tiles, std::memory_order_relaxed);
}
float GetMaxWalkDistance() { return s_maxWalkDist.load(std::memory_order_relaxed); }

int32_t GetActiveBagId()       { return s_activeBagId.load(std::memory_order_relaxed); }
float   GetActiveBagDistance() { return s_activeBagDist.load(std::memory_order_relaxed); }
const char* GetLastStatusTag() { return s_statusTag.load(std::memory_order_relaxed); }

} // namespace BagLooter
