/**
 * The lootable-item catalog: classification of every game object into Auto Loot's
 * UT / ST / tier / gear-category buckets, plus display-name resolution.
 */

import type { PluginContext } from '../api.js';
import {
  WEAPON_SLOT_TYPES,
  ABILITY_SLOT_TYPES,
  ARMOR_SLOT_TYPES,
  RING_SLOT_TYPES,
} from './constants.js';

/** Which gear bucket a slot type maps to for per-category tier thresholds. */
export type GearCategory = 'weapon' | 'ability' | 'armor' | 'ring';

/** Classification of a single item definition from the game data catalog. */
export interface ItemInfo {
  itemId: number;
  name: string;
  slotType: number;
  tier: number | null;
  isUT: boolean;
  isST: boolean;
  quickslotAllowed: boolean;
}

/** Weapon / ability / armor / ring slots -> same buckets as {@link getGearCategory}. */
function isGearSlotType(slotType: number): boolean {
  return WEAPON_SLOT_TYPES.has(slotType)
    || ABILITY_SLOT_TYPES.has(slotType)
    || ARMOR_SLOT_TYPES.has(slotType)
    || RING_SLOT_TYPES.has(slotType);
}

/** Which gear bucket a slot type belongs to (for per-category tier thresholds). */
export function getGearCategory(slotType: number): GearCategory | null {
  if (WEAPON_SLOT_TYPES.has(slotType)) return 'weapon';
  if (ABILITY_SLOT_TYPES.has(slotType)) return 'ability';
  if (ARMOR_SLOT_TYPES.has(slotType)) return 'armor';
  if (RING_SLOT_TYPES.has(slotType)) return 'ring';
  return null;
}

/**
 * Match Multitool `Class22`: explicit `UT`, or **no `<Tier>`** (empty string) defaults
 * to UT for gear. `ST` is never UT. `normalizedTier` must be uppercase trimmed.
 */
export function isMultitoolUtTier(normalizedTier: string, slotType: number): boolean {
  if (normalizedTier === 'ST') return false;
  if (normalizedTier === 'UT') return true;
  if (normalizedTier !== '') return false;
  return isGearSlotType(slotType);
}

/** Builds and owns the map of item id -> {@link ItemInfo}, and resolves names. */
export class LootCatalog {
  readonly items = new Map<number, ItemInfo>();

  constructor(private readonly ctx: PluginContext) {
    this.load();
  }

  get size(): number {
    return this.items.size;
  }

  get(itemId: number): ItemInfo | undefined {
    return this.items.get(itemId);
  }

  private load(): void {
    const objects = this.ctx.gameData?.getAllObjects() ?? [];

    for (const obj of objects) {
      const itemId = Number(obj.type);
      if (!Number.isFinite(itemId)) continue;

      const slotTypeRaw = Number(obj.slotType ?? -1);
      if (!Number.isFinite(slotTypeRaw) || slotTypeRaw < 0) continue;

      const normalizedTier = String(obj.tierStr ?? '').trim().toUpperCase();
      const isST = normalizedTier === 'ST';
      const isUT = isMultitoolUtTier(normalizedTier, Math.trunc(slotTypeRaw));
      const tier = (isUT || isST || !/^-?\d+$/.test(normalizedTier))
        ? null
        : Number(normalizedTier);

      this.items.set(itemId, {
        itemId,
        name: String(obj.id || '').trim() || `0x${itemId.toString(16)}`,
        slotType: Math.trunc(slotTypeRaw),
        tier,
        isUT,
        isST,
        quickslotAllowed: obj.quickslotAllowed === true,
      });
    }
  }

  /** Display name for a bag object type (world name, else hex id). */
  getBagDisplayName(objectType: number): string {
    return this.worldName(objectType) ?? `0x${objectType.toString(16)}`;
  }

  /** Display name for an item, preferring the catalog, then raw game data, then hex. */
  getItemDisplayName(itemId: number): string {
    return this.items.get(itemId)?.name?.trim()
      || this.worldName(itemId)
      || `0x${itemId.toString(16)}`;
  }

  private worldName(id: number): string | undefined {
    return this.ctx.gameData?.getObject(id)?.id?.trim() || undefined;
  }
}
