import type {
  LootBag,
  LootItem,
  LootDropEvent,
  LootItemEvent,
  LootRarity,
  PickupOptions,
} from './types/loot';
import type { Unsubscribe } from './types/events';

const noopUnsub: Unsubscribe = () => {};

export const loot = {
  // ─── Bag queries ────────────────────────────────────────────────────────────
  getBags(): LootBag[] {
    return [];
  },

  getNearbyBags(_radius?: number): LootBag[] {
    return [];
  },

  getBagsByRarity(_rarity: LootRarity): LootBag[] {
    return [];
  },

  getBagsContaining(_objectType: number): LootBag[] {
    return [];
  },

  // ─── Events ─────────────────────────────────────────────────────────────────
  onBagDropped(handler: (e: LootDropEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  onRareBagDropped(_minRarity: LootRarity, handler: (e: LootDropEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  onItemDropped(_objectType: number, handler: (e: LootItemEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  onBagRemoved(handler: (e: LootDropEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  // ─── Pickup actions ─────────────────────────────────────────────────────────

  /**
   * Send an INVENTORYSWAP packet to pick up the item in the given bag slot.
   * Automatically finds the first free inventory/backpack slot.
   * Returns `true` if the packet was sent, `false` if the slot is empty, full, or not connected.
   */
  pickup(_bag: LootBag, _slotIndex: number, _opts?: { useBackpack?: boolean }): boolean {
    return false;
  },

  /**
   * Send a USEITEM packet to use (drink/apply) the item directly from the bag slot.
   * Use this for stat potions — they are consumed in place rather than moved to inventory.
   * Returns `true` if the packet was sent.
   */
  useFromBag(_bag: LootBag, _slotIndex: number): boolean {
    return false;
  },

  /**
   * Pick up all items from the bag with the given objectId, provided the bag is
   * within `maxDistance` tiles of the player (default: 1.0).
   * Sends one INVENTORYSWAP per non-empty slot, tracking claimed destinations within
   * the call so the same inventory slot is never targeted twice.
   *
   * Returns the number of INVENTORYSWAP packets sent, or `-1` if the bag was not
   * found in the world or is outside the distance threshold.
   */
  pickupId(_bagObjectId: number, _opts?: { maxDistance?: number; useBackpack?: boolean }): number {
    return -1;
  },

  // ─── Item classification ─────────────────────────────────────────────────────

  /**
   * Check whether an item should be picked up based on the supplied filter options.
   * Uses the same tier / UT / ST / potion / whitelist / blacklist logic as the Auto Loot plugin.
   */
  shouldPickup(_objectType: number, _opts?: PickupOptions): boolean {
    return false;
  },

  /** Returns `true` if the objectType is a UT-tier gear item. */
  isUT(_objectType: number): boolean { return false; },

  /** Returns `true` if the objectType is an ST item. */
  isST(_objectType: number): boolean { return false; },

  /** Returns `true` if the objectType is a stat potion (Att/Def/Spd/Vit/Wis/Dex pot). */
  isStatPot(_objectType: number): boolean { return false; },

  /** Returns `true` if the objectType is an HP potion. */
  isHpPot(_objectType: number): boolean { return false; },

  /** Returns `true` if the objectType is an MP potion. */
  isMpPot(_objectType: number): boolean { return false; },

  /** Returns `true` if the objectType is a life or mana potion (permanent stat increase). */
  isLifeManaPot(_objectType: number): boolean { return false; },

  /** True when this potion can still increase one of the current character's base stats. */
  isUsefulStatPot(_objectType: number): boolean { return false; },

  /** True when this gear is compatible with and ranks above the currently equipped item. */
  isEquipmentUpgrade(_objectType: number): boolean { return false; },

  /** Equipment destination slot (0 weapon, 1 ability, 2 armor, 3 ring), or -1. */
  getEquipmentSlot(_objectType: number): number { return -1; },

  /** Equip an upgrade directly from a nearby bag, swapping the old item back into the bag. */
  equipFromBag(_bag: LootBag, _slotIndex: number): boolean { return false; },
};

export type { LootBag, LootItem, LootRarity, LootDropEvent, LootItemEvent, PickupOptions } from './types/loot';
