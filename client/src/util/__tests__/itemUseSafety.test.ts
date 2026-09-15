import { afterEach, expect, it, vi } from 'vitest';
import { loot, inventory } from '@realmengine/sdk';
import { install } from '../../scripts/bridge/loot/index.js';
import { install as installInventory } from '../../scripts/bridge/inventory/index.js';
import { register as registerDrink } from '../../../plugins/auto-drink/index.js';
import { observeAbilityMana } from '../AbilityMana.js';
import { PlayerData } from '../../state/PlayerData.js';
import { StatType } from '../../constants/StatType.js';
import { findSlots } from '../../../plugins/auto-drink/slots.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { sendUseItemFromBag } from '../../../plugins/auto-loot/inventory.js';
import { sendUseItem } from '../../../plugins/auto-drink/useitem.js';

afterEach(() => vi.useRealTimers());

function fixture(slot: number, earlier: number) {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const bag = { objectId: 20, pos: { x: 5, y: 6 }, stats: { '8': earlier, [String(8 + slot)]: 2592 } };
  const client: any = { connected: true, objectId: 1, time: 1000, sendToServer: vi.fn(),
    playerData: { mapName: 'Realm', pos: { x: 5, y: 6 }, inventory: Array(12).fill(-1),
      backpack: [], quickSlots: [{ itemType: 2594, quantity: 1 }], hasBackpack: false } };
  const ctx: any = { createPacket: (name: string) => ({ name, data: {} }),
    worldState: { getEntity: () => bag } };
  install({ clientRef: { current: client }, worldState: ctx.worldState,
    gameData: { getAllObjects: () => [] }, proxy: { hookPacket: vi.fn(), packetFactory: { createByName: ctx.createPacket } } } as any);
  return { bag, client, ctx };
}

it.each([0, 1, 2])('consumes bag slot %i using its actual owner/index and the consume action', (slot) => {
  for (const earlier of [-1, 2591]) {
    const { bag, client } = fixture(slot, earlier);
    expect(loot.useFromBag(bag as any, slot)).toBe(true);
    expect(client.sendToServer.mock.calls[0][0].data).toMatchObject({
      slotObject: { objectId: 20, slotId: slot, objectType: 2592 },
      useType: 1, itemUsePos: { x: 5, y: 6 },
    });
    expect(loot.useFromBag(bag as any, slot)).toBe(false);
  }
});

it.each([0, 1, 2])('Auto Loot consumes bag slot %i with the same action as the SDK', (slot) => {
  const { bag, client, ctx } = fixture(slot, -1);
  expect(sendUseItemFromBag(ctx, client, bag as any, slot, 2592)).toBe(true);
  expect(client.sendToServer.mock.calls[0][0].data).toMatchObject({
    slotObject: { objectId: 20, slotId: slot, objectType: 2592 }, useType: 1, itemUsePos: { x: 5, y: 6 },
  });
});

it('does not drink a stale inventory potion twice, even after heal credit expires', () => {
  const { client, ctx } = fixture(0, -1);
  client.playerData.inventory[4] = 2594;
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(true);
  vi.setSystemTime(20000);
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(false);
  client.playerData.inventory[4] = -1;
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(false);
  client.playerData.inventory[4] = 2594;
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(true);
});

it('reserves each belt unit until its quantity decreases and accepts replenishment', () => {
  const { client, ctx } = fixture(0, -1);
  const belt = client.playerData.quickSlots[0]; belt.quantity = 2;
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(true);
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(true);
  vi.setSystemTime(20000);
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(false);
  belt.quantity = 1;
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(false);
  belt.quantity = 2;
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(true);
});

it('does not reserve a potion when transport throws', () => {
  const { client, ctx } = fixture(0, -1);
  client.sendToServer.mockImplementationOnce(() => { throw Error('closed'); });
  expect(() => sendUseItem(ctx, client, 1000000, 2594)).toThrow('closed');
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(true);
});

it('recovers from an invalid initial MP observation', () => {
  const player = { mana: NaN };
  expect(observeAbilityMana(player, player.mana)).toBe(0);
  player.mana = 50;
  expect(observeAbilityMana(player, player.mana)).toBe(50);
});

it('reserves script-issued ability mana and refuses an unaffordable retry', () => {
  const { client, ctx } = fixture(0, -1);
  client.playerData = new PlayerData(); client.playerData.mana = 20;
  client.playerData.inventory[1] = 123;
  installInventory({ clientRef: { current: client }, gameData: { getRawObjectXml: () => '<Object><MpCost>20</MpCost></Object>' },
    proxy: { hookPacket: vi.fn(), packetFactory: { createByName: ctx.createPacket } } } as any);
  inventory.useItem(1);
  expect(observeAbilityMana(client.playerData, client.playerData.mana)).toBe(0);
  vi.setSystemTime(20000); inventory.useItem(1);
  expect(client.sendToServer).toHaveBeenCalledTimes(1);
});

it('records human potion uses before the next automatic pass', () => {
  const { client, ctx } = fixture(0, -1);
  const hooks = new Map<string, any>();
  registerDrink({ ...ctx, enabled: true, registerSetting: vi.fn(), registerCleanup: vi.fn(),
    hookPacket: (name: string, callback: any) => hooks.set(name, callback), on: vi.fn(), log: vi.fn() });
  hooks.get('USEITEM')?.(client, { data: { useType: 1, slotObject: { objectId: 1, slotId: 1000000, objectType: 2594 } } });
  expect(sendUseItem(ctx, client, 1000000, 2594)).toBe(false);
});

it('observes consumed-and-refilled inventory between polling passes', () => {
  const { client, ctx } = fixture(0, -1);
  client.playerData = new PlayerData();
  client.playerData.parseStat(StatType.Inventory4, 2594);
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(true);
  client.playerData.parseStat(StatType.Inventory4, -1);
  client.playerData.parseStat(StatType.Inventory4, 2594);
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(true);
});

it('skips a reserved first potion slot and finds later inventory potions', () => {
  const { client, ctx } = fixture(0, -1);
  client.playerData.quickSlots = [];
  client.playerData.inventory[4] = 2594; client.playerData.inventory[5] = 2594;
  expect(sendUseItem(ctx, client, 4, 2594)).toBe(true);
  expect(findSlots(client, new Set([2594]), 1, false)).toEqual([{ slotId: 5, itemType: 2594 }]);
});

it.each([0, 1, 2])('serializes pickup and consume without shifting bag slot %i', (slot) => {
  const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
  for (const consume of [false, true]) {
    const { client, bag } = fixture(slot, -1);
    expect(consume ? loot.useFromBag(bag as any, slot) : loot.pickup(bag as any, slot)).toBe(true);
    const sent = client.sendToServer.mock.calls[0][0];
    const packet = factory.createByName(sent.name); Object.assign(packet.data, sent.data); packet.modified = true;
    const decoded = factory.createFromBytes(factory.serialize(packet), 'client');
    expect(decoded.data[consume ? 'slotObject' : 'slotObject1']).toEqual({ objectId: 20, slotId: slot, objectType: 2592 });
  }
});

it('keeps automatic potion predictions separate from authoritative MP', () => {
  const { client, ctx } = fixture(0, -1);
  client.playerData = new PlayerData(); client.playerData.mapName = 'Realm';
  client.playerData.maxMana = 100; client.playerData.mana = 0;
  client.playerData.parseStat(StatType.QuickSlot0, 2595, 1);
  const hooks = new Map<string, any>();
  registerDrink({ ...ctx, enabled: true, registerSetting: vi.fn(), registerCleanup: vi.fn(),
    hookPacket: (name: string, callback: any) => hooks.set(name, callback), on: vi.fn(), log: vi.fn() });
  hooks.get('NEWTICK')(client);
  expect(client.sendToServer).toHaveBeenCalledTimes(1);
  expect(client.playerData.mana).toBe(0);
  expect(observeAbilityMana(client.playerData, client.playerData.mana)).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(client.sendToServer).toHaveBeenCalledTimes(1);
  client.playerData.parseStat(StatType.QuickSlot0, 2595, 0);
  client.playerData.parseStat(StatType.MP, 100);
  expect(observeAbilityMana(client.playerData, client.playerData.mana)).toBe(100);
});
