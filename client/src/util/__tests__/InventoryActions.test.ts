import { it, expect, vi, afterEach } from 'vitest';
import { tryInventoryAction } from '../InventoryActions.js';
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
