/**
 * Player inventory / backpack / quickslot handling: reading slot contents,
 * choosing a free destination slot for a looted item, and the USEITEM /
 * INVENTORYSWAP packets that actually move items.
 *
 * "Packet slot ids": 0-11 inventory, 12-27 backpack, and quickslots offset by
 * {@link QUICKSLOT_PACKET_BASE}.
 */

import { tryInventoryAction, StatType } from '../api.js';
import type { PluginContext } from '../api.js';
import type { ClientConnection } from '../api.js';
import type { TrackedEntity } from '../api.js';
import type { LootCatalog } from './catalog.js';
import { isReservedDestination, type AutoLootState } from './state.js';
import { isHpOrMpPotion } from './items.js';
import {
  QUICKSLOT_PACKET_BASE,
  QUICK_SLOT_COUNT,
  MAX_POTION_QUICKSLOT_STACK,
} from './constants.js';

/** A resolved destination slot for a loot swap, using packet slot ids. */
export interface LootDestination {
  packetSlotId: number;
  currentObjectType: number;
}

export function isQuickslotPacketSlot(packetSlotId: number): boolean {
  return packetSlotId >= QUICKSLOT_PACKET_BASE
    && packetSlotId < (QUICKSLOT_PACKET_BASE + QUICK_SLOT_COUNT);
}

export function readQuickSlot(client: ClientConnection, slot: number): { itemType: number; quantity: number } {
  const raw = (client.playerData as any).quickSlots?.[slot];

  if (typeof raw === 'number') {
    return { itemType: raw > 0 ? raw : -1, quantity: 0 };
  }

  if (raw && typeof raw === 'object') {
    const itemTypeRaw = Number(raw.itemType ?? -1);
    const quantityRaw = Number(raw.quantity ?? 0);
    return {
      itemType: itemTypeRaw > 0 ? itemTypeRaw : -1,
      quantity: Number.isFinite(quantityRaw) ? Math.max(0, Math.trunc(quantityRaw)) : 0,
    };
  }

  return { itemType: -1, quantity: 0 };
}

/** Current object type occupying a packet slot id (-1 if empty / out of range). */
export function getPlayerSlotObjectType(client: ClientConnection, packetSlotId: number): number {
  if (packetSlotId >= 0 && packetSlotId <= 11) {
    return Number(client.playerData.inventory[packetSlotId] ?? -1);
  }
  if (packetSlotId >= 12 && packetSlotId <= 27) {
    return Number(client.playerData.backpack[packetSlotId - 12] ?? -1);
  }
  if (isQuickslotPacketSlot(packetSlotId)) {
    return readQuickSlot(client, packetSlotId - QUICKSLOT_PACKET_BASE).itemType;
  }
  return -1;
}

/**
 * Quickslot destination for an HP/MP potion: stack onto an existing matching slot
 * (when below cap) or take the first empty quickslot. Returns null when the item
 * isn't an HP/MP potion, isn't quickslot-allowed, or no usable slot exists.
 */
export function getQuickslotDestination(
  client: ClientConnection,
  itemId: number,
  catalog: LootCatalog,
): LootDestination | null {
  const info = catalog.get(itemId);
  if (info && info.quickslotAllowed !== true) return null;

  if (!isHpOrMpPotion(itemId)) return null;

  let existingSlot = -1;
  let existingQuantity = 0;
  let firstEmptySlot = -1;

  const quickSlotCount = client.playerData.hasThirdQuickSlot ? 3 : 2;
  for (let slot = 0; slot < quickSlotCount; slot++) {
    const current = readQuickSlot(client, slot);

    if (current.itemType === itemId) {
      existingSlot = slot;
      existingQuantity = current.quantity;
      break;
    }

    if (current.itemType === -1 && firstEmptySlot < 0) {
      firstEmptySlot = slot;
    }
  }

  if (existingSlot >= 0) {
    // Stack only when the per-slot count is known and below cap; otherwise don't
    // risk creating a duplicate HP/MP stack in another quickslot.
    return (existingQuantity > 0 && existingQuantity < MAX_POTION_QUICKSLOT_STACK)
      ? { packetSlotId: QUICKSLOT_PACKET_BASE + existingSlot, currentObjectType: itemId }
      : null;
  }

  if (firstEmptySlot >= 0) {
    return { packetSlotId: QUICKSLOT_PACKET_BASE + firstEmptySlot, currentObjectType: -1 };
  }

  return null;
}

/** Expected post-swap quantity for a quickslot HP/MP destination (null otherwise). */
export function getExpectedQuickslotQuantity(
  client: ClientConnection,
  destination: LootDestination,
  itemId: number,
): number | null {
  if (!isQuickslotPacketSlot(destination.packetSlotId)) return null;
  if (!isHpOrMpPotion(itemId)) return null;

  const current = readQuickSlot(client, destination.packetSlotId - QUICKSLOT_PACKET_BASE);
  if (current.itemType !== itemId || current.quantity <= 0) return 1;
  return Math.min(MAX_POTION_QUICKSLOT_STACK, current.quantity + 1);
}

/** First free general-purpose inventory/backpack slot, honouring reservations. */
export function getFirstFreeLootDestination(
  client: ClientConnection,
  allowBackpack: boolean,
  backpackFirst: boolean,
  state: AutoLootState,
  now: number,
): LootDestination | null {
  const tryInventory = (): LootDestination | null => {
    for (let slot = 4; slot <= 11; slot++) {
      const objectType = Number(client.playerData.inventory[slot] ?? -1);
      if (objectType !== -1) continue;
      if (isReservedDestination(state, slot, now)) continue;
      return { packetSlotId: slot, currentObjectType: -1 };
    }
    return null;
  };

  const tryBackpack = (): LootDestination | null => {
    if (!allowBackpack || !client.playerData.hasBackpack) return null;
    // backpackTier 8 = 8 slots (no extender), 16 = 16 slots (with extender)
    const backpackSize = client.playerData.hasBackpackExtender ? 16 : 8;
    for (let slot = 0; slot < backpackSize; slot++) {
      const packetSlotId = 12 + slot;
      const objectType = Number(client.playerData.backpack[slot] ?? -1);
      if (objectType !== -1) continue;
      if (isReservedDestination(state, packetSlotId, now)) continue;
      return { packetSlotId, currentObjectType: -1 };
    }
    return null;
  };

  if (backpackFirst) {
    return tryBackpack() ?? tryInventory();
  }
  return tryInventory() ?? tryBackpack();
}

// ─── Item-move packets ──────────────────────────────────────────────────────────

/** USEITEM from a bag slot (used for autodrinking stat pots straight off the bag). */
export function sendUseItemFromBag(
  ctx: PluginContext,
  client: ClientConnection,
  bag: TrackedEntity,
  bagSlot: number,
  itemId: number,
): boolean {
  const packet = ctx.createPacket('USEITEM');
  packet.data.time = Math.trunc(client.time);
  packet.data.slotObject = { objectId: bag.objectId, slotId: bagSlot, objectType: itemId };
  packet.data.itemUsePos = { x: 0, y: 0 };
  packet.data.useType = 0;
  packet.data.unknownInt = 0;
  packet.modified = true;
  return tryInventoryAction(client,
    () => String(ctx.worldState?.getEntity(bag.objectId)?.stats?.[String(StatType.Inventory0 + bagSlot)] ?? -1),
    () => client.sendToServer(packet));
}

/**
 * INVENTORYSWAP moving an item from a bag slot into a player destination slot.
 * Returns false (and sends nothing) while a manual potion action is suppressing
 * Auto Loot — even non-potion swaps can collide with unsettled inventory state.
 */
export function sendLootSwap(
  ctx: PluginContext,
  client: ClientConnection,
  bag: TrackedEntity,
  bagSlot: number,
  itemId: number,
  destination: LootDestination,
  state: AutoLootState,
): boolean {
  if (Date.now() < state.manualPotionSuppressUntil) return false;

  // Re-read the destination immediately before sending. `destination` was chosen
  // from playerData, which only refreshes on NEWTICK, so it can describe the slot
  // as it was up to a tick ago. Sending slotObject2 with an objectType that does
  // not match the slot's real contents is an invalid inventory operation, and the
  // server drops the connection over those rather than just ignoring them.
  const actual = getPlayerSlotObjectType(client, destination.packetSlotId);
  if (actual !== destination.currentObjectType) return false;

  const packet = ctx.createPacket('INVENTORYSWAP');
  packet.data.time = Math.trunc(client.time);
  packet.data.position = {
    x: Number(client.playerData.pos?.x ?? 0),
    y: Number(client.playerData.pos?.y ?? 0),
  };
  packet.data.slotObject1 = { objectId: bag.objectId, slotId: bagSlot, objectType: itemId };
  packet.data.slotObject2 = {
    objectId: client.objectId,
    slotId: destination.packetSlotId,
    objectType: destination.currentObjectType,
  };
  packet.modified = true;
  const readDestination = () => isQuickslotPacketSlot(destination.packetSlotId)
    ? JSON.stringify(readQuickSlot(client, destination.packetSlotId - QUICKSLOT_PACKET_BASE))
    : String(getPlayerSlotObjectType(client, destination.packetSlotId));
  const beforeDestination = readDestination();
  return tryInventoryAction(client,
    () => Number(ctx.worldState?.getEntity(bag.objectId)?.stats?.[String(StatType.Inventory0 + bagSlot)] ?? -1) !== itemId
      && readDestination() !== beforeDestination ? 'settled' : 'pending',
    () => client.sendToServer(packet));
}
