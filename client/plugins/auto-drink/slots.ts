/** Auto Drink — locate a usable potion in the belt / inventory / backpack. */

import type { ClientConnection } from '../api.js';
import { BELT_SLOT_BASE } from './constants.js';

/** A potion found in a slot, with the USEITEM packet slot id to use. */
export interface FoundSlot {
  /** USEITEM slot id: `BELT_SLOT_BASE + i` for belt, 4-11 inventory, 12-27 backpack. */
  slotId: number;
  itemType: number;
}

/** First potion-belt quickslot holding a matching potion (with quantity > 0). */
export function findBeltSlot(client: ClientConnection, idSet: Set<number>): FoundSlot | null {
  const belt = (client.playerData as any).quickSlots ?? [];
  const cap = (client.playerData as any).hasThirdQuickSlot ? 3 : 2;
  for (let i = 0; i < cap && i < belt.length; i++) {
    const s: any = belt[i];
    if (s?.itemType !== -1 && s?.quantity > 0 && idSet.has(s.itemType)) {
      return { slotId: BELT_SLOT_BASE + i, itemType: s.itemType };
    }
  }
  return null;
}

/** First matching potion in inventory (slots 4-11), then backpack (slots 12-27). */
export function findInventorySlot(client: ClientConnection, idSet: Set<number>): FoundSlot | null {
  const inv = client.playerData.inventory;
  for (let slot = 4; slot < inv.length; slot++) {
    const itemId = Number(inv[slot] ?? -1);
    if (itemId !== -1 && idSet.has(itemId)) {
      return { slotId: slot, itemType: itemId };
    }
  }
  if (client.playerData.hasBackpack) {
    const bp = client.playerData.backpack;
    for (let slot = 0; slot < bp.length; slot++) {
      const itemId = Number(bp[slot] ?? -1);
      if (itemId !== -1 && idSet.has(itemId)) {
        return { slotId: 12 + slot, itemType: itemId };
      }
    }
  }
  return null;
}
