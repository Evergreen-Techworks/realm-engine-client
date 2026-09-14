import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SDKBridge } from '../bridge/index.js';
import type { BridgeDeps } from '../bridge/BridgeDeps.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';
import { PacketFactory } from '../../packets/PacketFactory.js';
import type { Packet } from '../../packets/Packet.js';
import PACKET_DEFINITIONS from '../../packets/packetDefinitions.generated.js';
import STAT_TYPES from '../../packets/statTypes.generated.js';
import { Proxy } from '../../proxy/Proxy.js';
import { ClientConnection } from '../../proxy/ClientConnection.js';
import { StateManager } from '../../state/StateManager.js';
import { GameWorldState } from '../../state/GameWorldState.js';
import { PartyRosterState } from '../../state/PartyRosterState.js';
import { GameDataLoader } from '../../game-data/GameDataLoader.js';
import { StatType } from '../../constants/StatType.js';

vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isPacketDebugEnabled: () => false },
}));

// The Realm Farmer's bag step on the REAL SDK: SDKBridge.install over a real
// Proxy, PacketFactory, StateManager and GameWorldState, the shipped farmer
// module, and the bag arriving as a serialized UPDATE. What the farmer does is
// read back from the packets written to the server socket.
//
// Game data rows are verbatim from the game's objects.xml (RE_ASSETS/data,
// RotMG 86ad651b), trimmed to the tags the SDK reads. The bag colour comment on
// each bag is its sprite (lofiObj4) sampled from mapObjects.png: "Loot Bag 5" is
// the dark-blue bag that stat potions (BagType 5) drop in; "Loot Bag 6" is the
// white bag that untiered items (BagType 6) drop in; Loot Bags 7, 8 and 9 are the
// gold, orange and red bags.
const OBJECTS_XML = `<Objects>
  <Object type="0x0307" id="Archer"><Class>Player</Class><Player /><MaxHitPoints max="750">150</MaxHitPoints><MaxMagicPoints max="300">100</MaxMagicPoints><Attack max="75">17</Attack><Defense max="25">0</Defense><Speed max="55">22</Speed><Dexterity max="50">15</Dexterity><HpRegen max="40">5</HpRegen><MpRegen max="50">15</MpRegen></Object>
  <Object type="0x050B" id="Loot Bag 5"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x06be" id="Loot Bag 5 Boost"><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x050C" id="Loot Bag 6"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x0510" id="Loot Bag 6 Boost"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x050E" id="Loot Bag 7"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x6bc" id="Loot Bag 7 Boost"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x50f" id="Loot Bag 8"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x6bf" id="Loot Bag 8 Boost"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x6ac" id="Loot Bag 9"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0x6c0" id="Loot Bag 9 Boost"><DisplayId>Loot Bag</DisplayId><Class>Container</Class><Container /><CanPutNormalObjects /><CanPutSoulboundObjects /><Loot /><SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes></Object>
  <Object type="0xa17" id="Obsidian Dagger"><Class>Equipment</Class><SlotType>2</SlotType><Tier>6</Tier><BagType>1</BagType></Object>
  <Object type="0xa8d" id="Bow of Innocent Blood"><Class>Equipment</Class><SlotType>3</SlotType><Tier>11</Tier><BagType>4</BagType></Object>
  <Object type="0xb02" id="Bow of Covert Havens"><Class>Equipment</Class><SlotType>3</SlotType><Tier>12</Tier><BagType>4</BagType></Object>
  <Object type="0xc0b" id="Orb of Conflict"><Class>Equipment</Class><SlotType>21</SlotType><BagType>6</BagType><Soulbound /></Object>
  <Object type="0xa1f" id="Potion of Attack"><Class>Equipment</Class><SlotType>10</SlotType><Tier>2</Tier><Activate stat="ATT" amount="1">IncrementStat</Activate><Consumable /><Potion /><BagType>5</BagType></Object>
  <Object type="0xa21" id="Potion of Speed"><Class>Equipment</Class><SlotType>10</SlotType><Tier>2</Tier><Activate stat="SPD" amount="1">IncrementStat</Activate><Consumable /><Potion /><BagType>5</BagType></Object>
</Objects>`;
const TILES_XML = `<GroundTypes><Ground type="0xb04c" id="O3 Normal Tile Corner"/></GroundTypes>`;
const TYPE = {
  ARCHER: 0x0307, LOOT_BAG_5: 0x050b, LOOT_BAG_5_BOOST: 0x06be, LOOT_BAG_6: 0x050c, LOOT_BAG_6_BOOST: 0x0510,
  LOOT_BAG_7: 0x050e, LOOT_BAG_7_BOOST: 0x06bc, LOOT_BAG_8: 0x050f, LOOT_BAG_8_BOOST: 0x06bf,
  LOOT_BAG_9: 0x06ac, LOOT_BAG_9_BOOST: 0x06c0,
  OBSIDIAN_DAGGER: 0xa17, INNOCENT_BLOOD_BOW: 0xa8d, COVERT_BOW: 0xb02, ORB_OF_CONFLICT: 0xc0b,
  POT_ATTACK: 0xa1f, POT_SPEED: 0xa21, FLOOR: 0xb04c,
};
const ME = 1000;
const BAG = 5000;

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
const proxy = new Proxy(factory);
const stateManager = new StateManager();
stateManager.attach(proxy);
const worldState = new GameWorldState();
worldState.attach(proxy);
const clientRef: { current: ClientConnection | undefined } = { current: undefined };
const running: Array<{ onStop(): void }> = [];

function wire(name: string, data: Record<string, unknown>): Packet {
  const p = factory.createByName(name);
  Object.assign(p.data, data);
  const back = factory.createFromBytes(factory.serialize(p), p.direction as 'client' | 'server');
  if (!back.isDefined || back.name !== name) throw new Error(`${name} did not survive the wire`);
  return back;
}

let dataDir: string;
let Farmer: any;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'farmer-bag-loot-'));
  writeFileSync(join(dataDir, 'objects.xml'), OBJECTS_XML);
  writeFileSync(join(dataDir, 'tiles.xml'), TILES_XML);
  const gameData = new GameDataLoader();
  gameData.load(join(dataDir, 'objects.xml'));
  gameData.loadTiles(join(dataDir, 'tiles.xml'));
  SDKBridge.install({
    stateManager, clientRef, worldState, getWorldStateForClient: () => worldState,
    partyRoster: new PartyRosterState(), gameData, proxy, scriptSession: { scriptId: undefined },
    emitScriptLog: () => {}, emitScriptPanelMessage: () => {}, setScriptActivityLabel: () => {},
  } as unknown as BridgeDeps);
  Farmer = (await import('../../../script-packages/farmer/index.mjs' as string)).default;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_789_000_000_000); });
afterEach(() => {
  for (const script of running.splice(0)) script.onStop();
  clientRef.current = undefined;
  setDllFeatureSender(null);
  vi.useRealTimers();
});

type Stats = Record<number, number>;
const entity = (objectType: number, objectId: number, x: number, y: number, stats: Stats = {}) => ({
  objectType, status: { objectId, position: { x, y },
    data: Object.entries(stats).map(([id, value]) => ({ id: Number(id), value, stackCount: 0 })) },
});
const bagSlots = (items: number[]): Stats =>
  Object.fromEntries(items.map((item, slot) => [StatType.Inventory0 + slot, item]));

/**
 * A Realm connection with an Archer (Bow of Covert Havens equipped, so a dagger
 * is no upgrade) standing on `bag`, and the farmer started.
 */
function standOnBag(bagType: number, items: number[], playerStats: Stats = {}) {
  worldState.clear();
  setDllFeatureSender(() => {});
  const conn = new ClientConnection(proxy, Object.assign(new EventEmitter(), { setNoDelay() {} }) as any);
  const sent: Packet[] = [];
  Object.assign(conn as any, {
    serverSendCipher: { cipher() {} },
    serverSocket: { destroyed: false, write: (b: Buffer) => { sent.push(factory.createFromBytes(Buffer.from(b), 'client')); return true; } },
  });
  clientRef.current = conn;
  const server = (name: string, data: Record<string, unknown>) => proxy.fireServerPacket(conn, wire(name, data));
  proxy.fireClientPacket(conn, wire('PONG', { serial: 1, time: 5000 }));
  server('MAPINFO', {
    width: 64, height: 64, name: 'Realm of the Mad God', displayName: 'Realm of the Mad God', realmName: '',
    fp: 1, background: 0, difficulty: 0, allowPlayerTeleport: false, noSave: false, showDisplays: true,
    maxPlayers: 85, gameOpenedTime: 0, serverVersion: '7.0.0.2.0', viewDistance: 25,
  });
  server('CREATESUCCESS', { objectId: ME, charId: 1, stats: '' });
  const tiles = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) tiles.push({ x, y, type: TYPE.FLOOR });
  const archer = entity(TYPE.ARCHER, ME, 1.5, 1.5, {
    [StatType.MaxHP]: 150, [StatType.HP]: 150, [StatType.MaxMP]: 100, [StatType.MP]: 100,
    [StatType.Attack]: 17, [StatType.Defense]: 0, [StatType.Speed]: 22, [StatType.Dexterity]: 15,
    [StatType.Vitality]: 5, [StatType.Wisdom]: 15,
    [StatType.Inventory0]: TYPE.COVERT_BOW,
    ...playerStats,
  });
  server('UPDATE', { position: { x: 0, y: 0 }, levelType: 0, tiles, drops: [],
    newObjs: [archer, entity(bagType, BAG, 1.5, 1.5, bagSlots(items))] });

  const farmer = new Farmer();
  running.push(farmer);
  farmer.onStart();
  /** Run the farmer's loop past its bag-settle wait; returns what reached the server. */
  const loot = () => {
    farmer.onLoop();
    vi.advanceTimersByTime(800);
    farmer.onLoop();
    return sent.filter((p) => p.name === 'INVENTORYSWAP' || p.name === 'USEITEM')
      .map((p) => p.name === 'USEITEM'
        ? { use: p.data.slotObject.slotId, item: p.data.slotObject.objectType }
        : { take: p.data.slotObject1.slotId, item: p.data.slotObject1.objectType, to: p.data.slotObject2.slotId });
  };
  return { farmer, loot };
}

describe('Realm Farmer bag loot on the real SDK', () => {
  it.each([
    ['Loot Bag 5', TYPE.LOOT_BAG_5],
    ['Loot Bag 5 Boost', TYPE.LOOT_BAG_5_BOOST],
  ])('a dark-blue potion bag (%s) yields only the potion the Archer needs, not the rest of the bag', (_name, bagType) => {
    const s = standOnBag(bagType, [TYPE.OBSIDIAN_DAGGER, TYPE.POT_ATTACK]);
    expect(s.loot()).toEqual([{ use: 1, item: TYPE.POT_ATTACK }]);
  });

  it.each([
    ['Loot Bag 6', TYPE.LOOT_BAG_6],
    ['Loot Bag 6 Boost', TYPE.LOOT_BAG_6_BOOST],
  ])('a white bag (%s) still has every item collected', (_name, bagType) => {
    const s = standOnBag(bagType, [TYPE.OBSIDIAN_DAGGER]);
    expect(s.loot()).toEqual([{ take: 0, item: TYPE.OBSIDIAN_DAGGER, to: 4 }]);
  });

  // Gold, orange and red bags go through Auto Loot's filter like the blue bags:
  // the farmer itself only drinks useful potions, takes UT/ST items and equips upgrades.
  const RARE_BAGS: Array<[string, number]> = [
    ['gold bag (Loot Bag 7)', TYPE.LOOT_BAG_7],
    ['gold bag (Loot Bag 7 Boost)', TYPE.LOOT_BAG_7_BOOST],
    ['orange bag (Loot Bag 8)', TYPE.LOOT_BAG_8],
    ['orange bag (Loot Bag 8 Boost)', TYPE.LOOT_BAG_8_BOOST],
    ['red bag (Loot Bag 9)', TYPE.LOOT_BAG_9],
    ['red bag (Loot Bag 9 Boost)', TYPE.LOOT_BAG_9_BOOST],
  ];

  it.each(RARE_BAGS)('the %s holding only an item nothing wants is left alone', (_name, bagType) => {
    const s = standOnBag(bagType, [TYPE.OBSIDIAN_DAGGER]);
    expect(s.loot()).toEqual([]);
  });

  it.each(RARE_BAGS)('the %s gives up its UT item and keeps the unwanted one', (_name, bagType) => {
    const s = standOnBag(bagType, [TYPE.OBSIDIAN_DAGGER, TYPE.ORB_OF_CONFLICT]);
    expect(s.loot()).toEqual([{ take: 1, item: TYPE.ORB_OF_CONFLICT, to: 4 }]);
  });

  it.each(RARE_BAGS)('the %s still has its equip upgrade equipped', (_name, bagType) => {
    const s = standOnBag(bagType, [TYPE.OBSIDIAN_DAGGER, TYPE.COVERT_BOW],
      { [StatType.Inventory0]: TYPE.INNOCENT_BLOOD_BOW });
    expect(s.loot()).toEqual([{ take: 1, item: TYPE.COVERT_BOW, to: 0 }]);
  });

  it('skips a Potion of Attack once Attack is capped, even while Defense is not', () => {
    const s = standOnBag(TYPE.LOOT_BAG_5, [TYPE.POT_ATTACK], { [StatType.Attack]: 75 });
    expect(s.loot()).toEqual([]);
  });

  it('drinks a Potion of Speed while Speed is below cap, even with Attack capped', () => {
    const s = standOnBag(TYPE.LOOT_BAG_5, [TYPE.POT_SPEED], { [StatType.Attack]: 75 });
    expect(s.loot()).toEqual([{ use: 0, item: TYPE.POT_SPEED }]);
  });
});
