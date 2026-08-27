/** Tuning constants and item/slot id tables for Auto Loot. */

/** The six permanent stats raised by stat potions. */
export type PermanentStatKey = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom';

// ─── Default tier thresholds ───────────────────────────────────────────────────
/**
 * Threshold meaning "never loot this category". Higher than any real tier, so
 * the plain `tier >= threshold` comparison in LootRules keeps working unchanged.
 * Also where a legacy saved value above the category's real top tier lands, which
 * preserves the old trick of parking the numeric input at 20 to switch a
 * category off.
 */
export const TIER_NEVER = 9999;

/** Tiers offered when game data is unavailable and nothing can be derived. */
export const FALLBACK_TIER_RANGE = Array.from({ length: 15 }, (_, i) => i);

export const DEFAULT_MIN_WEAPON_TIER = 11;
export const DEFAULT_MIN_ABILITY_TIER = 6;
export const DEFAULT_MIN_ARMOR_TIER = 11;
export const DEFAULT_MIN_RING_TIER = 6;

// ─── Timing / loop tuning ──────────────────────────────────────────────────────
/** Spacing between *consecutive* pickups/drinks; the first pickup on a bag is immediate. */
export const PICKUP_INTERVAL_MS = 250;
/** Configurable spacing between pickups; PICKUP_INTERVAL_MS is the floor. */
export const DEFAULT_PICKUP_INTERVAL_MS = 400;
export const MIN_PICKUP_INTERVAL_MS = 250;
export const MAX_PICKUP_INTERVAL_MS = 2000;
/**
 * Ceiling on loot packets per second. INVENTORYSWAP is a rare, user-driven
 * packet in the real client, and a sustained stream of them is what the server
 * closes the connection over.
 */
export const DEFAULT_MAX_LOOT_ACTIONS_PER_SEC = 3;
export const MIN_MAX_LOOT_ACTIONS_PER_SEC = 1;
export const MAX_MAX_LOOT_ACTIONS_PER_SEC = 8;
/**
 * How long a bag slot stays off-limits after a swap is sent for it. Bag contents
 * arrive as entity stats and lag the swap by a tick or more, so without this the
 * same item can be swapped again after `RETRY_ITEM_AFTER_MS` even though it was
 * already taken, which the server sees as an invalid inventory operation.
 */
export const BAG_SLOT_SETTLE_MS = 3000;
export const RETRY_ITEM_AFTER_MS = 1500;
export const PENDING_DEST_TIMEOUT_MS = 1200;
export const DEST_SLOT_RESERVE_MS = 30000;
export const BAG_SLOT_CONSUME_MS = 30000;
export const ON_TOP_DISTANCE = 1;
export const PUBLIC_BAG_DELAY_MS = 2000;
export const STATIONARY_TICK_LIMIT = 100;
export const MOVEMENT_EPSILON = 0.05;

// ─── Quickslots ────────────────────────────────────────────────────────────────
export const QUICKSLOT_PACKET_BASE = 1000000;
export const QUICK_SLOT_COUNT = 3;
export const MAX_POTION_QUICKSLOT_STACK = 6;

// ─── Bag notifier ──────────────────────────────────────────────────────────────
export const BAG_NOTIFY_RADIUS = 16;
export const BAG_NOTIFY_ITEM_LIMIT = 8;

// ─── Manual potion guard ───────────────────────────────────────────────────────
export const DEFAULT_MANUAL_POTION_SUPPRESS_MS = 4000;
export const MIN_MANUAL_POTION_SUPPRESS_MS = 1000;
export const MAX_MANUAL_POTION_SUPPRESS_MS = 12000;
export const MANUAL_POTION_SUPPRESS_LOG_MS = 1500;
export const DEFAULT_MANUAL_POTION_PACKET_BLOCK_MS = 1200;
export const MIN_MANUAL_POTION_PACKET_BLOCK_MS = 300;
export const MAX_MANUAL_POTION_PACKET_BLOCK_MS = 3000;
export const MANUAL_POTION_PACKET_BLOCK_LOG_MS = 500;

// ─── Bag object types ──────────────────────────────────────────────────────────
export const BAG_TYPES = new Set<number>([
  1280, 1281, 1283, 1286, 1287, 1288, 1289, 1291, 1292, 1294, 1295, 1296,
  1708, 1709, 1710, 1722, 1723, 1724, 1725, 1726, 1727, 1728, 8239,
]);

export const PUBLIC_BAG_TYPES = new Set<number>([
  1280, 1281, 1286, 1709, 1710, 8239,
]);

/** Multitool `AutoLootBigBags` / `Class88.method_2` on `UPDATE` newObjs: force `Size` stat for bag types. */
export const MULTITOOL_BIG_BAG_SIZE = 175;

// ─── Slot type buckets ─────────────────────────────────────────────────────────
/**
 * Slot type -> display name. Verified against the shipped objects.xml by sampling
 * item names per slot (slot 1 is Short Sword / Broad Sword / Saber, slot 30 is
 * Slashing Sheath / Timber Sheath, and so on). Anything not listed falls back to
 * "Slot N", so a slot type added by a future build still renders.
 */
export const SLOT_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'Sword', 2: 'Dagger', 3: 'Bow', 4: 'Tome', 5: 'Shield',
  6: 'Leather Armor', 7: 'Heavy Armor', 8: 'Wand', 9: 'Ring', 10: 'Consumable',
  11: 'Spell', 12: 'Seal', 13: 'Cloak', 14: 'Robe', 15: 'Quiver',
  16: 'Helm', 17: 'Staff', 18: 'Poison', 19: 'Skull', 20: 'Trap',
  21: 'Orb', 22: 'Prism', 23: 'Scepter', 24: 'Katana', 25: 'Star',
  26: 'Egg', 27: 'Wakizashi', 28: 'Lute', 29: 'Mace', 30: 'Sheath',
  31: 'Sigil',
};

export function slotTypeName(slotType: number): string {
  return SLOT_TYPE_NAMES[slotType] ?? `Slot ${slotType}`;
}

export const WEAPON_SLOT_TYPES = new Set<number>([1, 2, 3, 8, 17, 24]);
export const ABILITY_SLOT_TYPES = new Set<number>([4, 5, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30, 31]);
export const ARMOR_SLOT_TYPES = new Set<number>([6, 7, 14]);
export const RING_SLOT_TYPES = new Set<number>([9]);

// ─── Potion id tables ──────────────────────────────────────────────────────────
export const HP_POTION_IDS = new Set<number>([2594, 2736]);
export const MP_POTION_IDS = new Set<number>([2595, 2781]);

/** Permanent life/mana stat increases (including Greater / SB variants). */
export const LIFE_MANA_POTION_IDS = new Set<number>([
  2793, 2794,   // Potion of Life, Potion of Mana
  5471, 5472,   // Potion of Life (SB), Potion of Mana (SB)
  9070, 9071,   // Greater Potion of Life, Greater Potion of Mana
]);

export const MYSTERY_STAT_POT_ID = 5094;

/** Which permanent stat each (single-stat) potion raises; base, SB, and Greater variants. */
export const STAT_POT_ITEM_TO_PERMANENT: Record<number, PermanentStatKey> = {
  2591: 'defense',  2592: 'speed',     2593: 'attack',
  2612: 'wisdom',   2613: 'vitality',  2636: 'dexterity',
  5465: 'attack',   5466: 'defense',   5467: 'speed',
  5468: 'vitality', 5469: 'wisdom',    5470: 'dexterity',
  9064: 'attack',   9065: 'defense',   9066: 'speed',
  9067: 'vitality', 9068: 'wisdom',    9069: 'dexterity',
};

/** Every stat potion: the single-stat pots plus the Mystery Stat Pot. */
export const STAT_POTION_IDS = new Set<number>([
  ...Object.keys(STAT_POT_ITEM_TO_PERMANENT).map(Number),
  MYSTERY_STAT_POT_ID,
]);

export const PERMANENT_STATS_ALL: readonly PermanentStatKey[] = [
  'attack', 'defense', 'speed', 'dexterity', 'vitality', 'wisdom',
];

/** Stat 80 (`UniqueDataStr`): comma-separated base64 enchant blobs per slot (see `damage-sniffer.ts`). */
export const UNIQUE_DATA_STAT_ID = 80;

/** Minimum enchant count on the wire: None=0, Uncommon=1, Rare=2, Legendary=3, Divine=4. */
export const MIN_ENCHANT_SELECT_VALUES = ['none', 'uncommon', 'rare', 'legendary', 'divine'] as const;
