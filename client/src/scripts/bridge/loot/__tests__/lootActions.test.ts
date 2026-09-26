import { it, expect, vi, afterEach } from 'vitest';
import { loot } from '@realmengine/sdk';
import { install } from '../index.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { tryInventoryAction } from '../../../../util/InventoryActions.js';
afterEach(() => vi.useRealTimers());
it('drains a two-item bag over acknowledged calls and shares the plugin action gate', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const bag = { objectId: 20, pos: { x: 0, y: 0 }, stats: { '8': 2592, '9': 2593 } };
  const send = vi.fn();
  const client: any = { connected: true, objectId: 1, time: 100,
    playerData: { mapName: 'Realm', pos: { x: 0, y: 0 }, inventory: Array(12).fill(-1),
      backpack: Array(16).fill(-1), hasBackpack: false, quickSlots: [] }, sendToServer: send };
  install({ clientRef: { current: client },
    worldState: { getEntity: (id: number) => id === 20 ? bag : null },
    gameData: { getAllObjects: () => [] },
    proxy: { hookPacket: vi.fn(), packetFactory: { createByName: (name: string) => ({ name, data: {} }) } },
  } as unknown as BridgeDeps);
  expect(loot.pickupId(20)).toBe(1);
  expect(send.mock.calls[0][0].data.slotObject1.slotId).toBe(0);
  expect(loot.pickupId(20)).toBe(0);
  vi.setSystemTime(11400);
  expect(tryInventoryAction(client, () => 'plugin-slot', () => {})).toBe(false);
  bag.stats['8'] = -1;
  expect(loot.pickupId(20)).toBe(0); // Source acknowledgement alone cannot release destination.
  client.playerData.inventory[4] = 2592;
  expect(loot.pickupId(20)).toBe(1);
  expect(send.mock.calls[1][0].data.slotObject1.slotId).toBe(1);
  expect(send.mock.calls[1][0].data.slotObject2.slotId).toBe(5);
  expect(send).toHaveBeenCalledTimes(2);
});

it('dropInventorySlot sends INVDROP for a bag slot, refuses gear slots and empty slots, and shares the gate', () => {
  vi.useFakeTimers(); vi.setSystemTime(20000);
  const send = vi.fn();
  const client: any = { connected: true, objectId: 7, time: 100,
    playerData: { mapName: 'Realm', pos: { x: 0, y: 0 }, inventory: Array(12).fill(-1),
      backpack: Array(16).fill(-1), hasBackpack: false, quickSlots: [] }, sendToServer: send };
  client.playerData.inventory[0] = 2620; // equipped weapon
  client.playerData.inventory[4] = 2654; // trash sitting in the first bag slot
  install({ clientRef: { current: client },
    worldState: { getEntity: () => null },
    gameData: { getAllObjects: () => [] },
    proxy: { hookPacket: vi.fn(), packetFactory: { createByName: (name: string) => ({ name, data: {} }) } },
  } as unknown as BridgeDeps);

  // Gear slots are never droppable through this action.
  expect(loot.dropInventorySlot(0)).toBe(false);
  expect(send).not.toHaveBeenCalled();

  // An empty bag slot has nothing to drop.
  expect(loot.dropInventorySlot(5)).toBe(false);
  expect(send).not.toHaveBeenCalled();

  // A real bag slot sends INVDROP naming the player's own object and the slot's item.
  expect(loot.dropInventorySlot(4)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].name).toBe('INVDROP');
  expect(send.mock.calls[0][0].data.slotObject).toEqual({ objectId: 7, slotId: 4, objectType: 2654 });

  // The shared inventory-action gate blocks a second automatic action before it settles.
  expect(loot.dropInventorySlot(4)).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);

  // Once the slot actually clears (server ack simulated), the gate releases.
  client.playerData.inventory[4] = -1;
  client.playerData.inventory[6] = 2577;
  vi.setSystemTime(21300);
  expect(loot.dropInventorySlot(6)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].data.slotObject).toEqual({ objectId: 7, slotId: 6, objectType: 2577 });
});
