/**
 * The "should I loot this?" decision logic: tier thresholds, UT/ST handling,
 * potions, marks/eggs, whitelist/blacklist, and the minimum-enchant gate.
 */

import type { PluginContext } from '../../src/plugins/PluginContext.js';
import type { TrackedEntity } from '../../src/state/GameWorldState.js';
import type { AutoLootSettings } from './settings.js';
import { LootCatalog, getGearCategory, isMultitoolUtTier, type GearCategory } from './catalog.js';
import { getBagSlotEnchantIds, isAnyPotion } from './items.js';
import {
  HP_POTION_IDS,
  MP_POTION_IDS,
  STAT_POTION_IDS,
  LIFE_MANA_POTION_IDS,
} from './constants.js';

/** Maps that Auto Loot never operates in (vaults, daily quest room, pet yard). */
export function shouldSkipMap(mapName: string): boolean {
  const lower = mapName.trim().toLowerCase();
  if (!lower) return false;
  return lower.includes('vault') || lower === 'daily quest room' || lower.startsWith('pet yard');
}

/** UT items are looted from every gear slot except slot types 10 and 26. */
function isLootableUtSlot(slotType: number): boolean {
  return slotType !== 10 && slotType !== 26;
}

export class LootRules {
  constructor(
    private readonly ctx: PluginContext,
    private readonly settings: AutoLootSettings,
    private readonly catalog: LootCatalog,
  ) {}

  private minTierForCategory(category: GearCategory): number {
    const s = this.settings;
    if (category === 'weapon') return s.minWeaponTier;
    if (category === 'ability') return s.minAbilityTier;
    if (category === 'armor') return s.minArmorTier;
    return s.minRingTier;
  }

  /** Per-item-type override when one is set, otherwise the category threshold. */
  private minTierForSlot(slotType: number, category: GearCategory): number {
    const override = this.settings.minTierBySlot.get(slotType);
    return override !== undefined ? override : this.minTierForCategory(category);
  }

  /** Stat pot on ground: interact if looting and/or autodrinking, or whitelisted. */
  canInteractWithStatPotOnBag(itemId: number): boolean {
    if (!STAT_POTION_IDS.has(itemId)) return false;
    if (this.settings.blacklist.has(itemId)) return false;
    if (this.settings.whitelist.has(itemId)) return true;
    return this.settings.lootStatPotions || this.settings.autodrinkStatPots;
  }

  /** Enchant-count gate; whitelist and all potions bypass it. */
  passesMinEnchantGate(itemId: number, bag: TrackedEntity, bagSlot: number): boolean {
    if (this.settings.whitelist.has(itemId)) return true;
    if (isAnyPotion(itemId)) return true;
    if (this.settings.minEnchantTier <= 0) return true;
    return getBagSlotEnchantIds(bag.stats, bagSlot).length >= this.settings.minEnchantTier;
  }

  /** Loot toggle for potion item ids, or undefined when `itemId` isn't a potion. */
  private potionLootDecision(itemId: number): boolean | undefined {
    const s = this.settings;
    if (HP_POTION_IDS.has(itemId)) return s.lootHpPotions;
    if (MP_POTION_IDS.has(itemId)) return s.lootMpPotions;
    if (LIFE_MANA_POTION_IDS.has(itemId)) return s.lootLifeManaPotions;
    if (STAT_POTION_IDS.has(itemId)) return s.lootStatPotions;
    return undefined;
  }

  shouldLootItem(itemId: number): boolean {
    const s = this.settings;
    if (!Number.isFinite(itemId) || itemId <= 0) return false;
    if (s.blacklist.has(itemId)) return false;
    if (s.whitelist.has(itemId)) return true;

    const potion = this.potionLootDecision(itemId);
    if (potion !== undefined) return potion;

    const info = this.catalog.get(itemId);
    if (!info) return s.lootUTs && this.isUncataloguedUt(itemId);

    if (s.lootMarks && info.name.includes('Mark of ')) return true;
    if (s.lootEggs && info.name.endsWith(' Egg')) return true;
    if (info.isUT) return s.lootUTs && isLootableUtSlot(info.slotType);
    if (info.isST) return s.lootSTs;

    const category = getGearCategory(info.slotType);
    if (category == null || info.tier == null) return false;
    return info.tier >= this.minTierForSlot(info.slotType, category);
  }

  /** UT item present in raw game data but absent from the catalog (no gear slot). */
  private isUncataloguedUt(itemId: number): boolean {
    const rawObj = this.ctx.gameData?.getObject(itemId);
    if (!rawObj) return false;
    const st = Math.trunc(Number(rawObj.slotType ?? -1));
    const tier = String(rawObj.tierStr ?? '').trim().toUpperCase();
    return isMultitoolUtTier(tier, st) && isLootableUtSlot(st);
  }
}
