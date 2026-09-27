import { it, expect, vi, afterEach } from 'vitest';
import { tryInventoryAction, resolveInventoryAction } from '../InventoryActions.js';
afterEach(() => vi.useRealTimers());
it('serializes separate senders until slot acknowledgement and spacing, then admits the second item', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const client = { playerData: { mapName: 'Realm' } };
  let slot = 2592; const send = vi.fn();
  expect(tryInventoryAction(client, () => String(slot), send)).toBe(true);
  expect(tryInventoryAction(client, () => 'second', send)).toBe(false);
  vi.setSystemTime(11400);
  expect(tryInventoryAction(client, () => 'second', send)).toBe(false);
  slot = -1;
  expect(tryInventoryAction(client, () => 'second', send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});
it('recovers from rejected sends and map transitions', () => {
  const client = { playerData: { mapName: 'Realm' } };
  expect(() => tryInventoryAction(client, () => 'item', () => { throw Error('disconnected'); })).toThrow();
  expect(tryInventoryAction(client, () => 'item', () => {})).toBe(true);
  client.playerData.mapName = 'Nexus';
  expect(tryInventoryAction(client, () => 'item', () => {})).toBe(true);
});

// Live evidence (2026-09-27, rig realm-engine-proxy.log 02:46:06-02:46:11 UTC +
// testlab/packets-20260927T024219Z.jsonl): a pickup's INVENTORYSWAP was
// answered by the server with INVRESULT ok:false within ~92ms, but nothing
// client-side ever changed (the swap never happened), so the old read()-based
// settle check stayed 'pending' for the full 5000ms bound before the gate
// would let anything else through — five seconds where every other pickup,
// equip, use and Auto Loot swap was refused as "inventory gate busy".
it('releases the gate immediately on a matching INVRESULT, success or rejection, without waiting for the read()/timeout fallback', () => {
  const client = { playerData: { mapName: 'Realm' } };
  const send = vi.fn();
  const swapIdentity = { fromSlot: { objectId: 237067, slotId: 0 }, toSlot: { objectId: 236874, slotId: 5 } };
  expect(tryInventoryAction(client, () => 'pending', send, swapIdentity)).toBe(true);
  // Nothing changed client-side — a plain read()-based settle would never fire.
  expect(tryInventoryAction(client, () => 'pending', send)).toBe(false);
  // The server's rejection names the exact slots the pending action touched.
  resolveInventoryAction(client,
    { objectId: 237067, slotId: 0, objectType: 21224 },
    { objectId: 236874, slotId: 5, objectType: -1 });
  // The gate is free immediately — no need to wait out the 1300/5000ms bounds.
  expect(tryInventoryAction(client, () => 'retry', send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('a successful INVRESULT also releases the gate immediately, not just a rejection', () => {
  const client = { playerData: { mapName: 'Realm' } };
  const send = vi.fn();
  const swapIdentity = { fromSlot: { objectId: 1, slotId: 0 }, toSlot: { objectId: 2, slotId: 5 } };
  expect(tryInventoryAction(client, () => 'pending', send, swapIdentity)).toBe(true);
  resolveInventoryAction(client, { objectId: 1, slotId: 0, objectType: -1 }, { objectId: 2, slotId: 5, objectType: 999 });
  expect(tryInventoryAction(client, () => 'pending', send)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('ignores an INVRESULT for different slots and leaves the gate held', () => {
  const client = { playerData: { mapName: 'Realm' } };
  const send = vi.fn();
  const swapIdentity = { fromSlot: { objectId: 1, slotId: 0 }, toSlot: { objectId: 2, slotId: 5 } };
  expect(tryInventoryAction(client, () => 'pending', send, swapIdentity)).toBe(true);
  resolveInventoryAction(client, { objectId: 999, slotId: 3, objectType: 1 }, { objectId: 998, slotId: 4, objectType: -1 });
  expect(tryInventoryAction(client, () => 'pending', send)).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
});

it('a resolve call with no pending swap identity (e.g. a USEITEM/INVDROP gate hold) is a no-op', () => {
  const client = { playerData: { mapName: 'Realm' } };
  const send = vi.fn();
  expect(tryInventoryAction(client, () => 'pending', send)).toBe(true);
  expect(() => resolveInventoryAction(client,
    { objectId: 1, slotId: 0, objectType: 1 }, { objectId: 2, slotId: 5, objectType: -1 })).not.toThrow();
  // Still held — an unrelated INVRESULT must not clear a non-swap gate hold.
  expect(tryInventoryAction(client, () => 'pending', send)).toBe(false);
});
