/**
 * Pure helpers that derive facts about an item id, with no dependency on the
 * loaded catalog: potion classification, the min-enchant select mapping, enchant
 * decoding from bag stat 80, and the stat-pot autodrink class-cap check.
 */

import type { PlayerClassStatMaxes } from '../api.js';
import {
  HP_POTION_IDS,
  MP_POTION_IDS,
  STAT_POTION_IDS,
  LIFE_MANA_POTION_IDS,
  MIN_ENCHANT_SELECT_VALUES,
  UNIQUE_DATA_STAT_ID,
  MYSTERY_STAT_POT_ID,
  STAT_POT_ITEM_TO_PERMANENT,
  PERMANENT_STATS_ALL,
  type PermanentStatKey,
} from './constants.js';

// ─── Potion classification ──────────────────────────────────────────────────────

export function isHpPotion(itemId: number): boolean {
  return HP_POTION_IDS.has(itemId);
}

/** HP or MP quaff potion — the kinds that go into quickslots. */
export function isHpOrMpPotion(itemId: number): boolean {
  return HP_POTION_IDS.has(itemId) || MP_POTION_IDS.has(itemId);
}

/** Any potion: HP/MP quaff, permanent stat, or life/mana. */
export function isAnyPotion(itemId: number): boolean {
  return HP_POTION_IDS.has(itemId)
    || MP_POTION_IDS.has(itemId)
    || STAT_POTION_IDS.has(itemId)
    || LIFE_MANA_POTION_IDS.has(itemId);
}

/** Map the `minEnchant` select value to the minimum enchant count it requires. */
export function minEnchantSelectToCount(value: string): number {
  const i = (MIN_ENCHANT_SELECT_VALUES as readonly string[]).indexOf(String(value).toLowerCase());
  return Math.max(0, i);
}

// ─── Enchants (bag stat 80 / UniqueDataStr) ─────────────────────────────────────
// Wire format mirrors `damage-sniffer.ts`: stat 80 is a comma-separated list of
// base64 blobs, one per bag slot. Each blob is a 1-byte header, a 2-byte type
// marker (0x0402), then 2-byte little-endian enchant ids terminated by 0xFFFD.

function decodeEnchantIdsFromBlob(code: string): number[] {
  const raw = code.trim();
  if (!raw) return [];
  try {
    const normalized = raw.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length <= 3) return [];
    const ids: number[] = [];
    for (let pos = 3; pos + 1 < bytes.length; pos += 2) {
      const value = bytes.readUInt16LE(pos);
      if (value === 0xfffd) break;
      ids.push(value === 0xfffe ? 0 : value);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Decoded enchant ids (>0) for a single bag slot, from the bag's stats. */
export function getBagSlotEnchantIds(
  stats: Record<string, number | string> | undefined,
  bagSlot: number,
): number[] {
  const v = stats?.[String(UNIQUE_DATA_STAT_ID)];
  if (typeof v !== 'string' || !v.trim()) return [];
  return decodeEnchantIdsFromBlob(v.split(',')[bagSlot] ?? '').filter((id) => id > 0);
}

// ─── Stat-pot autodrink class cap ───────────────────────────────────────────────
// `PlayerData.attack` … `wisdom` are permanent stats (class + level + pots), not
// gear 48+ / exalt bonuses. Skip autodrinking when the matching permanent stat is
// already at/above the class 8/8 `max` from objects.xml.

type PermanentStatValues = Record<PermanentStatKey, number>;

/** Vitality/wisdom map to HpRegen/MpRegen @max in objects.xml; the rest are 1:1. */
function classCapForPermanent(caps: PlayerClassStatMaxes, s: PermanentStatKey): number {
  if (s === 'vitality') return caps.hpRegen;
  if (s === 'wisdom') return caps.mpRegen;
  return caps[s];
}

function isStatCapped(caps: PlayerClassStatMaxes, values: PermanentStatValues, s: PermanentStatKey): boolean {
  const cap = classCapForPermanent(caps, s);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Number.isFinite(values[s]) && values[s] >= cap;
}

/**
 * Returns true when autodrinking `itemId` should be skipped because the player's
 * permanent stat(s) are already capped for their class. The Mystery Stat Pot is
 * skipped only when *every* permanent stat is capped.
 */
export function shouldSkipAutodrinkClassCap(
  classType: number,
  values: PermanentStatValues,
  itemId: number,
  getCaps: (ct: number) => PlayerClassStatMaxes | undefined,
): boolean {
  const caps = getCaps(classType);
  if (!caps) return false;

  if (itemId === MYSTERY_STAT_POT_ID) {
    return PERMANENT_STATS_ALL.every((s) => isStatCapped(caps, values, s));
  }

  const target = STAT_POT_ITEM_TO_PERMANENT[itemId];
  return target != null && isStatCapped(caps, values, target);
}
