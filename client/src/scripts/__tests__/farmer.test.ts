import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
const source = readFileSync(new URL('../../../script-packages/farmer/index.mjs', import.meta.url), 'utf8')
  .replace("import { RealmEngine } from '@realmengine/sdk';", '')
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
  const Farmer = new Function('RealmEngine', source)(sdk);
  const farmer = new Farmer(); farmer.mapName = 'Realm';
  return { farmer, sdk, quest, setEnemies: (value: any[]) => { enemies = value; } };
}
afterEach(() => vi.useRealTimers());
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
  it('lets useful loot interrupt a boss fight and resumes combat after it disappears', () => {
    const f = fixture(); f.setEnemies([f.quest]); f.farmer.onLoop();
    const bag = { objectId: 20, rarity: 'blue', position: { x: 2, y: 0 }, items: [{ slotIndex: 1, objectType: 2592 }] };
    let bags = [bag];
    f.sdk.loot.getNearbyBags.mockImplementation(() => bags);
    f.sdk.loot.getBags = () => bags;
    f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(0);
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(bag.position);
    const clears = f.sdk.dodge.clearWaypoint.mock.calls.length;
    f.farmer.onLoop();
    expect(f.sdk.dodge.clearWaypoint).toHaveBeenCalledTimes(clears);
    bags = [];
    f.farmer.onLoop();
    expect(f.farmer.lockId).toBe(10);
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


describe('Realm Farmer castle exit', () => {
  it.each(["Oryx's Castle", 'Oryx’s Castle', 'Oryx Castle'])('returns from %s before combat or loot and throttles retries', (map) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = fixture(); f.setEnemies([f.quest]); f.farmer.lockId = 10;
    f.sdk.world.getName = () => map;
    f.sdk.world.isRealm = () => false;
    f.farmer.onLoop();
    expect(f.sdk.walking.nexus).toHaveBeenCalledTimes(1);
    expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(false);
    expect(f.sdk.combat.stopAiming).toHaveBeenCalled();
    expect(f.sdk.dodge.clearWaypoint).toHaveBeenCalled();
    expect(f.sdk.loot.getNearbyBags).not.toHaveBeenCalled();
    expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalled();
    vi.setSystemTime(100); f.farmer.onLoop();
    expect(f.sdk.walking.nexus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(3000); f.farmer.onLoop();
    expect(f.sdk.walking.nexus).toHaveBeenCalledTimes(2);
    f.sdk.world.getName = () => 'Nexus'; f.sdk.world.isNexus = () => true;
    f.setEnemies([]); f.sdk.world.objects.getOpenPortals = () => [];
    f.farmer.onLoop();
    expect(f.sdk.walking.nexus).toHaveBeenCalledTimes(2);
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
