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
