/** Auto Drink: locate usable potions in the belt / inventory / backpack. */

import type { ClientConnection } from '../api.js';
import { BELT_SLOT_BASE } from './constants.js';

/** A potion found in a slot, with the USEITEM packet slot id to use. */
export interface FoundSlot {
  /** USEITEM slot id: `BELT_SLOT_BASE + i` for belt, 4-11 inventory, 12-27 backpack. */
  slotId: number;
  itemType: number;
}

/** Every belt quickslot holding a matching potion, one entry per unit in the stack. */
function beltSlots(client: ClientConnection, idSet: Set<number>, limit: number): FoundSlot[] {
  const out: FoundSlot[] = [];
  const belt = (client.playerData as any).quickSlots ?? [];
  const cap = (client.playerData as any).hasThirdQuickSlot ? 3 : 2;
  for (let i = 0; i < cap && i < belt.length && out.length < limit; i++) {
    const s: any = belt[i];
    if (s?.itemType === -1 || !(s?.quantity > 0) || !idSet.has(s.itemType)) continue;
    // A belt quickslot is a stack, so the same slot id is drinkable `quantity` times.
    for (let n = 0; n < s.quantity && out.length < limit; n++) {
      out.push({ slotId: BELT_SLOT_BASE + i, itemType: s.itemType });
    }
  }
  return out;
}

/** Every matching potion in inventory (slots 4-11), then backpack (slots 12-27). */
function bagSlots(client: ClientConnection, idSet: Set<number>, limit: number): FoundSlot[] {
  const out: FoundSlot[] = [];
  const inv = client.playerData.inventory;
  for (let slot = 4; slot < inv.length && out.length < limit; slot++) {
    const itemId = Number(inv[slot] ?? -1);
    if (itemId !== -1 && idSet.has(itemId)) out.push({ slotId: slot, itemType: itemId });
  }
  if (client.playerData.hasBackpack) {
    const bp = client.playerData.backpack;
    for (let slot = 0; slot < bp.length && out.length < limit; slot++) {
      const itemId = Number(bp[slot] ?? -1);
      if (itemId !== -1 && idSet.has(itemId)) out.push({ slotId: 12 + slot, itemType: itemId });
    }
  }
  return out;
}

/**
 * Up to `limit` distinct drinkable potions, belt first or bags first.
 *
 * Returning a list rather than a single slot is what makes a burst possible: a
 * bag potion can only be drunk once, so a burst has to walk to the next slot
 * instead of resending the same one.
 */
export function findSlots(
  client: ClientConnection,
  idSet: Set<number>,
  limit: number,
  preferBelt: boolean,
): FoundSlot[] {
  if (limit <= 0 || idSet.size === 0) return [];
  const first = preferBelt ? beltSlots(client, idSet, limit) : bagSlots(client, idSet, limit);
  if (first.length >= limit) return first;
  const second = preferBelt
    ? bagSlots(client, idSet, limit - first.length)
    : beltSlots(client, idSet, limit - first.length);
  return first.concat(second);
}
