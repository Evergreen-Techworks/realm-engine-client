import {
  inventory,
  INVENTORY_BACKPACK_SLOT_COUNT,
  INVENTORY_MAIN_SLOT_COUNT,
  INVENTORY_TOTAL_SLOT_COUNT,
} from '@realmengine/sdk';
import type {
  InventoryItem,
  InventoryBackpackTier,
  InventoryStorageSide,
} from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { PlayerData } from '../../../state/PlayerData.js';
import { depositToVault, withdrawFromVault } from './vaultTransfer.js';
import { installVaultStoreHooks, getVaultStore } from './VaultStore.js';
import { tryInventoryAction } from '../../../util/InventoryActions.js';
import { warnUnimplemented } from '../stubWarn.js';

function playerData(deps: BridgeDeps): PlayerData | null {
  return deps.clientRef.current?.playerData ?? null;
}

/** SDK codes for `inventory.getBackpack()` — aligned with wire stat 130 + legacy HasBackpack (75). */
function backpackTierFromPlayerData(pd: PlayerData | null): InventoryBackpackTier {
  if (!pd) return 1;
  if (pd.backpackTier >= 16) return 3;
  if (pd.backpackTier !== 0 || pd.legacyHasBackpackStat75) return 2;
  return 1;
}

/** Normalized type id for a cell, or -1 if empty / invalid. */
function cellTypeId(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return -1;
  return Math.trunc(raw);
}

function typeIdAtSlot(p: PlayerData, slotIndex: number): number {
  if (slotIndex < 0 || slotIndex >= INVENTORY_TOTAL_SLOT_COUNT) return -1;
  if (slotIndex < INVENTORY_MAIN_SLOT_COUNT) {
    return cellTypeId(p.inventory[slotIndex]);
  }
  return cellTypeId(p.backpack[slotIndex - INVENTORY_MAIN_SLOT_COUNT]);
}

function itemNameForType(deps: BridgeDeps, objectType: number): string | undefined {
  const item = deps.gameData.buildSdkItem(objectType);
  return item?.name;
}

function inventoryItemAt(
  deps: BridgeDeps,
  slotIndex: number,
  objectType: number,
): InventoryItem {
  return {
    objectType,
    slotIndex,
    itemName: itemNameForType(deps, objectType),
  };
}

function slotMatchesQuery(
  deps: BridgeDeps,
  objectType: number,
  query: number | string,
): boolean {
  if (typeof query === 'number' && Number.isFinite(query)) {
    return objectType === Math.trunc(query);
  }
  const q = String(query).trim().toLowerCase();
  if (!q) return false;
  const name = itemNameForType(deps, objectType)?.toLowerCase() ?? '';
  if (name.includes(q)) return true;
  const def = deps.gameData.getObject(objectType);
  const id = def?.id?.toLowerCase() ?? '';
  return id.includes(q);
}

export function install(deps: BridgeDeps): void {
  installVaultStoreHooks(deps);

  inventory.withdraw = (target: number, side: InventoryStorageSide) =>
    withdrawFromVault(deps, target, side);
  inventory.deposit = (target: number, side: InventoryStorageSide) =>
    depositToVault(deps, target, side);

  function requireVaultState(name: string) {
    const c = deps.clientRef.current;
    if (!c) throw new Error(`inventory.${name}: not connected`);
    const state = getVaultStore(c);
    if (!state) throw new Error(`inventory.${name}: vault not entered yet (no VAULTCONTENT received)`);
    return state;
  }

  inventory.getVault = () => requireVaultState('getVault').vault.contents.slice();

  inventory.getEntireVault = () => {
    const state = requireVaultState('getEntireVault');
    return {
      capturedAt: state.capturedAt,
      vault: state.vault.contents.slice(),
      material: state.material.contents.slice(),
      gift: state.gift.contents.slice(),
      potion: state.potion.contents.slice(),
      seasonalSpoils: state.seasonalSpoils.contents.slice(),
    };
  };

  inventory.getMaterials = () => requireVaultState('getMaterials').material.contents.slice();
  inventory.getPotions   = () => requireVaultState('getPotions').potion.contents.slice();
  inventory.getGifts     = () => requireVaultState('getGifts').gift.contents.slice();
  inventory.getSeasonalSpoils = () => requireVaultState('getSeasonalSpoils').seasonalSpoils.contents.slice();

  inventory.getSlot = (index: number) => {
    const p = playerData(deps);
    if (!p || index < 0 || index >= INVENTORY_TOTAL_SLOT_COUNT) return null;
    const objectType = typeIdAtSlot(p, index);
    if (objectType < 0) return null;
    return inventoryItemAt(deps, index, objectType);
  };

  inventory.getAll = () => {
    const p = playerData(deps);
    const out: number[] = new Array(INVENTORY_TOTAL_SLOT_COUNT).fill(-1);
    if (!p) return out;
    for (let i = 0; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      out[i] = cellTypeId(p.inventory[i]);
    }
    for (let i = 0; i < INVENTORY_BACKPACK_SLOT_COUNT; i++) {
      out[INVENTORY_MAIN_SLOT_COUNT + i] = cellTypeId(p.backpack[i]);
    }
    return out;
  };

  inventory.findItem = (query: number | string) => {
    const p = playerData(deps);
    if (!p) return null;
    for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
      const objectType = typeIdAtSlot(p, slot);
      if (objectType < 0) continue;
      if (slotMatchesQuery(deps, objectType, query)) {
        return inventoryItemAt(deps, slot, objectType);
      }
    }
    return null;
  };

  inventory.findItems = (query: number | string) => {
    const p = playerData(deps);
    if (!p) return [];
    const matches: InventoryItem[] = [];
    for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
      const objectType = typeIdAtSlot(p, slot);
      if (objectType < 0) continue;
      if (slotMatchesQuery(deps, objectType, query)) {
        matches.push(inventoryItemAt(deps, slot, objectType));
      }
    }
    return matches;
  };

  inventory.useItem = (slotIndex: number) => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;
    const itemType = typeIdAtSlot(c.playerData, slotIndex);
    if (itemType <= 0) return;
    try {
      const pkt = deps.proxy.packetFactory.createByName('USEITEM');
      pkt.data.time = Math.trunc(c.time);
      pkt.data.slotObject = { objectId: c.objectId, slotId: slotIndex, objectType: itemType };
      pkt.data.itemUsePos = { x: c.playerData.pos.x, y: c.playerData.pos.y };
      pkt.data.useType = 0;
      pkt.data.unknownInt = 0;
      pkt.modified = true;
      tryInventoryAction(c, () => String(typeIdAtSlot(c.playerData, slotIndex)), () => c.sendToServer(pkt));
    } catch {
      // Void SDK API: a disconnect or stale slot simply leaves the item alone.
    }
  };

  inventory.swapSlots = (slotA: number, slotB: number) => {
    const c = deps.clientRef.current;
    if (!c?.connected || slotA === slotB) return;
    const a = typeIdAtSlot(c.playerData, slotA);
    const b = typeIdAtSlot(c.playerData, slotB);
    if (a < 0 && b < 0) return;
    try {
      const pkt = deps.proxy.packetFactory.createByName('INVENTORYSWAP');
      pkt.data.time = Math.trunc(c.time);
      pkt.data.position = { x: c.playerData.pos.x, y: c.playerData.pos.y };
      pkt.data.slotObject1 = { objectId: c.objectId, slotId: slotA, objectType: a };
      pkt.data.slotObject2 = { objectId: c.objectId, slotId: slotB, objectType: b };
      pkt.modified = true;
      tryInventoryAction(c, () => `${typeIdAtSlot(c.playerData, slotA)}:${typeIdAtSlot(c.playerData, slotB)}`, () => c.sendToServer(pkt));
    } catch {
      // Void API: ignore stale-slot/disconnect races.
    }
  };

  /** Bag slots only: indices 4–11 (8 slots), per RotMG layout. */
  inventory.isFull = () => {
    const p = playerData(deps);
    if (!p) return false;
    for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      if (typeIdAtSlot(p, i) < 0) return false;
    }
    return true;
  };

  inventory.emptySlotCount = () => {
    const p = playerData(deps);
    if (!p) return 8;
    let n = 0;
    for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      if (typeIdAtSlot(p, i) < 0) n++;
    }
    return n;
  };

  inventory.getBackpack = () => backpackTierFromPlayerData(playerData(deps));
}
