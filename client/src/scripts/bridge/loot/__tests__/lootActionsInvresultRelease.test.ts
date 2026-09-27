import { it, expect, vi, afterEach } from 'vitest';
import { loot } from '@realmengine/sdk';
import { install } from '../index.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

afterEach(() => vi.useRealTimers());

// Live evidence (2026-09-27, rig realm-engine-proxy.log 02:46:06-02:46:11 UTC +
// testlab/packets-20260927T024219Z.jsonl): the farmer's pickup of bag#237067
// slot 0 sent an INVENTORYSWAP; the server answered with INVRESULT ok:false
// within ~92ms (slot1 {objectId:237067, slotId:0, objectType:21224}, slot2
// {objectId:236874, slotId:5, objectType:-1}), but nothing client-side ever
// changed on that rejection, so the old read()-based settle check stayed
// 'pending' for the full 5000ms bound — five seconds where "pickup refused
// ... inventory gate busy" repeated on every attempt, climbing 1756 -> 4943ms,
// before the gate's hard timeout finally let the retry through (which then
// succeeded, per the run's second INVRESULT ok:true ~5s later).
//
// This is a standalone file (not appended to lootActions.test.ts) specifically
// so the loot bridge's one-time `hookInstalled` guard is fresh: it needs to
// actually register the INVRESULT hook this call, not skip it because an
// earlier test in the same module already installed once.
it('a rejected INVRESULT frees the shared inventory gate immediately, instead of waiting out the 5000ms fallback', () => {
  vi.useFakeTimers(); vi.setSystemTime(30000);
  const bag = { objectId: 237067, pos: { x: 0, y: 0 }, stats: { '8': 21224 } };
  const send = vi.fn();
  const handlers: Record<string, (client: any, packet: any) => void> = {};
  const client: any = { connected: true, objectId: 236874, time: 100,
    playerData: { mapName: 'Realm', pos: { x: 0, y: 0 }, inventory: Array(12).fill(-1),
      backpack: Array(16).fill(-1), hasBackpack: false, quickSlots: [] }, sendToServer: send };
  install({ clientRef: { current: client },
    worldState: { getEntity: (id: number) => (id === 237067 ? bag : null) },
    gameData: { getAllObjects: () => [] },
    proxy: {
      hookPacket: (name: string, fn: (client: any, packet: any) => void) => { handlers[name] = fn; },
      packetFactory: { createByName: (name: string) => ({ name, data: {} }) },
    },
  } as unknown as BridgeDeps);

  // Destination is main-inventory slot 4 (first free slot; the bag arrives on
  // slot 0 with item 21224, matching the run's UT/ST pickup path).
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);

  // A second attempt inside the gate window is refused, same as the run's log.
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(false);
  vi.setSystemTime(30092); // matches the run's ~92ms server turnaround
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(false);

  // The server's rejection arrives — nothing client-side changed (the bag
  // still holds the item, slot 4 is still empty), so the old settle check
  // would never fire; this must release the gate anyway.
  expect(handlers.INVRESULT).toBeDefined();
  handlers.INVRESULT(client, {
    isDefined: true,
    data: {
      fromSlot: { objectId: 237067, slotId: 0, objectType: 21224 },
      toSlot: { objectId: 236874, slotId: 4, objectType: -1 },
      unknownBool: false,
    },
  });

  // Retryable immediately — no need to wait out the 1300/5000ms bounds.
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);

  // An INVRESULT for different slots (some other action entirely) must not
  // release a gate that is still legitimately held by this new pending swap.
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(false);
  handlers.INVRESULT(client, {
    isDefined: true,
    data: {
      fromSlot: { objectId: 999, slotId: 3, objectType: 1 },
      toSlot: { objectId: 998, slotId: 6, objectType: -1 },
      unknownBool: true,
    },
  });
  expect(loot.pickup(bag, 0, { useBackpack: true })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});
