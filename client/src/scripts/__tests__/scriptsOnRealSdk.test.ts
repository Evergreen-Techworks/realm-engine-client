import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealmEngine } from '@realmengine/sdk';
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
import { PluginContext } from '../../plugins/PluginContext.js';
import { StatType } from '../../constants/StatType.js';
import { TOMATO_ANIMATION_STAT_WIRE } from '../../damage-sniffer/tomatoBossGuards.js';

vi.mock('../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), isPacketDebugEnabled: () => false },
}));

// The Oryx / Lost Halls scripts' own tests hand them a fake SDK. These run the
// shipped scripts on the REAL one: SDKBridge.install (the production installer)
// over a real Proxy, PacketFactory, StateManager, GameWorldState and
// ClientConnection, with game data loaded by the real GameDataLoader. The world
// arrives as serialized server packets, and what the scripts do is read back
// from the real outbound interfaces: DLL feature commands, the script activity
// label, and packets written to the server socket.
//
// Shaped like production: one Proxy and one bridge install per process (some
// bridges hook packets once per process), and each test is a fresh connection.

// ─── Game data ───────────────────────────────────────────────────────────────
// Real definitions from the game's objects.xml / tiles.xml (RE_ASSETS/data,
// server 7.0.0.2.0), trimmed to the tags the SDK reads. type, id and DisplayId
// are verbatim; the bridge names an object DisplayId || id, so these are the
// names the scripts' patterns meet in the live game.
const OBJECTS_XML = `<Objects>
  <Object type="0x0307" id="Archer"><Class>Player</Class><MaxHitPoints>150</MaxHitPoints></Object>
  <Object type="0x0a61" id="Magic Quiver"><Class>Equipment</Class><SlotType>15</SlotType><Activate>Shoot</Activate><MpCost>45</MpCost></Object>
  <Object type="0xb133" id="Oryx the Mad God 3"><Class>Character</Class><DisplayId>Oryx the Mad God</DisplayId><Enemy/><Quest/><MaxHitPoints>562500</MaxHitPoints><Defense>75</Defense></Object>
  <Object type="0x7119" id="Oryx Tall Brick Wall"><Class>GameObject</Class><OccupySquare/><EnemyOccupySquare/><FullOccupy/><BlocksSight/><Static/></Object>
  <Object type="0xb13b" id="LH Marble Defender"><Class>Character</Class><DisplayId>Marble Defender</DisplayId><Enemy/><Quest/><MaxHitPoints>54375</MaxHitPoints><Defense>30</Defense></Object>
  <Object type="0xb095" id="LH Marble Wall"><Class>Wall</Class><Enemy/><MaxHitPoints>12000</MaxHitPoints><OccupySquare/><EnemyOccupySquare/><FullOccupy/><BlocksSight/><Static/></Object>
</Objects>`;
const TILES_XML = `<GroundTypes>
  <Ground type="0xb04c" id="O3 Normal Tile Corner"/>
  <Ground type="0xb01a" id="LH Main Tile"/>
</GroundTypes>`;
const TYPE = {
  ARCHER: 0x0307, MAGIC_QUIVER: 0x0a61, ORYX_3: 0xb133, BRICK_WALL: 0x7119,
  DEFENDER: 0xb13b, LH_WALL: 0xb095, O3_FLOOR: 0xb04c, LH_FLOOR: 0xb01a,
};
// Oryx 3's guard animation (RealmShark Tomato; tomatoBossGuards.ts).
const ORYX_GUARD_ANIMATION = -935464302;
// The server refusing a TELEPORT right after a server change, verbatim from the
// user's capture packets_2026-09-10T05_30_36.json (row 687).
const TELEPORT_REFUSAL_HEX =
  '00000038430902002f57616974203438207365636f6e647320746f2074656c65706f727420616674657220736572766572206368616e6765';

const ME = 1000;
const BOSS = 2000;
const REPO_CLIENT = fileURLToPath(new URL('../../../', import.meta.url));

// ─── The process: one proxy, one bridge install ──────────────────────────────
const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);
const proxy = new Proxy(factory);
const stateManager = new StateManager();
stateManager.attach(proxy);
const worldState = new GameWorldState();
worldState.attach(proxy);
const clientRef: { current: ClientConnection | undefined } = { current: undefined };
const recorded = { dll: [] as Array<[string, unknown]>, activity: [] as string[] };
const running = { scripts: [] as Array<{ onStop(): void }>, plugins: [] as PluginContext[] };

/** Built, serialized and re-read by the real factory, as the proxy delivers it. */
function wire(name: string, data: Record<string, unknown>): Packet {
  const p = factory.createByName(name);
  Object.assign(p.data, data);
  const back = factory.createFromBytes(factory.serialize(p));
  if (!back.isDefined || back.name !== name) throw new Error(`${name} did not survive the wire`);
  return back;
}

let gameData: GameDataLoader;
let dataDir: string;
let Farmer: any;
let LostHallsVoidFarmer: any;
let bundledAutoAbility: { code: string; register: (ctx: PluginContext) => void };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'real-sdk-'));
  writeFileSync(join(dataDir, 'objects.xml'), OBJECTS_XML);
  writeFileSync(join(dataDir, 'tiles.xml'), TILES_XML);
  gameData = new GameDataLoader();
  gameData.load(join(dataDir, 'objects.xml'));
  gameData.loadTiles(join(dataDir, 'tiles.xml'));

  SDKBridge.install({
    stateManager, clientRef, worldState, getWorldStateForClient: () => worldState,
    partyRoster: new PartyRosterState(), gameData, proxy, scriptSession: { scriptId: undefined },
    emitScriptLog: () => {}, emitScriptPanelMessage: () => {},
    setScriptActivityLabel: (label: string | null) => { if (label) recorded.activity.push(label); },
  } as unknown as BridgeDeps);

  // The shipped script modules, imported as ScriptHost imports them: their own
  // `import ... from '@realmengine/sdk'` and relative imports, no source edits.
  Farmer = (await import('../../../script-packages/farmer/index.mjs' as string)).default;
  LostHallsVoidFarmer = (await import('../../../script-packages/lost-halls-void-farmer/index.mjs' as string)).default;

  // Production bundles every plugin on its own (build-prod.mjs / PluginManager
  // hot reload), so the plugin carries a private copy of each module it imports
  // — the shape of the old Self/BridgeSelf bug. Bundle Auto Ability the same way.
  const out = await build({
    entryPoints: [join(REPO_CLIENT, 'plugins', 'auto-ability.ts')],
    bundle: true, write: false, platform: 'node', target: 'node20', format: 'esm',
    external: ['koffi', 'sharp', 'electron'], logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  bundledAutoAbility = { code, register: mod.register };
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_789_000_000_000); });
afterEach(() => {
  // As ScriptHost / PluginManager would: stop scripts, disable plugins, drop the connection.
  for (const script of running.scripts.splice(0)) script.onStop();
  for (const plugin of running.plugins.splice(0)) plugin.enabled = false;
  clientRef.current = undefined;
  setDllFeatureSender(null);
  vi.useRealTimers();
});

// ─── Harness ─────────────────────────────────────────────────────────────────
type Stats = Record<number, number>;
const entity = (objectType: number, objectId: number, x: number, y: number, stats: Stats = {}) => ({
  objectType, status: { objectId, position: { x, y },
    data: Object.entries(stats).map(([id, value]) => ({ id: Number(id), value, stackCount: 0 })) },
});
const status = (objectId: number, x: number, y: number, stats: Stats = {}) => entity(0, objectId, x, y, stats).status;
function floor(type: number, x0: number, x1: number, y0: number, y1: number) {
  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ x, y, type });
  return tiles;
}
const mapInfo = (name: string, allowPlayerTeleport: boolean) => ({
  width: 64, height: 64, name, displayName: name, realmName: '', fp: 1, background: 0, difficulty: 0,
  allowPlayerTeleport, noSave: false, showDisplays: true, maxPlayers: 85, gameOpenedTime: 0,
  serverVersion: '7.0.0.2.0', viewDistance: 25,
});

/** A fresh game connection entering `map`. */
function session(map: string, allowPlayerTeleport = false) {
  worldState.clear();
  recorded.dll = [];
  recorded.activity = [];
  setDllFeatureSender((key, value) => { recorded.dll.push([key, value]); });
  const conn = new ClientConnection(proxy, Object.assign(new EventEmitter(), { setNoDelay() {} }) as any);
  // Stand-ins for the TCP socket to the game server and its RC4 stream: bytes
  // stay plaintext, so what the client sent can be read back by packet name.
  const sent: Packet[] = [];
  Object.assign(conn as any, {
    serverSendCipher: { cipher() {} },
    serverSocket: { destroyed: false, write: (b: Buffer) => { sent.push(factory.createFromBytes(Buffer.from(b))); return true; } },
  });
  clientRef.current = conn;
  let tickId = 0;
  const s = {
    conn, sent,
    server: (name: string, data: Record<string, unknown>) => proxy.fireServerPacket(conn, wire(name, data)),
    frame: (hex: string) => proxy.fireServerPacket(conn, factory.createFromBytes(Buffer.from(hex, 'hex'))),
    update: (tiles: unknown[], newObjs: unknown[]) =>
      s.server('UPDATE', { position: { x: 0, y: 0 }, levelType: 0, tiles, newObjs, drops: [] }),
    newTick: (statuses: unknown[]) =>
      s.server('NEWTICK', { tickId: ++tickId, tickTime: 200, serverRealTimeMs: 0, serverLastRttMs: 0, statuses }),
    lastDll: (key: string) => [...recorded.dll].reverse().find(([k]) => k === key)?.[1],
    lastStatus: () => recorded.activity.at(-1),
    sentNames: () => sent.map((p) => p.name),
  };
  // The game client's first PONG calibrates game time (StateManager.onPong).
  // Until then client.time is epoch ms, which no int32 time field can carry.
  proxy.fireClientPacket(conn, wire('PONG', { serial: 1, time: 5000 }));
  s.server('MAPINFO', mapInfo(map, allowPlayerTeleport));
  s.server('CREATESUCCESS', { objectId: ME, charId: 1, stats: '' });
  return s;
}

function startFarmer<T extends { onStart(): void; onStop(): void }>(script: T): T {
  running.scripts.push(script);
  script.onStart();
  return script;
}

const archer = (x: number, y: number) => entity(TYPE.ARCHER, ME, x, y, {
  [StatType.MaxHP]: 150, [StatType.HP]: 150, [StatType.MaxMP]: 150, [StatType.MP]: 150,
  [StatType.Inventory1]: TYPE.MAGIC_QUIVER,
});
const oryx3 = (x: number, y: number, animation = 0) => entity(TYPE.ORYX_3, BOSS, x, y, {
  [StatType.MaxHP]: 562500, [StatType.HP]: 562500, [TOMATO_ANIMATION_STAT_WIRE]: animation,
});

/** Oryx's Sanctuary, an open 20x12 floor, us at (5.5, 5.5) and Oryx 3 four tiles east. */
function sanctuary(animation = 0) {
  const s = session("Oryx's Sanctuary");
  s.update(floor(TYPE.O3_FLOOR, 0, 19, 0, 11), [archer(5.5, 5.5), oryx3(9.5, 5.5, animation)]);
  const farmer = startFarmer(new Farmer());
  return { ...s, farmer };
}

// ─── One test per restored capability ────────────────────────────────────────
describe('Oryx runner on the real SDK', () => {
  it('isGuarding: holds fire through a real Oryx 3 guard animation, then fights again', () => {
    const s = sanctuary();
    s.farmer.onLoop();
    expect(s.lastStatus()).toBe('Sanctuary: fighting Oryx the Mad God');
    expect(s.lastDll('scriptCombatTargetId')).toBe(BOSS);
    expect(s.lastDll('autoFireEnabled')).toBe(true);

    s.newTick([status(BOSS, 9.5, 5.5, { [TOMATO_ANIMATION_STAT_WIRE]: ORYX_GUARD_ANIMATION })]);
    s.farmer.onLoop();
    expect(RealmEngine.enemies.getById(BOSS)?.isGuarding).toBe(true);
    expect(s.lastStatus()).toBe('Sanctuary: Oryx the Mad God: guard — holding weapons and abilities');
    expect(s.lastDll('autoFireEnabled')).toBe(false);
    expect(s.lastDll('scriptCombatTargetId')).toBe(0);

    s.newTick([status(BOSS, 9.5, 5.5, { [TOMATO_ANIMATION_STAT_WIRE]: 0 })]);
    s.farmer.onLoop();
    expect(s.lastStatus()).toBe('Sanctuary: fighting Oryx the Mad God');
    expect(s.lastDll('autoFireEnabled')).toBe(true);
  });

  it('pauseAutomaticAbility: the separately bundled Auto Ability plugin does not cast during a guard', () => {
    const s = session("Oryx's Sanctuary");
    const plugin = new PluginContext(proxy, 'auto-ability', 'auto-ability.ts', gameData, worldState);
    running.plugins.push(plugin);
    bundledAutoAbility.register(plugin);
    s.server('MAPINFO', mapInfo("Oryx's Sanctuary", false));   // the plugin's safe-zone check sees this one
    s.update(floor(TYPE.O3_FLOOR, 0, 19, 0, 11),
      [archer(5.5, 5.5), oryx3(9.5, 5.5, ORYX_GUARD_ANIMATION)]);
    const farmer = startFarmer(new Farmer());
    const t0 = Date.now();
    const tick = (at: number) => {
      vi.setSystemTime(t0 + at);
      s.newTick([status(BOSS, 9.5, 5.5, { [TOMATO_ANIMATION_STAT_WIRE]: ORYX_GUARD_ANIMATION })]);
    };
    const casts = () => s.sentNames().filter((n) => n === 'USEITEM').length;

    farmer.onLoop();                     // guard observed -> 1 s pause lease
    tick(100);
    expect(casts()).toBe(0);
    vi.setSystemTime(t0 + 600);
    farmer.onLoop();                     // still guarding -> lease renewed
    tick(1200);                          // past the first lease, inside the renewal
    expect(casts()).toBe(0);
    tick(1700);                          // the script stopped renewing: the lease lapses
    expect(casts()).toBe(1);
    // It works across bundles because the plugin's private copy of the lease
    // module and the host's share one globalThis bus.
    expect(bundledAutoAbility.code).toContain('__realmAutomaticAbilityPauses_v1');
  });

  it('blocksMovement: walks around a real OccupySquare wall instead of shooting through it', () => {
    const s = session("Oryx's Sanctuary");
    const wall = Array.from({ length: 11 }, (_, i) => entity(TYPE.BRICK_WALL, 3000 + i, i + 1.5, 3.5));
    s.update(floor(TYPE.O3_FLOOR, 0, 11, 0, 11), [archer(10.5, 0.5), oryx3(10.5, 6.5), ...wall]);
    const farmer = startFarmer(new Farmer());
    farmer.onLoop();

    expect(RealmEngine.world.objects.getById(3000)?.blocksMovement).toBe(true);
    expect(s.lastStatus()).toBe('Sanctuary: approaching Oryx the Mad God');
    expect(s.lastDll('walkTargetActive')).toBe(true);
    // The wall spans x 1..11 at y 3; the only way through is its open end at x 0.
    expect(s.lastDll('walkTargetX')).toBeLessThan(10.5);
    expect(s.lastDll('walkTargetY')).toBeLessThan(3.5);
  });

  it('isSnapshotFresh: keeps fighting a stationary boss that NEWTICK deltas stop repeating', () => {
    const s = sanctuary();
    s.farmer.onLoop();
    expect(s.lastStatus()).toBe('Sanctuary: fighting Oryx the Mad God');

    // Five seconds of ticks that only move us: the boss is standing still, so
    // the server never mentions it again. It is still there.
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(1000);
      s.newTick([status(ME, 5.5, 5.5)]);
    }
    s.farmer.onLoop();
    expect(RealmEngine.enemies.getAll().map((e) => e.objectId)).toEqual([BOSS]);
    expect(s.lastStatus()).toBe('Sanctuary: fighting Oryx the Mad God');
    expect(s.lastDll('autoFireEnabled')).toBe(true);
  });

  it('sourceObjectId: a Celestial cue spoken by the boss holds fire; the same words from anyone else do not', () => {
    const s = sanctuary();
    s.farmer.onLoop();
    const say = (objectId: number, name: string) => s.server('TEXT', {
      name, objectId, numStars: -1, bubbleTime: 5, recipient: '',
      text: 'FALL BEFORE MY CELESTIAL STRENGTH!', cleanText: 'FALL BEFORE MY CELESTIAL STRENGTH!',
      isSupporter: false, starBg: 0,
    });

    say(4242, 'Mimic');                 // a player quoting the boss
    say(-1, '#Oryx the Mad God');       // no source object
    s.farmer.onLoop();
    expect(s.lastStatus()).toBe('Sanctuary: fighting Oryx the Mad God');

    say(BOSS, '#Oryx the Mad God');     // the boss itself
    s.farmer.onLoop();
    expect(s.lastStatus()).toBe('Sanctuary: Oryx 3: Celestial — Unified Dodge controls movement');
    expect(s.lastDll('autoFireEnabled')).toBe(false);
  });
});

describe('Lost Halls void farmer on the real SDK', () => {
  it('loads through its real module graph and routes around real Lost Halls walls to the Defender', () => {
    const s = session('Lost Halls');
    const defender = entity(TYPE.DEFENDER, BOSS, 12.5, 9.5, { [StatType.MaxHP]: 54375, [StatType.HP]: 54375 });
    const wall = Array.from({ length: 15 }, (_, i) => entity(TYPE.LH_WALL, 3000 + i, i + 1.5, 5.5));
    s.update(floor(TYPE.LH_FLOOR, 0, 15, 0, 15), [archer(12.5, 1.5), defender, ...wall]);
    const farmer = startFarmer(new LostHallsVoidFarmer());
    farmer.onLoop();

    expect(farmer.halls.stage).toBe('halls');
    expect(s.lastStatus()).toBe('Lost Halls → Void: approaching Marble Defender');
    expect(s.lastDll('walkTargetX')).toBeLessThan(12.5);
    expect(s.lastDll('walkTargetY')).toBeLessThan(5.5);
  });
});

// ─── The merged farmer keeps both sides' intent ──────────────────────────────
describe('Realm Farmer beacon teleport on the real SDK', () => {
  it('reports the server-stated cooldown from the real refusal frame, unless an encounter owns movement', () => {
    const s = session('Realm of the Mad God', true);
    s.update(floor(TYPE.O3_FLOOR, 0, 3, 0, 3), [archer(1.5, 1.5)]);
    const farmer = startFarmer(new Farmer());
    expect(RealmEngine.walking.teleportToBeacon(275515)).toBe(true);
    vi.advanceTimersByTime(59);
    s.frame(TELEPORT_REFUSAL_HEX);
    const quest = { objectId: 7, position: { x: 200, y: 200 } };

    farmer.bossEncounter = { objectId: 7 };           // local: an encounter owns movement
    expect(farmer.tryBeaconTeleport(Date.now(), quest)).toBe(false);
    expect(farmer.beaconSkipReason).toBe('encounter/loot owns movement');

    farmer.bossEncounter = null;                      // session: the server's stated wait
    expect(farmer.tryBeaconTeleport(Date.now(), quest)).toBe(false);
    expect(farmer.beaconSkipReason).toBe('server teleport cooldown, 49s left');
    expect(s.sentNames().filter((n) => n === 'TELEPORT')).toHaveLength(1);
  });
});
