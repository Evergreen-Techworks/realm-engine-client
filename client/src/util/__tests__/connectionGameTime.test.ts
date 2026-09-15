import { afterEach, expect, it, vi } from 'vitest';
import { inventory, loot } from '@realmengine/sdk';
import { connectionGameTime } from '../connectionGameTime.js';
import { install as installLoot } from '../../scripts/bridge/loot/index.js';
import { install as installInventory } from '../../scripts/bridge/inventory/index.js';
import type { BridgeDeps } from '../../scripts/bridge/BridgeDeps.js';
import type { PluginContext } from '../../../plugins/api.js';
import { sendUseItemFromBag } from '../../../plugins/auto-loot/inventory.js';
import { sendUseItem } from '../../../plugins/auto-drink/useitem.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';

// 2026-09-14 proxy log, right after "Player created" on a map change:
// "Failed to serialize USEITEM ... Received 1_789_434_968_802" — epoch ms in the
// int32 time field, so the packet was never sent.
const EPOCH_MS = 1_789_434_968_802;
const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

afterEach(() => { vi.useRealTimers(); });

it('reports no game time until the connection has one', () => {
  expect(connectionGameTime({ time: EPOCH_MS })).toBeNull();
  expect(connectionGameTime({ time: 0x80000000 })).toBeNull();
  expect(connectionGameTime({ time: NaN })).toBeNull();
  expect(connectionGameTime({})).toBeNull();
  expect(connectionGameTime(null)).toBeNull();
  expect(connectionGameTime({ time: 5000.7 })).toBe(5000);
  expect(connectionGameTime({ time: 0x7fffffff })).toBe(0x7fffffff);
});

function client(time: number, send = vi.fn()) {
  return { connected: true, objectId: 1, time, sendToServer: send,
    playerData: { mapName: `Realm ${Math.random()}`, pos: { x: 0, y: 0 }, inventory: [-1, -1, -1, -1, 2592, -1, -1, -1, -1, -1, -1, -1],
      backpack: Array(16).fill(-1), hasBackpack: false, quickSlots: [{ itemType: 2594, quantity: 1 }] } } as any;
}

/** What ClientConnection.send would put on the wire, or null when serialization fails. */
function serialized(packet: any): Buffer | null {
  const full = factory.createByName('USEITEM');
  Object.assign(full.data, packet.data);
  full.modified = true;
  const bytes = factory.serialize(full);
  return bytes.length > 0 ? bytes : null;
}

it('the SDK bridge sends USEITEM only with a game time that serializes', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const bag = { objectId: 20, pos: { x: 0, y: 0 }, stats: { '8': 2592 } };
  const deps = { clientRef: { current: null as any },
    worldState: { getEntity: (id: number) => id === 20 ? bag : null },
    gameData: { getAllObjects: () => [] },
    proxy: { hookPacket: vi.fn(), packetFactory: { createByName: (name: string) => ({ name, data: {} }) } },
  } as unknown as BridgeDeps;
  installLoot(deps); installInventory(deps);

  const early = client(EPOCH_MS);
  deps.clientRef.current = early;
  expect(loot.useFromBag({ objectId: 20 } as any, 0)).toBe(false);
  inventory.useItem(4);
  expect(early.sendToServer).not.toHaveBeenCalled();

  const bagUse = client(4321);
  deps.clientRef.current = bagUse;
  expect(loot.useFromBag({ objectId: 20 } as any, 0)).toBe(true);
  expect(bagUse.sendToServer.mock.calls[0][0].data.time).toBe(4321);
  expect(serialized(bagUse.sendToServer.mock.calls[0][0])).not.toBeNull();
  // The premise: the same packet stamped with epoch ms is exactly what failed in the log.
  expect(serialized({ data: { ...bagUse.sendToServer.mock.calls[0][0].data, time: EPOCH_MS } })).toBeNull();

  const invUse = client(4322);
  deps.clientRef.current = invUse;
  inventory.useItem(4);
  expect(invUse.sendToServer.mock.calls[0][0].data.time).toBe(4322);
});

it('Auto Loot and Auto Drink skip USEITEM until the game time is known', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const ctx = { createPacket: (name: string) => ({ name, data: {} }),
    worldState: { getEntity: () => ({ stats: { '8': 2592 } }) } } as unknown as PluginContext;
  const bag = { objectId: 20, pos: { x: 0, y: 0 }, stats: { '8': 2592 } } as any;

  const early = client(EPOCH_MS);
  expect(sendUseItemFromBag(ctx, early, bag, 0, 2592)).toBe(false);
  expect(sendUseItem(ctx, early, 1000000, 2594)).toBe(false);
  expect(early.sendToServer).not.toHaveBeenCalled();

  const ready = client(777);
  expect(sendUseItemFromBag(ctx, ready, bag, 0, 2592)).toBe(true);
  expect(sendUseItem(ctx, ready, 1000000, 2594)).toBe(true);
  expect(ready.sendToServer.mock.calls.map(([p]: any[]) => p.data.time)).toEqual([777, 777]);
});
