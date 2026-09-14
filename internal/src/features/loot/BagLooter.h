#pragma once
#include <cstdint>

// BagLooter — bag detection + auto-walk to the nearest loot bag.
//
// Per game-thread tick (throttled), scans WorldTAB::GetEntities() for loot
// bags whose object type matches an enabled tier, picks the nearest one
// within `maxWalkDistance`, and routes the dodge planner to it via
// DangerPlanner::SetExternalGoal. When the player is on top of the bag the
// goal is cleared and the planner returns to its previous behavior (lock-
// follow / idle / etc).
//
// Scope is movement only: this walks you onto the bag. Taking the items is
// the job of the external client's auto-loot plugin, not this module.
namespace BagLooter {

// Tiers are the bag colours, in the game's own bag order (Loot Bag 0..9 is the
// rarity order), with Soulbound last. Colours come from each bag's lofiObj4 sprite
// in objects.xml / mapObjects.png; ids are in BagLooter.cpp. A later tier wins a
// nearby tie (see the rank bias in Tick).
enum BagTier : int {
    Brown      = 0,   // Loot Bag 0      0x500 / Boost 0x6ad
    Pink       = 1,   // Loot Bag 1      0x506 / Boost 0x6ae
    Purple     = 2,   // Loot Bag 2      0x507 / Boost 0x6ba
    Egg        = 3,   // Loot Bag 3      0x508 / Boost 0x6bb — the egg basket
    LightBlue  = 4,   // Loot Bag 4      0x509 / Boost 0x6bd
    DarkBlue   = 5,   // Loot Bag 5      0x50b / Boost 0x6be — potions (<BagType>5)
    White      = 6,   // Loot Bag 6      0x50c / Boost 0x510
    Gold       = 7,   // Loot Bag 7      0x50e / Boost 0x6bc
    Orange     = 8,   // Loot Bag 8      0x50f / Boost 0x6bf
    Red        = 9,   // Loot Bag 9      0x6ac / Boost 0x6c0
    Soulbound  = 10,  // Soulbound Loot Bag 0x503 — only your own drops
    TierCount_ = 11,
};

void Tick();
void Reset();

void SetEnabled(bool on);
bool IsEnabled();

void SetTierEnabled(BagTier t, bool on);
bool IsTierEnabled(BagTier t);

void  SetMaxWalkDistance(float tiles);   // 1..40, default 12
float GetMaxWalkDistance();

// Diagnostics — for the Movement-tab status row.
int32_t GetActiveBagId();        // 0 if no bag being pursued
float   GetActiveBagDistance();  // tiles from player; 0 if no active bag
const char* GetLastStatusTag();  // "off" / "no-player" / "hp-gated" / "no-bags" / "walking" / "arrived"

} // namespace BagLooter
