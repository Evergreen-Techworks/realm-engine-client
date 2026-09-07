import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
const source = (name: string) => readFileSync(new URL(`../../../script-packages/${name}/index.mjs`, import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
function fixture() {
  const pos = { x: 0.5, y: 0.5 };
  const beacon = { objectId: 40, objectClass: 'Beacon', name: 'Dead Church Beacon (Adept)', position: { x: 100.5, y: 0.5 } };
  const mob = { objectId: 2, name: 'Ghastly Nun', group: 'Dead Church Mobs', biome: 'DeadChurch',
    position: { x: 104.5, y: 0.5 }, hp: 1500, isTargetable: true };
  let bags: any[] = [];
  const sdk: any = {
    self: { getHP: () => 100, getX: () => pos.x, getY: () => pos.y, distanceTo: (p: any) => Math.hypot(p.x-pos.x,p.y-pos.y) },
    dodge: { clearWaypoint: vi.fn(), navigateToPosition: vi.fn(), lockEnemy: vi.fn(), clearEnemyLock: vi.fn() },
    combat: { setAutoFire: vi.fn(), aimAt: vi.fn(), stopAiming: vi.fn() },
    inventory: { getAll: () => [] },
    loot: { getNearbyBags: () => bags, getBags: () => bags },
    walking: { canTeleport: () => true, teleportToBeacon: vi.fn(() => true) },
    enemies: { getAll: () => [mob, { ...mob, objectId: 3, name: 'Other biome boss', group: 'Other', biome: 'Other' }] },
    world: { getName: () => 'Realm', isNexus: () => false, isRealm: () => true,
      objects: { getBeacons: () => [beacon], getQuestObject: () => null },
      tiles: { getNearby: () => [100.5,104.5,110.5].map((x) => ({ name: 'Dead Church Grass', position: { x, y: 0.5 } })) } },
    ui: { status: vi.fn() }, log: { info: vi.fn() },
  };
  const Farmer = new Function('RealmEngine', source('farmer'))(sdk);
  const DeadChurch = new Function('RealmEngine', 'Farmer', source('dead-church-farmer'))(sdk, Farmer);
  return { script: new DeadChurch(), sdk, pos, beacon, mob, bags: (b: any[]) => { bags = b; } };
}
afterEach(() => { vi.useRealTimers(); });
it('teleports to the specific beacon then farms only matching biome mobs', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.script.onLoop();
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(40);
  f.pos.x = 100.5; vi.setSystemTime(14000); f.script.onLoop();
  expect(f.sdk.dodge.lockEnemy).toHaveBeenCalledWith(2);
  expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalledWith(3);
});
it('walks when teleport is unavailable and gives a local white bag priority', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.walking.canTeleport = () => false;
  f.script.onLoop(); expect(f.sdk.dodge.navigateToPosition).toHaveBeenCalledWith(f.beacon.position);
  f.pos.x = 100.5; f.script.onLoop();
  f.bags([{ objectId: 80, rarity: 'white', position: f.mob.position, items: [{ objectType: 100, slotIndex: 0 }] }]);
  f.script.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(f.mob.position);
  expect(f.script.lockId).toBe(0);
});
it('patrol destinations stay on known biome terrain and reset on map change', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 100.5; f.sdk.enemies.getAll = () => [];
  f.script.onLoop();
  const target = f.sdk.dodge.navigateToPosition.mock.calls.at(-1)[0];
  expect(f.script.inBiome(target)).toBe(true);
  f.script.resetMap('Other Realm');
  expect(f.script.destination).toBeNull(); expect(f.script.travelDone).toBe(false);
});

it('explores known walkable terrain when the beacon has not streamed', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.world.objects.getBeacons = () => [];
  f.sdk.world.tiles.getNearby = () => [{ name: 'Grass', position: { x: 10.5, y: 0.5 } }];
  f.script.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenCalledWith({ x: 10.5, y: 0.5 });
  expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalled();
});

it('explains walking fallback and unconfirmed teleport backoff in the status', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.walking.canTeleport = () => false;
  f.script.onLoop();
  expect(f.sdk.ui.status).toHaveBeenLastCalledWith(expect.stringContaining('map reports teleport disabled'));
  f.sdk.walking.canTeleport = () => true;
  f.script.onLoop();
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledTimes(1);
  vi.setSystemTime(16000); f.script.onLoop();
  expect(f.sdk.ui.status).toHaveBeenLastCalledWith(expect.stringContaining('last teleport unconfirmed; retry in'));
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledTimes(1);
});

it('limits terrain refreshes to a local neighborhood and once per second', () => {
  const f = fixture();
  const nearby = vi.fn(f.sdk.world.tiles.getNearby);
  f.sdk.world.tiles.getNearby = nearby;
  f.sdk.world.tiles.getAll = vi.fn(() => { throw new Error('full-map scan'); });
  f.script.refreshTiles(10000); f.script.refreshTiles(10500); f.script.refreshTiles(11000);
  expect(nearby).toHaveBeenCalledTimes(2);
  expect(nearby).toHaveBeenCalledWith(32);
  expect(f.sdk.world.tiles.getAll).not.toHaveBeenCalled();
});

it('remembers discovered areas and visits actual positions rather than selected destinations', () => {
  const f = fixture(); f.pos.x = 100.5;
  f.script.refreshTiles(10000);
  f.script.patrol(10000);
  const chosen = { ...f.script.patrolGoal };
  const chosenKey = f.script.patrolGoalKey;
  expect(f.script.visited.has(chosenKey)).toBe(false);
  f.sdk.world.tiles.getNearby = () => [];
  f.script.refreshTiles(11000); f.script.patrol(11000);
  expect(f.script.patrolGoal).toEqual(chosen);
  expect(f.script.patrolCells.has(chosenKey)).toBe(true);
  f.pos.x = chosen.x; f.pos.y = chosen.y;
  f.script.patrol(12000);
  expect(f.script.visited.get(chosenKey)).toBe(12000);
  f.script.resetMap('Other');
  expect(f.script.patrolCells.size).toBe(0); expect(f.script.visited.size).toBe(0);
});

it('favors forward exploration, then returns to remaining unvisited areas before farming old areas', () => {
  const f = fixture(); f.pos.x = 12; f.pos.y = 0;
  f.script.patrolHeading = { x: 1, y: 0 };
  const points = [0, 6, 18, 24].map(x => ({ position: { x, y: 0 } }));
  f.script.rememberCells(points, f.script.patrolCells, 'biome');
  f.script.patrol(10000);
  expect(f.script.patrolGoal.x).toBe(18);
  f.pos.x = 18; f.script.patrol(11000);
  expect(f.script.patrolGoal.x).toBe(24);
  f.pos.x = 24; f.script.patrol(12000);
  expect(f.script.patrolGoal.x).toBe(6);
});

it('preserves destinations through long fights but defers genuinely stalled travel without claiming coverage', () => {
  const f = fixture(); f.pos.x = 100.5; f.script.refreshTiles(10000); f.script.patrol(10000);
  const goal = { ...f.script.patrolGoal }; const key = f.script.patrolGoalKey;
  f.script.pausePatrol(50000); f.script.patrol(50100);
  expect(f.script.patrolGoal).toEqual(goal);
  f.script.patrol(71000);
  expect(f.script.visited.has(key)).toBe(false);
  expect(f.script.patrolRetryAfter.get(key)).toBe(131000);
  expect(f.script.patrolGoalKey).not.toBe(key);
});

it('interrupts biome combat for the leader quest, keeps it through quest changes, then resumes', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 100.5;
  f.script.onLoop(); expect(f.script.lockId).toBe(2);
  const leader = { ...f.mob, objectId: 99, name: 'Shady Sect Leader', position: { x: 200.5, y: 0.5 } };
  f.sdk.world.objects.getQuestObject = () => leader;
  f.sdk.walking.canTeleport = () => false;
  f.script.onLoop();
  expect(f.script.lockId).toBe(0);
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(leader.position);
  f.sdk.world.objects.getQuestObject = () => f.mob;
  f.script.onLoop(); expect(f.script.leaderQuest.objectId).toBe(99);
  f.pos.x = 194.5; f.sdk.enemies.getAll = () => [leader, f.mob];
  f.script.onLoop(); expect(f.sdk.dodge.lockEnemy).toHaveBeenLastCalledWith(99);
  expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(99);
  leader.hp = 0; f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  vi.setSystemTime(13100); f.script.onLoop();
  expect(f.script.leaderQuest).toBeNull(); expect(f.script.finishedLeaders.has(99)).toBe(true);
  f.sdk.world.objects.getQuestObject = () => leader;
  f.script.onLoop(); expect(f.script.leaderQuest).toBeNull();
  f.script.resetMap('New Realm'); expect(f.script.finishedLeaders.size).toBe(0);
});

it('remembers the leader during white-bag collection and chooses a beacon near the boss', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 100.5;
  const leader = { objectId: 99, name: 'Shady Sect Leader', position: { x: 300.5, y: 0.5 } };
  const nearBoss = { objectId: 77, objectClass: 'Beacon', name: 'Forest Beacon (Adept)', position: { x: 290.5, y: 0.5 } };
  f.sdk.world.objects.getQuestObject = () => leader;
  f.sdk.world.objects.getBeacons = () => [f.beacon, nearBoss];
  f.bags([{ objectId: 80, rarity: 'white', position: f.mob.position, items: [{ objectType: 100, slotIndex: 0 }] }]);
  f.script.onLoop();
  expect(f.script.leaderQuest.objectId).toBe(99);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  f.bags([]); f.script.onLoop();
  expect(f.sdk.walking.teleportToBeacon).toHaveBeenCalledWith(77);
});

it('holds a missing leader through chamber entry until sustained absence and a different quest', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.sdk.walking.canTeleport = () => false;
  f.sdk.world.objects.getQuestObject = () => ({ objectId: 99, name: 'Shady Sect Leader', position: { x: 200.5, y: 0.5 } });
  f.sdk.enemies.getAll = () => [];
  f.script.onLoop(); vi.setSystemTime(20000); f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  f.pos.x = 200.5; f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  vi.setSystemTime(23100); f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  vi.setSystemTime(60000); f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull(); // same quest still points at leader
  f.sdk.world.objects.getQuestObject = () => f.mob;
  f.script.onLoop();
  expect(f.script.leaderQuest).toBeNull();
});

it('never beacon-teleports after entering the encounter and reacquires a replacement leader', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 194.5;
  const leader = { ...f.mob, objectId: 99, name: 'Shady Sect Leader', position: { x: 200.5, y: 0.5 } };
  f.sdk.world.objects.getQuestObject = () => leader;
  f.sdk.enemies.getAll = () => [leader];
  f.script.onLoop(); expect(f.script.leaderArrived).toBe(true);
  // Chamber movement leaves the old marker far away, while the leader hides.
  f.pos.x = 250.5; f.sdk.enemies.getAll = () => [];
  vi.setSystemTime(20000); f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  const phase = { ...leader, objectId: 100, position: { x: 256.5, y: 0.5 } };
  f.sdk.enemies.getAll = () => [phase];
  f.script.onLoop();
  expect(f.script.lockId).toBe(100);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  phase.position.x = 270.5; f.script.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(phase.position);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
});

it('clears targetable encounter adds during invincibility and immediately switches back to the vulnerable boss', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 194.5;
  const leader = { ...f.mob, objectId: 99, name: 'Shady Sect Leader', position: { x: 200.5, y: 0.5 }, isTargetable: false };
  const add = { ...f.mob, objectId: 100, name: 'Sect add', position: { x: 198.5, y: 0.5 } };
  const invincibleAdd = { ...add, objectId: 101, isTargetable: false };
  const unrelated = { ...add, objectId: 102, position: { x: 150, y: 0.5 } };
  f.sdk.world.objects.getQuestObject = () => leader;
  f.sdk.enemies.getAll = () => [leader, invincibleAdd, unrelated, add];
  f.script.onLoop();
  expect(f.script.lockId).toBe(100);
  expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(100);
  expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(true);
  leader.isTargetable = true; f.script.onLoop();
  expect(f.script.lockId).toBe(99);
  expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(99);
  leader.isTargetable = false; add.hp = 0; f.script.onLoop();
  expect(f.script.lockId).toBe(0);
  expect(f.sdk.combat.setAutoFire).toHaveBeenLastCalledWith(false);
  expect(f.script.leaderQuest).not.toBeNull();
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
});

it('walks to distant adds and preserves a hidden boss encounter while adds remain', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const f = fixture(); f.pos.x = 194.5;
  const leader = { ...f.mob, objectId: 99, name: 'Shady Sect Leader', position: { x: 200.5, y: 0.5 }, isTargetable: false };
  const add = { ...f.mob, objectId: 100, name: 'Sect add', position: { x: 212.5, y: 0.5 } };
  f.sdk.world.objects.getQuestObject = () => leader;
  f.sdk.enemies.getAll = () => [leader, add];
  f.script.onLoop();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(add.position);
  expect(f.sdk.walking.teleportToBeacon).not.toHaveBeenCalled();
  f.sdk.enemies.getAll = () => [add]; f.sdk.world.objects.getQuestObject = () => f.mob;
  vi.setSystemTime(11000); f.script.onLoop();
  vi.setSystemTime(50000); f.script.onLoop();
  expect(f.script.leaderQuest).not.toBeNull();
  expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith(add.position);
});
