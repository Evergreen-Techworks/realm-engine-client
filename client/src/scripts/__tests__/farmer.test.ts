import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loot } from '@realmengine/sdk';
import { install as installLootBridge } from '../bridge/loot/index.js';
import { StatType } from '../../constants/StatType.js';
const runnerSource = readFileSync(new URL('../../../script-packages/farmer/oryx-runner.mjs', import.meta.url), 'utf8')
  .replace('export default class OryxRunner', 'return class OryxRunner');
const OryxRunner = new Function(runnerSource)();
const source = readFileSync(new URL('../../../script-packages/farmer/index.mjs', import.meta.url), 'utf8')
  .replace("import { RealmEngine } from '@realmengine/sdk';", '')
  .replace("import OryxRunner from './oryx-runner.mjs';", '')
  .replace('export default class Farmer', 'return class Farmer');
function fixture() {
  let enemies: any[] = [];
  const quest = { objectId: 10, name: 'Boss', position: { x: 6, y: 0 }, hp: 100, maxHp: 100, isTargetable: true };
  const sdk: any = {
    self: { getHP: () => 100, getX: () => 0, getY: () => 0, getLevel: () => 19, distanceTo: (p: any) => Math.hypot(p.x, p.y) },
    enemies: { getAll: () => enemies },
    dodge: { clearWaypoint: vi.fn(), lockEnemy: vi.fn(), clearEnemyLock: vi.fn(), navigateToPosition: vi.fn() },
    combat: { setAutoFire: vi.fn(), aimAt: vi.fn(), stopAiming: vi.fn() },
    world: { getSize: () => ({ width: 1000, height: 1000 }), getName: () => 'Realm', isRealm: () => true, isNexus: () => false,
      objects: { getAll: () => [], getById: () => quest, getQuestObject: () => quest, getBeacons: () => [] } },
    loot: { getNearbyBags: vi.fn(() => []), getBags: () => [], isUsefulStatPot: () => true,
      isUT: () => false, isST: () => false, isEquipmentUpgrade: () => false, useFromBag: vi.fn(() => true) },
    inventory: { getAll: () => [], useItem: vi.fn() },
    walking: { nexus: vi.fn(), canTeleport: () => true, teleportToBeacon: vi.fn(() => true) },
    ui: { status: vi.fn() }, log: { info: vi.fn() },
  };
  const Farmer = new Function('RealmEngine', 'OryxRunner', source)(sdk, OryxRunner);
  const farmer = new Farmer(); farmer.mapName = 'Realm';
  return { farmer, sdk, quest, setEnemies: (value: any[]) => { enemies = value; } };
}
afterEach(() => vi.useRealTimers());
it.each(['invulnerable', 'missing'])('keeps event boss priority through brief %s phases instead of chasing unrelated adds', (phase) => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const fixtureState = fixture();
  fixtureState.sdk.self.getLevel = () => 20;
  Object.assign(fixtureState.quest, { isEventBoss: true });
  fixtureState.sdk.world.objects.getAll = () => [fixtureState.quest];
  const add = { objectId: 20, name: 'Unrelated mob', position: { x: 2, y: 0 }, hp: 100, maxHp: 100, isTargetable: true };
  fixtureState.setEnemies([fixtureState.quest, add]);
  fixtureState.farmer.onLoop();
  expect(fixtureState.farmer.lockId).toBe(10);
  fixtureState.quest.isTargetable = false;
  fixtureState.setEnemies(phase === 'missing' ? [add] : [fixtureState.quest, add]);
  vi.setSystemTime(10100); fixtureState.farmer.onLoop();
  expect(fixtureState.sdk.dodge.lockEnemy).not.toHaveBeenCalledWith(20);
  expect(fixtureState.farmer.lockId).toBe(10);
  expect(fixtureState.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(false);
  fixtureState.quest.isTargetable = true;
  fixtureState.setEnemies([fixtureState.quest, add]);
  vi.setSystemTime(10200); fixtureState.farmer.onLoop();
  expect(fixtureState.farmer.lockId).toBe(10);
  expect(fixtureState.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
});
it('ends event transition grace after three seconds and still releases confirmed death immediately', () => {
  const fixtureState = fixture();
  Object.assign(fixtureState.quest, { isEventBoss: true });
  const add = { objectId: 20, name: 'Unrelated mob', position: { x: 2, y: 0 }, hp: 100, maxHp: 100, isTargetable: true };
  fixtureState.setEnemies([fixtureState.quest, add]);
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 10000);
  fixtureState.quest.isTargetable = false;
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 10100);
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 13099);
  expect(fixtureState.farmer.lockId).toBe(10);
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 13100);
  expect(fixtureState.farmer.lockId).toBe(20);
  fixtureState.quest.isTargetable = true;
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 13200);
  expect(fixtureState.farmer.lockId).toBe(10);
  fixtureState.quest.isTargetable = false;
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 13300);
  fixtureState.quest.hp = 0;
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 13400);
  expect(fixtureState.farmer.lockId).toBe(0);
  expect(fixtureState.farmer.bossEncounter).toBeNull();
});
it('discards event transition grace on map reset and leaves first-seen marker add handling unchanged', () => {
  const fixtureState = fixture();
  Object.assign(fixtureState.quest, { isEventBoss: true });
  const add = { objectId: 20, name: 'Unrelated mob', position: { x: 2, y: 0 }, hp: 100, maxHp: 100, isTargetable: true };
  fixtureState.setEnemies([fixtureState.quest, add]);
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 10000);
  fixtureState.quest.isTargetable = false;
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 10100);
  fixtureState.farmer.resetMap('Other');
  expect(fixtureState.farmer.bossEncounter).toBeNull();
  fixtureState.setEnemies([add]);
  fixtureState.farmer.handleBossEncounter(fixtureState.quest, 10200);
  expect(fixtureState.farmer.lockId).toBe(20);
});
// Bags built by the real loot bridge from an UPDATE, so their rarity comes from the
// bridge's BAG_RARITY table (after #77: only Loot Bag 6 and its Boost are 'white').
const bridgeBags = (() => {
  const hooks = new Map<string, any>();
  const entities = new Map<number, any>();
  installLootBridge({ proxy: { hookPacket: (name: string, hook: any) => hooks.set(name, hook) },
    worldState: { getEntity: (id: number) => entities.get(id) },
    gameData: { getAllObjects: () => [], getObject: () => undefined },
    clientRef: { current: undefined } } as any);
  return {
    drop(objectType: number, objectId: number, position: { x: number; y: number }, itemTypes: number[]) {
      const data = itemTypes.map((value, slot) => ({ id: StatType.Inventory0 + slot, value }));
      entities.set(objectId, { objectId, objectType, pos: position,
        stats: Object.fromEntries(data.map((d) => [String(d.id), d.value])) });
      hooks.get('UPDATE')({}, { isDefined: true, data: { newObjs: [{ objectType, status: { objectId, position, data } }] } });
      return loot.getBags().find((bag) => bag.objectId === objectId)!;
    },
    pickUp(objectId: number) {
      entities.delete(objectId);
      hooks.get('UPDATE')({}, { isDefined: true, data: { drops: [objectId] } });
    },
    reset() { entities.clear(); hooks.get('MAPINFO')(); },
  };
})();
const LOOT_BAG_6 = 0x050c;   // white
const LOOT_BAG_7 = 0x050e;   // gold, labelled 'blue' by the bridge since #77
describe('farmer control ownership', () => {
  it('engages at weapon-like range when there is no useful loot', () => {
    const f = fixture(); f.setEnemies([f.quest]); f.farmer.onLoop();
    expect(f.sdk.dodge.lockEnemy).toHaveBeenCalledWith(10);
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
    expect(f.sdk.loot.getNearbyBags).toHaveBeenCalled();
    f.quest.position.x = 10; f.quest.isTargetable = false;
    f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(0); // invulnerable boss waits for adds
    expect(f.sdk.dodge.clearEnemyLock).toHaveBeenCalled();
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
  });
  // User decision 2026-09-14: during a boss encounter only white bags interrupt. Every
  // other bag waits, with the boss lock kept, until the boss dies or the encounter ends.
  const bossFightWithBridgeLoot = () => {
    bridgeBags.reset();
    const f = fixture();
    f.sdk.loot.getNearbyBags = vi.fn((radius: number) => loot.getNearbyBags(radius));
    f.sdk.loot.getBags = () => loot.getBags();
    f.setEnemies([f.quest]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    return f;
  };

  it('keeps fighting the boss when a gold bag drops: no detour, lock kept', () => {
    const f = bossFightWithBridgeLoot();
    const bag = bridgeBags.drop(LOOT_BAG_7, 20, { x: 2, y: 0 }, [2592]);
    expect(bag.rarity).toBe('blue');
    f.farmer.onLoop(); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    expect(f.farmer.lootBagId).toBe(0);
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalledWith(bag.position);
    expect(f.sdk.dodge.clearEnemyLock).not.toHaveBeenCalled();
    expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
  });

  it('lets a white bag interrupt the boss fight and resumes combat once it is gone', () => {
    const f = bossFightWithBridgeLoot();
    const bag = bridgeBags.drop(LOOT_BAG_6, 21, { x: 2, y: 0 }, [2592]);
    expect(bag.rarity).toBe('white');
    f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(0);
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
    const clears = f.sdk.dodge.clearWaypoint.mock.calls.length;
    f.farmer.onLoop();
    expect(f.sdk.dodge.clearWaypoint).toHaveBeenCalledTimes(clears);
    bridgeBags.pickUp(21);
    f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
  });

  it.each(['packet', 'hp'])('collects a deferred bag after %s death evidence with no corpse in Enemies', (evidence) => {
    const f = bossFightWithBridgeLoot();
    const bag = bridgeBags.drop(LOOT_BAG_7, 22, { x: 2, y: 0 }, [2592]);
    f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalledWith(bag.position);
    if (evidence === 'packet') f.sdk.world.objects.isDead = (id: number) => id === f.quest.objectId;
    else f.quest.hp = 0;
    f.setEnemies([]);
    f.farmer.onLoop(); f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
  });

  it('releases a remembered quest immediately when the current world snapshot confirms zero HP', () => {
    const fixtureState = fixture();
    fixtureState.sdk.world.tiles = { getAll: () => [] };
    fixtureState.setEnemies([fixtureState.quest]); fixtureState.farmer.onLoop();
    expect(fixtureState.farmer.lockId).toBe(10);
    fixtureState.sdk.world.objects.getById = () => ({ ...fixtureState.quest, hp: 0 });
    fixtureState.sdk.world.objects.getQuestObject = () => null;
    fixtureState.setEnemies([]);
    fixtureState.sdk.dodge.navigateToPosition.mockClear();
    fixtureState.farmer.onLoop();
    expect(fixtureState.farmer.questGoal).toBeNull();
    expect(fixtureState.farmer.bossEncounter).toBeNull();
    expect(fixtureState.farmer.lockId).toBe(0);
    expect(fixtureState.sdk.dodge.navigateToPosition).not.toHaveBeenCalledWith(fixtureState.quest.position);
  });

  it('collects a deferred bag once the encounter ends without a kill', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = bossFightWithBridgeLoot();
    const bag = bridgeBags.drop(LOOT_BAG_7, 23, { x: 2, y: 0 }, [2592]);
    f.setEnemies([]);                                 // boss gone from view, not known dead
    f.farmer.onLoop();
    expect(f.farmer.bossEncounter).not.toBeNull();
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalledWith(bag.position);
    vi.setSystemTime(13500); f.farmer.onLoop();       // quest encounter grace (3 s) lapses
    expect(f.farmer.bossEncounter).toBeNull();
    f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
  });
  it('uses the actual second bag slot when the first has emptied', () => {
    const f = fixture();
    const bag = { objectId: 20, rarity: 'blue', position: { x: 0, y: 0 }, items: [{ slotIndex: 1, objectType: 2592 }] };
    f.sdk.loot.getBags = () => [bag]; f.farmer.lootBagId = 20; f.farmer.lootArrivedAt = 1;
    f.farmer.handleLoot(10000);
    expect(f.sdk.loot.useFromBag).toHaveBeenCalledWith(bag, 1);
    f.sdk.loot.useFromBag.mockReturnValue(false);
    expect(f.farmer.handleLoot(11400)).toBe(true); // shared sender still settling
    expect(f.farmer.lootBagId).toBe(20);
  });
  it('pauses navigation for teleport and retries after failure instead of disabling the session', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = fixture(); f.quest.position.x = 100;
    f.sdk.world.objects.getBeacons = () => [{ objectId: 30, name: 'Teleport Beacon', position: { x: 90, y: 0 } }];
    f.farmer.onLoop();
    expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(30);
    f.farmer.onLoop(); expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
    vi.setSystemTime(14000); f.farmer.verifyBeaconTeleport(14000);
    expect(f.farmer.tryBeaconTeleport(14000, f.quest)).toBe(false);
    vi.setSystemTime(45000);
    expect(f.farmer.tryBeaconTeleport(45000, f.quest)).toBe(true);
  });
});

describe('farmer beacon selection and level 20 relocation', () => {
  it('uses the biome beacon closest to the destination, excluding guardian objects', () => {
    const f = fixture();
    const beacon = (objectId: number, name: string, x: number, objectClass = 'Beacon') =>
      ({ objectId, name, objectClass, position: { x, y: 0 } });
    f.sdk.world.objects.getBeacons = () => [
      beacon(1, 'Forest Beacon (Novice)', 5),
      beacon(2, 'Dead Church Beacon (Adept)', 90),
      beacon(3, 'Beacon Guardian', 100, 'Character'),
      beacon(4, 'Inactive Beacon', 99),
      beacon(5, 'Captured Beacon', 99, 'Character'),
    ];
    expect(f.farmer.chooseBeacon({ x: 100, y: 0 }).objectId).toBe(2);
    f.farmer.beaconRetryAfter.set(2, Date.now() + 30000);
    expect(f.farmer.chooseBeacon({ x: 100, y: 0 }).objectId).toBe(1);
  });

  it('interrupts the leveling quest at 20, teleports inward, then resumes quests once', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = fixture(); let level = 19; let position = { x: 0, y: 0 };
    f.sdk.self.getLevel = () => level;
    f.sdk.self.getX = () => position.x; f.sdk.self.getY = () => position.y;
    f.sdk.self.distanceTo = (p: any) => Math.hypot(p.x - position.x, p.y - position.y);
    f.setEnemies([f.quest]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    const central = { objectId: 40, name: 'Central Beacon (Veteran)', objectClass: 'Beacon', position: { x: 480, y: 500 } };
    f.sdk.world.objects.getBeacons = () => [central];
    level = 20; f.farmer.onLoop();
    expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(40);
    expect(f.farmer.lockId).toBe(0);
    expect(f.farmer.questGoal).toBeNull();
    position = central.position; vi.setSystemTime(14000); f.farmer.onLoop();
    expect(f.farmer.centerTripDone).toBe(true);
    expect(f.farmer.beaconRetryAfter.size).toBe(0);
    f.sdk.walking.teleportToBeacon.mockClear();
    position = { x: 0, y: 0 }; f.farmer.onLoop();
    // No purple marker: remain in event search instead of returning to the old boss.
    expect(f.farmer.bossEncounter).toBeNull();
    f.farmer.resetMap('New Realm');
    expect(f.farmer.centerTripDone).toBe(false);
  });

  it('uses full map dimensions and walks inward when teleport is unavailable', () => {
    const f = fixture(); f.sdk.self.getLevel = () => 20;
    f.sdk.walking.canTeleport = () => false;
    f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 500, y: 500 });
    expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
    expect(f.farmer.centerTripDone).toBe(false);
  });

  it('keeps useful loot ahead of the center trip and waits for missing dimensions', () => {
    const f = fixture(); f.sdk.self.getLevel = () => 20;
    f.sdk.loot.getNearbyBags.mockReturnValue([{ objectId: 20, rarity: 'blue', position: { x: 2, y: 0 }, items: [{ objectType: 2592, slotIndex: 0 }] }]);
    f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 2, y: 0 });
    expect(f.farmer.centerGoal).toBeNull();
    f.sdk.loot.getNearbyBags.mockReturnValue([]);
    f.sdk.world.getSize = () => ({ width: 0, height: 0 });
    f.sdk.dodge.navigateToPosition.mockClear(); f.farmer.onLoop();
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
    expect(f.farmer.centerTripDone).toBe(false);
  });
});

describe('farmer realm goal picker', () => {
  // A 9x9 explored floor. Its bounds centre, the goal the picker aims for, is the
  // middle tile (4, 4) at (4.5, 4.5). Tiles are shaped like the bridge's MapTile.
  const floor = (size = 9) => Array.from({ length: size * size }, (_, i) => ({
    position: { x: (i % size) + 0.5, y: Math.floor(i / size) + 0.5 },
    isBlocking: false, isOccupied: false, damaging: false, speedMultiplier: 1,
  }));
  const at = (tiles: any[], x: number, y: number) =>
    tiles.find((t) => t.position.x === x + 0.5 && t.position.y === y + 0.5);
  const goalFor = (tiles: any[], objects: any[] = []) => {
    const f = fixture();
    f.sdk.world.tiles = { getAll: () => tiles };
    f.sdk.world.objects.getAll = () => objects;
    return f.farmer.computeRealmGoal(19);
  };
  const isCentre = (p: any) => p?.x === 4.5 && p?.y === 4.5;
  const oneStepFromCentre = (p: any) => Math.hypot(p.x - 4.5, p.y - 4.5) <= Math.SQRT2;

  it('still chooses a normal floor tile at the centre', () => {
    expect(goalFor(floor())).toEqual({ x: 4.5, y: 4.5 });
  });

  it('never chooses a tile holding a tree or other square-blocking object', () => {
    const tiles = floor();
    at(tiles, 4, 4).isOccupied = true;
    const tree = { objectId: 7, name: 'Tree', blocksMovement: true, position: { x: 4.5, y: 4.5 } };
    const goal = goalFor(tiles, [tree]);
    expect(isCentre(goal)).toBe(false);
    expect(oneStepFromCentre(goal)).toBe(true);
  });

  it('never chooses deep water that is NoWalk even though it carries a Speed value', () => {
    const tiles = floor();
    Object.assign(at(tiles, 4, 4), { name: 'Red Earth Water Deep', isBlocking: true, speedMultiplier: 0.75 });
    const goal = goalFor(tiles);
    expect(isCentre(goal)).toBe(false);
    expect(oneStepFromCentre(goal)).toBe(true);
  });

  it('never chooses an open tile walled in on all four sides', () => {
    const tiles = floor();
    at(tiles, 3, 4).isBlocking = true;            // water
    at(tiles, 5, 4).isBlocking = true;            // water
    at(tiles, 4, 3).damaging = true;              // lava, hard-blocked under safe-walk
    at(tiles, 4, 5).isOccupied = true;            // a rock
    const rock = { objectId: 8, name: 'Rock', blocksMovement: true, position: { x: 4.5, y: 5.5 } };
    const goal = goalFor(tiles, [rock]);
    expect(isCentre(goal)).toBe(false);
    expect(oneStepFromCentre(goal)).toBe(true);
    // One open side is enough: the tile is reachable again.
    at(tiles, 4, 3).damaging = false;
    expect(goalFor(tiles, [rock])).toEqual({ x: 4.5, y: 4.5 });
  });

  it('keeps a tile that only a player, enemy or bag stands on', () => {
    // isOccupied counts every tracked entity, you included. Rejecting on it alone
    // would push the goal off the tile the player just arrived on.
    const tiles = floor();
    at(tiles, 4, 4).isOccupied = true;
    const self = { objectId: 1, name: 'Wizard', blocksMovement: false, position: { x: 4.4, y: 4.6 } };
    expect(goalFor(tiles, [self])).toEqual({ x: 4.5, y: 4.5 });
  });
});


describe('Realm Farmer Oryx integration', () => {
  it.each(["Oryx's Castle", 'Oryx’s Castle', 'Oryx Castle'])('runs %s instead of nexusing', (map) => {
    const f = fixture();
    f.sdk.world.getName = () => map;
    f.sdk.world.isRealm = () => false;
    f.farmer.lockId = 10;
    f.farmer.onLoop();
    expect(f.farmer.oryx.stage).toBe('castle');
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    expect(f.sdk.combat.stopAiming).toHaveBeenCalled();
    expect(f.sdk.loot.getNearbyBags).not.toHaveBeenCalled();
    f.sdk.world.getName = () => 'Nexus'; f.sdk.world.isNexus = () => true;
    f.sdk.world.objects.getOpenPortals = () => [];
    f.farmer.onLoop();
    expect(f.farmer.oryx.stage).toBeNull();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenCalledWith({ x: 0, y: -96 });
  });
  it('continues ordinary dungeon behavior outside the castle', () => {
    const f = fixture(); f.sdk.world.getName = () => 'Pirate Cave';
    f.sdk.world.isRealm = () => false; f.farmer.onLoop();
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    expect(f.sdk.loot.getNearbyBags).toHaveBeenCalled();
  });
});

it('cancels stale Nexus waypoints, waits for spawn, and keeps portal travel free of combat retargeting', () => {
  const f = fixture(); let hp = 0;
  f.sdk.self.getHP = () => hp;
  f.sdk.world.getName = () => 'Nexus'; f.sdk.world.isNexus = () => true;
  f.sdk.world.objects.getOpenPortals = () => [];
  f.setEnemies([f.quest]); f.farmer.onLoop();
  expect(f.sdk.dodge.clearWaypoint).toHaveBeenCalled();
  expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
  hp = 100; f.farmer.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 0, y: -96 });
  const clears = f.sdk.dodge.clearWaypoint.mock.calls.length;
  f.farmer.onLoop();
  expect(f.sdk.dodge.clearWaypoint).toHaveBeenCalledTimes(clears);
  expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalled();
  expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(false);
});

it('anchors add clearing to the quest boss and switches back on vulnerability', () => {
  const f = fixture(); f.quest.isTargetable = false;
  const add = { ...f.quest, objectId: 11, name: 'Add', isTargetable: true, position: { x: 7, y: 0 } };
  const far = { ...add, objectId: 12, position: { x: -7, y: 0 } };
  f.setEnemies([f.quest, far, add]); f.farmer.onLoop();
  expect(f.farmer.lockId).toBe(11);
  f.quest.isTargetable = true; f.farmer.onLoop(); expect(f.farmer.lockId).toBe(10);
  f.setEnemies([far]); f.farmer.onLoop();
  expect(f.farmer.lockId).toBe(0); // hidden boss, no eligible adds near its center
  expect(f.farmer.bossEncounter.objectId).toBe(10);
  f.sdk.self.getX = () => 30;
  f.sdk.self.distanceTo = (p: any) => Math.hypot(p.x - 30, p.y);
  f.farmer.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 14, y: 0 });
});

it('at level 20 prioritizes purple/white markers over the ordinary quest and visits the next event after death', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const event = { ...f.quest, objectId: 40, isEventBoss: true, name: 'Event', position: { x: 100, y: 0 } };
  const next = { ...event, objectId: 41, name: 'White boss', minimapColor: 0xffffff, position: { x: 200, y: 0 } };
  const mini = { ...f.quest, isEventBoss: false, maxHp: 300000 };
  let objects = [mini, next, event];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.setEnemies([mini]); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(40);
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(event.position);
  expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalled();
  expect(f.farmer.centerGoal).toBeNull(); // event travel immediately overrides center fallback
  event.hp = 0; vi.setSystemTime(11100); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(41);
  expect(f.farmer.finishedEvents.has(40)).toBe(true);
  f.farmer.resetMap('Other'); expect(f.farmer.finishedEvents.size).toBe(0);
});

it('event search keeps loot priority and handles markers without a damageable boss body', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const marker = { objectId: 40, isEventBoss: true, name: 'Event controller', position: { x: 6, y: 0 }, hp: 0, maxHp: 0 };
  f.sdk.world.objects.getAll = () => [marker];
  f.sdk.world.objects.getById = () => marker;
  const add = { ...f.quest, objectId: 50 };
  f.setEnemies([add]); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(40);
  expect(f.farmer.lockId).toBe(50);
  const bag = { objectId: 60, rarity: 'white', position: { x: 2, y: 0 }, items: [{ objectType: 1 }] };
  f.sdk.loot.getNearbyBags.mockReturnValue([bag]); f.farmer.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
  expect(f.farmer.lockId).toBe(0);
});

it('teleports to the fresh living player closest to the boss and falls back after an ignored teleport', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.quest.position.x = 100;
  f.sdk.players = { getAll: () => [
    { objectId: 60, name: 'NearBoss', hp: 100, lastUpdate: Date.now(), position: { x: 95, y: 0 } },
    { objectId: 61, name: 'Stale', hp: 100, lastUpdate: 1, position: { x: 100, y: 0 } },
    { objectId: 62, name: 'Dead', hp: 0, lastUpdate: Date.now(), position: { x: 100, y: 0 } },
  ] };
  f.sdk.walking.teleportToPlayer = vi.fn(() => true);
  f.sdk.world.objects.getBeacons = () => [{ objectId: 30, objectClass: 'Beacon', name: 'Beacon', position: { x: 80, y: 0 } }];
  expect(f.farmer.tryBeaconTeleport(10000, f.quest)).toBe(true);
  expect(f.sdk.walking.teleportToPlayer).toHaveBeenCalledWith('NearBoss');
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  vi.setSystemTime(14000); f.farmer.verifyBeaconTeleport(14000);
  vi.setSystemTime(16000); f.farmer.tryBeaconTeleport(16000, f.quest);
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(30);
});

it('confirms a teleport to a moving player using their updated position', () => {
  const f = fixture();
  f.sdk.self.getX = () => 110;
  f.sdk.self.distanceTo = (p: any) => Math.abs(p.x - 110);
  f.sdk.players = { getAll: () => [{ objectId: 60, hp: 100, lastUpdate: 14000, position: { x: 110, y: 0 } }] };
  f.farmer.beaconPending = { objectId: 60, teleportKind: 'player', name: 'Moving', x: 0, y: 0, position: { x: 90, y: 0 }, at: 10000 };
  f.farmer.verifyBeaconTeleport(14000);
  expect(f.farmer.beaconPending).toBeNull();
  expect(f.farmer.beaconRetryAfter.has(60)).toBe(false);
});

it('switches a distant dead event even after its object drops and while teleport confirmation is pending', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const first = { ...f.quest, objectId: 40, isEventBoss: true, position: { x: 100, y: 0 } };
  const next = { ...first, objectId: 41, position: { x: 200, y: 0 } };
  let dead = false;
  f.sdk.world.objects.getAll = () => [next];
  f.sdk.world.objects.getById = () => null;
  f.sdk.world.objects.isDead = (id: number) => dead && id === 40;
  f.farmer.eventGoal = first;
  expect(f.farmer.getEventGoal(10000).objectId).toBe(40); // stream-out alone is not a death
  dead = true;
  f.farmer.beaconPending = { at: 10000 };
  f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(41);
  expect(f.farmer.finishedEvents.has(40)).toBe(true);
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(next.position);
});

it('pins an arrived event through its death/loot window, even if displaced from the boss', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const boss = { ...f.quest, objectId: 40, isEventBoss: true };
  const next = { ...boss, objectId: 41, position: { x: 200, y: 0 } };
  let objects = [boss, next];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.sdk.world.objects.getBeacons = () => [{ objectId: 70, name: 'Teleport Beacon', position: { x: 195, y: 0 } }];
  f.setEnemies([boss]); f.farmer.onLoop();
  expect(f.farmer.eventArrived).toBe(true);
  boss.hp = 0; f.setEnemies([]); vi.setSystemTime(11000); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(40);
  expect(f.farmer.tryBeaconTeleport(12000, next)).toBe(false);
  f.sdk.self.distanceTo = (p: any) => Math.hypot(p.x - 30, p.y);
  vi.setSystemTime(15000); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(40);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  f.sdk.self.distanceTo = (p: any) => Math.hypot(p.x, p.y);
  // A bag appearing during the wait keeps priority past the ten-second window.
  const bag = { objectId: 80, rarity: 'white', position: { x: 5, y: 0 }, items: [{ slotIndex: 0, objectType: 2592 }] };
  f.sdk.loot.getNearbyBags.mockReturnValue([bag]); f.sdk.loot.getBags = () => [bag];
  vi.setSystemTime(22000); f.farmer.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  f.sdk.loot.getNearbyBags.mockReturnValue([]); f.sdk.loot.getBags = () => [];
  vi.setSystemTime(23000); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(41);
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(70);
});

it('continues a nearby replacement phase but releases its adds after confirmed death', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const boss = { ...f.quest, objectId: 40, isEventBoss: true };
  const next = { ...boss, objectId: 41, position: { x: 200, y: 0 } };
  let objects = [boss, next];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.setEnemies([boss]); f.farmer.onLoop();
  const phase = { ...boss, objectId: 42, name: 'Next phase', position: { x: 7, y: 0 } };
  objects = [phase, next]; f.setEnemies([phase]); vi.setSystemTime(12000); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(42);
  expect(f.farmer.eventArrived).toBe(true);
  phase.hp = 0;
  const add = { ...f.quest, objectId: 50, position: { x: 6, y: 0 } };
  f.setEnemies([phase, add]); vi.setSystemTime(13000); f.farmer.onLoop();
  vi.setSystemTime(45000); f.farmer.onLoop();
  expect(f.farmer.eventGoal.objectId).toBe(41);
  expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalledWith(50);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  f.farmer.resetMap('Other'); expect(f.farmer.eventArrived).toBe(false);
});

it('releases a killed leveling encounter without needing movement or a new quest marker', () => {
  const f = fixture(); f.setEnemies([f.quest]); f.farmer.onLoop();
  f.sdk.world.tiles = { getAll: () => [] };
  f.sdk.world.objects.isDead = (id: number) => id === f.quest.objectId;
  f.setEnemies([]); f.farmer.onLoop();
  expect(f.farmer.bossEncounter).toBeNull(); expect(f.farmer.questGoal).toBeNull();
  expect(f.farmer.lockId).toBe(0);
});
it('expires a missing encounter with no replacement quest and reacquires a vulnerable boss', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.setEnemies([f.quest]); f.farmer.handleBossEncounter(f.quest,10000);
  f.setEnemies([]); f.farmer.handleBossEncounter(null,10000);
  expect(f.sdk.ui.status).toHaveBeenLastCalledWith('Boss: waiting for encounter visibility');
  expect(f.farmer.handleBossEncounter(null,41000)).toBe(false);
  expect(f.farmer.bossEncounter).toBeNull();
  f.quest.isTargetable=false; f.setEnemies([f.quest]);
  f.farmer.handleBossEncounter(f.quest,42000); expect(f.farmer.lockId).toBe(0);
  f.quest.isTargetable=true; f.farmer.handleBossEncounter(f.quest,43000);
  expect(f.farmer.lockId).toBe(10); expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
});

describe('bosses protected by their adds', () => {
  // objects.xml: 0x55B0 "New Actual Lich" (DisplayId Lich), 0x55B1 "New Phylactery Bearer"
  // (DisplayId Phylactery Bearer), 0x55B2 "New Haunted Spirit" (DisplayId Haunted Spirit).
  // BOSS_ADD_RULES match objectType; names are only for readability.
  const lichFight = () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = fixture();
    Object.assign(f.quest, { name: 'Lich', objectType: 0x55B0, hp: 1100, maxHp: 1100 });
    const bearer = { objectId: 11, objectType: 0x55B1, name: 'Phylactery Bearer', position: { x: 7, y: 2 },
      hp: 1000, maxHp: 1000, isTargetable: true };
    const spirit = { objectId: 12, objectType: 0x55B2, name: 'Haunted Spirit', position: { x: 4, y: -1 },
      hp: 400, maxHp: 400, isTargetable: true };
    return { f, bearer, spirit };
  };

  it('kills the Lich adds first, healer before spirit, then the Lich', () => {
    const { f, bearer, spirit } = lichFight();
    f.setEnemies([f.quest, bearer, spirit]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(11);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
    f.setEnemies([f.quest, spirit]); vi.setSystemTime(10100); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(12);
    f.setEnemies([f.quest]); vi.setSystemTime(10200); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
  });

  it('ignores adds far from the Lich and still fights a boss that has no adds', () => {
    const { f, bearer } = lichFight();
    bearer.position = { x: 30, y: 0 };
    f.setEnemies([f.quest, bearer]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    const plain = fixture();
    plain.setEnemies([plain.quest, { ...bearer, objectId: 13, position: { x: 7, y: 0 } }]);
    plain.farmer.onLoop();
    expect(plain.farmer.lockId).toBe(10); // "Boss" has no BOSS_ADD_RULES entry
  });

  it('applies the same order when the Lich is fought outside a quest encounter', () => {
    const { f, bearer, spirit } = lichFight();
    f.sdk.world.objects.getQuestObject = () => null;
    f.sdk.world.objects.getById = () => null;
    f.sdk.world.tiles = { getAll: () => [] };
    bearer.position = { x: 8.5, y: 2 }; // beside the Lich, but past the player's own target radius
    f.setEnemies([f.quest, spirit, bearer]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(11);
  });

  it('does not make the enemies beside a healing boss a priority', () => {
    // The old heal rule turned every enemy within 12 tiles of any enemy whose HP rose into
    // a priority target for 8 s, so a self-regenerating boss sent the farmer after mobs.
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = fixture();
    Object.assign(f.quest, { hp: 500, maxHp: 1000 });
    const minion = { objectId: 20, name: 'Minion', position: { x: 7, y: 1 }, hp: 50, maxHp: 50, isTargetable: true };
    f.setEnemies([f.quest, minion]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    f.quest.hp = 620; vi.setSystemTime(10100); f.farmer.onLoop(); // healed: max HP unchanged
    expect(f.farmer.lockId).toBe(10);
    f.quest.hp = 700; vi.setSystemTime(10200); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
  });

  it('only counts a listed add close to its own boss, and never locks one past the lock release radius', () => {
    const { f, bearer, spirit } = lichFight();          // the Lich stands at (6, 0)
    bearer.position = { x: -3, y: 0 };                  // 9 tiles from the Lich: not guarding it
    f.setEnemies([f.quest, bearer]);
    expect(f.farmer.updateTarget(10).objectId).toBe(10);
    spirit.position = { x: 13, y: 0 };                  // beside the Lich, but 13 tiles from the player
    f.setEnemies([f.quest, spirit]);
    expect(f.farmer.updateTarget(10).objectId).toBe(10);
  });

  it("prioritises a boss's adds only while that boss is the target", () => {
    const { f, bearer } = lichFight();
    const other = { objectId: 30, objectType: 0x1234, name: 'Other Boss', position: { x: 5, y: 1 },
      hp: 5000, maxHp: 5000, isTargetable: true };
    f.setEnemies([f.quest, bearer, other]);
    expect(f.farmer.updateTarget(30).objectId).toBe(30);
  });

  // objects.xml: 0x0928 "Ghost King" / 0x5598 "New Ghost King" (300000 HP first form) and
  // 0x092d "Actual Ghost King" / 0x559A "New Actual Ghost King" (DisplayId Ghost King);
  // its adds 0x092a-0x092c / 0x559B-0x559D Small, Medium and Large Ghost.
  const ghostKingFight = () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const f = fixture();
    Object.assign(f.quest, { name: 'Ghost King', objectType: 0x5598, hp: 300000, maxHp: 300000 });
    const small = { objectId: 21, objectType: 0x559B, name: 'Small Ghost', position: { x: 5, y: 2 },
      hp: 1000, maxHp: 1000, isTargetable: true };
    const large = { objectId: 22, objectType: 0x559D, name: 'Large Ghost', position: { x: 7, y: -2 },
      hp: 8000, maxHp: 8000, isTargetable: true };
    return { f, small, large };
  };

  it('kills the Ghost King adds first, nearest first, then returns to the Ghost King', () => {
    const { f, small, large } = ghostKingFight();
    f.setEnemies([f.quest, large, small]); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(21);
    f.setEnemies([f.quest, large]); vi.setSystemTime(10100); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(22);
    f.setEnemies([f.quest]); vi.setSystemTime(10200); f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
    expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
  });

  it('is not distracted by adds that belong to a different boss', () => {
    const lich = lichFight();
    const ghost = { objectId: 21, objectType: 0x559B, name: 'Small Ghost', position: { x: 5, y: 1 },
      hp: 1000, maxHp: 1000, isTargetable: true };
    lich.f.setEnemies([lich.f.quest, ghost]); lich.f.farmer.onLoop();
    expect(lich.f.farmer.lockId).toBe(10);
    const king = ghostKingFight();
    king.f.setEnemies([king.f.quest, { ...lich.bearer, position: { x: 5, y: 1 } }]); king.f.farmer.onLoop();
    expect(king.f.farmer.lockId).toBe(10);
  });

});

it('releases a dead event boss when only untargetable objects remain beside it', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const boss = { ...f.quest, objectId: 40, isEventBoss: true };
  const next = { ...boss, objectId: 41, position: { x: 200, y: 0 } };
  const objects = [boss, next];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.setEnemies([boss]); f.farmer.onLoop();
  expect(f.farmer.eventArrived).toBe(true);
  boss.hp = 0;
  const helper = { ...f.quest, objectId: 51, name: 'Invulnerable helper', position: { x: 6, y: 1 }, isTargetable: false };
  f.setEnemies([boss, helper]); vi.setSystemTime(11000); f.farmer.onLoop();
  vi.setSystemTime(21500); f.farmer.onLoop();
  expect(f.farmer.finishedEvents.has(40)).toBe(true);
  expect(f.farmer.eventGoal.objectId).toBe(41);
});

it('living adds cannot extend a confirmed kill past the loot window', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  const boss = { ...f.quest, objectId: 40, isEventBoss: true };
  const next = { ...boss, objectId: 41, position: { x: 200, y: 0 } };
  const objects = [boss, next];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.setEnemies([boss]); f.farmer.onLoop();
  boss.hp = 0;
  const add = { ...f.quest, objectId: 50, position: { x: 6, y: -1 } };
  f.setEnemies([boss, add]); vi.setSystemTime(11000); f.farmer.onLoop();
  expect(f.farmer.lockId).toBe(0);
  vi.setSystemTime(21500); f.farmer.onLoop();
  expect(f.farmer.finishedEvents.has(40)).toBe(true);
  expect(f.farmer.eventGoal.objectId).toBe(41);
});

it.each(['packet', 'hp'])('releases a dead event combat lock immediately after %s evidence, even when displaced', (evidence) => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const fixtureState = fixture(); fixtureState.sdk.self.getLevel = () => 20;
  const boss = { ...fixtureState.quest, objectId: 40, isEventBoss: true };
  const next = { ...boss, objectId: 41, position: { x: 200, y: 0 } };
  const objects = [boss, next];
  fixtureState.sdk.world.objects.getAll = () => objects;
  fixtureState.sdk.world.objects.getById = (objectId: number) => objects.find(object => object.objectId === objectId);
  fixtureState.setEnemies([boss]); fixtureState.farmer.onLoop();
  expect(fixtureState.farmer.lockId).toBe(40);
  if (evidence === 'packet') fixtureState.sdk.world.objects.isDead = (objectId: number) => objectId === 40;
  else boss.hp = 0;
  fixtureState.setEnemies([{ ...fixtureState.quest, objectId: 50 }]);
  fixtureState.sdk.self.getX = () => 30;
  fixtureState.sdk.self.distanceTo = (position: any) => Math.hypot(position.x - 30, position.y);
  fixtureState.sdk.dodge.navigateToPosition.mockClear();
  vi.setSystemTime(11000); fixtureState.farmer.onLoop();
  expect(fixtureState.farmer.lockId).toBe(0);
  expect(fixtureState.farmer.bossEncounter).toBeNull();
  expect(fixtureState.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
  expect(fixtureState.sdk.ui.status).toHaveBeenLastCalledWith('Boss: defeated — waiting for loot or next phase');
  vi.setSystemTime(21500); fixtureState.farmer.onLoop();
  expect(fixtureState.farmer.eventGoal.objectId).toBe(41);
});

it('gives up on an event boss that never becomes targetable after bounded encounter attempts', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.self.getLevel = () => 20;
  f.sdk.world.tiles = { getAll: () => [] };
  const marker = { objectId: 40, isEventBoss: true, name: 'Hidden boss', position: { x: 6, y: 0 }, hp: 5000, maxHp: 5000 };
  const next = { ...marker, objectId: 41, name: 'Next boss', position: { x: 200, y: 0 } };
  const objects = [marker, next];
  f.sdk.world.objects.getAll = () => objects;
  f.sdk.world.objects.getById = (id: number) => objects.find(o => o.objectId === id);
  f.setEnemies([]);                                    // the event object never appears among enemies
  for (let t = 10000; t <= 75000; t += 1000) { vi.setSystemTime(t); f.farmer.onLoop(); }
  expect(f.farmer.finishedEvents.has(40)).toBe(true);
  expect(f.farmer.eventGoal.objectId).toBe(41);
});

it('re-picks a far committed quest once the server names another quest and the old one is out of view', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.quest.position.x = 100;
  let serverQuest = 10; let visible: any[] = [f.quest];
  const other = { ...f.quest, objectId: 11, name: 'Other', position: { x: -60, y: 0 } };
  f.sdk.world.objects.getById = (id: number) => visible.find(o => o.objectId === id) ?? null;
  f.sdk.world.objects.getQuestObject = () => visible.find(o => o.objectId === serverQuest) ?? null;
  f.sdk.world.objects.getQuestTargetId = () => serverQuest;
  f.sdk.walking.canTeleport = () => false;
  f.farmer.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(f.quest.position);
  visible = []; vi.setSystemTime(70000); f.farmer.onLoop();
  expect(f.farmer.questGoal.objectId).toBe(10);         // out of view, but the server still names it
  serverQuest = 11; visible = [other]; vi.setSystemTime(71000); f.farmer.onLoop();
  expect(f.farmer.questGoal.objectId).toBe(10);         // short grace for a flip
  vi.setSystemTime(74500); f.farmer.onLoop();
  expect(f.farmer.questGoal.objectId).toBe(11);
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(other.position);
});

it('prefers a targetable enemy over a bigger locked one that can no longer be damaged', () => {
  const f = fixture();
  const shielded = { objectId: 30, name: 'Shielded', position: { x: 3, y: 0 }, hp: 50000, maxHp: 50000, isTargetable: false };
  const mob = { objectId: 31, name: 'Mob', position: { x: 4, y: 0 }, hp: 100, maxHp: 100, isTargetable: true };
  f.farmer.lockId = 30;
  f.setEnemies([shielded, mob]);
  expect(f.farmer.updateTarget(0).objectId).toBe(31);
});
