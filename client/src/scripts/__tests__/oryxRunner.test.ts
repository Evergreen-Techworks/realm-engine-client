import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../../script-packages/farmer/oryx-runner.mjs', import.meta.url), 'utf8')
  .replace('export default class OryxRunner', 'return class OryxRunner');
const Runner = new Function(source)();
const enemy = (name: string, objectId = 10, x = 6, y = 0): any => ({
  name, objectId, position: { x, y }, hp: 100, maxHp: 100, isTargetable: true,
});
function fixture(map = "Oryx's Castle") {
  const state: any = { position: { x: 0.5, y: 0.5 }, enemies: [], objects: [], portals: [], tiles: [], dead: new Set(), items: [] };
  const sdk: any = {
    self: { getHP: () => 100, getX: () => state.position.x, getY: () => state.position.y,
      distanceTo: (p: any) => Math.hypot(p.x - state.position.x, p.y - state.position.y) },
    enemies: { getAll: () => state.enemies },
    world: { getSize: () => ({ width: 100, height: 100 }),
      objects: { getAll: () => state.objects, getPortals: () => state.portals,
        getQuestObject: () => null, isDead: (id: number) => state.dead.has(id),
        getTypeName: (id: number) => id === 42 ? 'Wine Cellar Incantation' : 'Potion of Defense' },
      tiles: { getAll: () => state.tiles } },
    dodge: { clearWaypoint: vi.fn(), navigateToPosition: vi.fn(), lockEnemy: vi.fn() },
    combat: { stopAiming: vi.fn(), aimAt: vi.fn(), aimAtPosition: vi.fn(), pauseAutomaticAbility: vi.fn() },
    inventory: { getAll: () => state.items, useItem: vi.fn() },
    walking: { nexus: vi.fn() }, ui: { status: vi.fn() }, log: { info: vi.fn() },
  };
  const farmer: any = { lockId: 0, lastItemActionAt: -Infinity, setFiring: vi.fn(),
    updateTarget: vi.fn(() => { farmer.lockId = 0; farmer.setFiring(false); }), handleLoot: vi.fn(() => false) };
  const runner = new Runner(farmer, sdk); runner.reset(map);
  return { runner, sdk, farmer, state };
}
const portal = (destination: string, name = `${destination} Portal`, objectId = 50): any => ({
  objectId, name, destination, isOpen: true, position: { x: 0.5, y: 0.5 }, enter: vi.fn(() => true),
});
function floor(f: ReturnType<typeof fixture>, width: number, height: number) {
  f.state.tiles = Array.from({ length: width * height }, (_, i) => ({
    position: { x: i % width + 0.5, y: Math.floor(i / width) + 0.5 },
    isBlocking: false, damaging: false, hasConditionEffect: false,
  }));
}

describe('Oryx progression', () => {
  it('cancels pending completion when a boss reuses its id with restored HP', () => {
    const f = fixture("Oryx's Sanctuary"), boss = enemy('Oryx the Mad God 3');
    f.state.enemies = [boss]; f.runner.tick(0);
    boss.hp = 0; f.runner.tick(500); expect(f.runner.completedAt).toBe(500);
    boss.hp = 100; f.runner.tick(1000); f.runner.tick(20000);
    expect(f.runner.completedAt).toBeNull(); expect(f.runner.dead.has(10)).toBe(false);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
  });
  it.each([
    ["Oryx's Castle", "Oryx's Chamber"], ["Oryx's Chamber", 'Wine Cellar'],
    ['Wine Cellar', "Oryx's Sanctuary"],
  ])('enters only the next dungeon from %s with throttled attempts', (map, next) => {
    const f = fixture(map), correct = portal(next);
    const wrong = [portal('Nexus'), portal('Pirate Cave'), portal('Court of Oryx')];
    f.state.portals = [...wrong, correct];
    f.runner.tick(0); f.runner.tick(100); f.runner.tick(3000);
    expect(correct.enter).toHaveBeenCalledTimes(2);
    for (const p of wrong) expect(p.enter).not.toHaveBeenCalled();
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
  });
  it('recognizes destination-less portal names and ignores unrelated portals', () => {
    const f = fixture(); const p = portal('', 'Oryx’s Chamber Portal');
    f.state.portals = [p]; f.runner.tick(0);
    expect(p.enter).toHaveBeenCalledOnce();
  });
  it('uses one carried incantation at a locked portal, then follows its replacement', () => {
    const f = fixture("Oryx's Chamber"), locked = portal('Wine Cellar', 'Locked Wine Cellar Portal');
    f.state.items = [-1, -1, -1, -1, 42]; f.state.portals = [locked];
    f.runner.tick(0); f.runner.tick(5000);
    expect(locked.enter).not.toHaveBeenCalled();
    expect(f.sdk.inventory.useItem).toHaveBeenCalledOnce();
    expect(f.sdk.inventory.useItem).toHaveBeenCalledWith(4);
    const open = portal('Wine Cellar', 'Wine Cellar Portal', 51);
    f.state.portals = [open]; f.runner.tick(5100);
    expect(open.enter).toHaveBeenCalledOnce();
  });
  it('does not consume an incantation remotely', () => {
    const f = fixture("Oryx's Chamber"), locked = portal('Wine Cellar', 'Locked Wine Cellar Portal');
    locked.position.x = 20; f.state.items = [-1, -1, -1, -1, 42]; f.state.portals = [locked];
    f.runner.tick(0);
    expect(f.sdk.inventory.useItem).not.toHaveBeenCalled();
  });
  it('bounds loot time so a full bag cannot prevent portal entry', () => {
    const f = fixture(), p = portal("Oryx's Chamber"); f.state.portals = [p];
    f.farmer.handleLoot.mockReturnValue(true);
    f.runner.tick(0); f.runner.tick(9900);
    expect(p.enter).not.toHaveBeenCalled();
    f.runner.tick(10000); expect(p.enter).toHaveBeenCalledOnce();
  });
  it('returns to farming if the cellar remains locked for two minutes', () => {
    const f = fixture("Oryx's Chamber");
    f.state.portals = [portal('Wine Cellar', 'Locked Wine Cellar Portal')];
    f.runner.tick(0); f.runner.tick(119900);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    f.runner.tick(120000); f.runner.tick(120100); f.runner.tick(123000);
    expect(f.sdk.walking.nexus).toHaveBeenCalledTimes(2);
  });
  it('waits for runes after O2 and detects the opened Sanctuary portal', () => {
    const f = fixture('Wine Cellar'); f.state.enemies = [enemy('Oryx the Mad God 2')];
    f.runner.tick(0); f.state.dead.add(10); f.state.enemies = []; f.runner.tick(100);
    f.runner.tick(10000); expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    const p = portal("Oryx's Sanctuary"); f.state.portals = [p]; f.runner.tick(20000);
    expect(p.enter).toHaveBeenCalledOnce();
  });
  it('offers each carried rune once beside the matching monument', () => {
    const f = fixture('Wine Cellar');
    f.sdk.world.objects.getTypeName = (id: number) => ({ 41: 'Sword Rune', 42: 'Shield Rune', 43: 'Helmet Rune' })[id as 41];
    f.state.items = [-1, -1, -1, -1, 41, 42, 43];
    f.state.objects = ['Sword', 'Shield', 'Helmet'].map((kind, i) => ({
      objectId: 100 + i, name: `${kind} Rune Monument`, position: f.state.position,
    }));
    f.runner.tick(0); f.runner.tick(1300); f.runner.tick(2600); f.runner.tick(5000);
    expect(f.sdk.inventory.useItem.mock.calls).toEqual([[4], [5], [6]]);
  });
  it('requires both guardians, then waits for their portal', () => {
    const f = fixture();
    f.state.enemies = [enemy('Oryx Stone Guardian Left'), enemy('Oryx Stone Guardian Right', 11)];
    f.runner.tick(0); f.state.dead.add(10); f.state.enemies.shift(); f.runner.tick(100);
    expect(f.runner.completedAt).toBeNull(); expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
    f.state.dead.add(11); f.state.enemies = []; f.runner.tick(200);
    expect(f.runner.completedAt).toBe(200); expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
  });
  it.each(['Chancellor Dammah', 'Treasurer Gemsbok', 'Archbishop Leucoryx', 'Chief Beisa'])(
    'continues past %s to O3 instead of treating a miniboss as completion', name => {
      const f = fixture("Oryx's Sanctuary"); f.state.enemies = [enemy(name)]; f.runner.tick(0);
      f.state.dead.add(10); f.state.enemies = []; f.runner.tick(100);
      expect(f.runner.completedAt).toBeNull(); expect(f.runner.gateAt).toBeNull();
      f.state.enemies = [enemy('Oryx the Mad God 3', 20)]; f.runner.tick(11000);
      expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(20);
      f.state.dead.add(20); f.state.enemies = []; f.runner.tick(12000); f.runner.tick(21999);
      expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
      f.runner.tick(22000); expect(f.sdk.walking.nexus).toHaveBeenCalledOnce();
    });
  it('does not call an absent or invulnerable boss dead', () => {
    const f = fixture("Oryx's Sanctuary"); f.state.enemies = [enemy('Oryx the Mad God 3')];
    f.runner.tick(0); f.state.enemies[0].isTargetable = false; f.runner.tick(1000);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    f.state.enemies = []; f.runner.tick(40000); f.runner.tick(180000);
    expect(f.runner.completedAt).toBeNull(); expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
  });
  it('switches to the vulnerable guardian while its partner is invulnerable', () => {
    const f = fixture(); const a = enemy('Stone Guardian', 10), b = enemy('Stone Guardian', 11);
    f.state.enemies = [a, b]; f.runner.tick(0); a.isTargetable = false; f.runner.tick(100);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
  });
  it('holds weapons and abilities throughout an observed guard, then resumes without an arbitrary delay', () => {
    const f = fixture("Oryx's Sanctuary"), boss = enemy('Oryx the Mad God 3');
    f.state.enemies = [boss]; f.runner.tick(0);
    boss.isGuarding = true; f.runner.tick(100); f.runner.tick(5000);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    expect(f.sdk.combat.pauseAutomaticAbility).toHaveBeenLastCalledWith(1000);
    boss.isGuarding = false; f.runner.tick(5100); expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
  });
  it('holds Dammah intro even when the group has damaged him until attack portals appear', () => {
    const f = fixture("Oryx's Sanctuary"); const boss = enemy('Chancellor Dammah');
    boss.hp = 90; f.state.enemies = [boss]; f.runner.tick(0);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    f.state.objects = [enemy('Inferno Portal', 20)]; f.runner.tick(500);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
  });
  it('authenticates Celestial cues by boss object and holds despite targetability until the stagger cue', () => {
    const f = fixture("Oryx's Sanctuary"); f.state.enemies = [enemy('Oryx the Mad God 3')];
    const cue = { message: 'FALL BEFORE MY CELESTIAL STRENGTH!', isLocal: false, sourceObjectId: 99 };
    f.runner.onMessage(cue); f.runner.tick(0);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
    f.runner.onMessage({ ...cue, sourceObjectId: 10 }); f.runner.tick(500);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    f.runner.tick(30000); expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    f.runner.onMessage({ ...cue, sourceObjectId: 10, message: 'NO! This cannot be…' });
    f.runner.tick(30500); expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
  });
  it('does not guess at Gemsbok artifacts and resumes after they resolve', () => {
    const f = fixture("Oryx's Sanctuary"); f.state.enemies = [enemy('Treasurer Gemsbok'), enemy('Treasure Artifact', 11)];
    f.runner.onMessage({ sourceObjectId: 10, message: 'Heads I win, tails you lose!' }); f.runner.tick(0);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    f.state.enemies.pop(); f.runner.tick(500);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(10);
  });
  it('prioritizes Leucoryx orbs and Oryx messengers over the boss', () => {
    const f = fixture("Oryx's Sanctuary");
    f.state.enemies = [enemy('Archbishop Leucoryx'), enemy('Orb of Light', 11)]; f.runner.tick(0);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
    f.runner.reset("Oryx's Sanctuary");
    f.state.enemies = [enemy('Oryx the Mad God 3'), enemy('Messenger of Oryx', 12)]; f.runner.tick(100);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(12);
  });
  it('resets all encounter, portal and route state even for the same map name', () => {
    const f = fixture(); f.state.portals = [portal("Oryx's Chamber")]; f.runner.tick(0);
    f.runner.dead.add(10); f.runner.visits.set('1,1', 4); f.runner.reset("Oryx's Castle");
    expect(f.runner.gateAt).toBeNull(); expect(f.runner.dead.size).toBe(0);
    expect(f.runner.visits.size).toBe(0); expect(f.runner.lastUseAt).toBe(-Infinity);
  });
});

describe('Oryx terrain navigation', () => {
  it('takes the long corridor around a wall instead of cutting directly toward O2', () => {
    const f = fixture('Wine Cellar'); floor(f, 12, 12);
    f.state.position = { x: 10.5, y: 0.5 };
    f.state.objects = Array.from({ length: 11 }, (_, i) => ({ blocksMovement: true, position: { x: i + 1.5, y: 3.5 } }));
    const graph = f.runner.graph();
    expect(graph.steps.get('10,6')).toBeGreaterThan(20);
    f.runner.route({ x: 10.5, y: 6.5 }, 0);
    const next = f.sdk.dodge.navigateToPosition.mock.calls.at(-1)?.[0];
    expect(next.y).toBeLessThan(3.5); expect(next.x).toBeLessThan(10.5);
  });
  it('respects a closed room gate and routes onward after it disappears', () => {
    const f = fixture("Oryx's Sanctuary"); floor(f, 10, 1);
    f.state.objects = [{ blocksMovement: true, position: { x: 4.5, y: 0.5 } }];
    expect(f.runner.graph().parents.has('8,0')).toBe(false);
    f.runner.route({ x: 8.5, y: 0.5 }, 0);
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 3.5, y: 0.5 });
    f.state.objects = []; f.runner.route({ x: 8.5, y: 0.5 }, 500);
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenLastCalledWith({ x: 5.5, y: 0.5 });
  });
  it('excludes damaging, condition-effect and void floors but permits occupied player tiles', () => {
    const f = fixture(); floor(f, 8, 1);
    f.state.tiles[1].isOccupied = true;
    f.state.tiles[3].damaging = true;
    const g = f.runner.graph(); expect(g.parents.has('1,0')).toBe(true); expect(g.parents.has('4,0')).toBe(false);
    f.state.tiles[3].damaging = false; f.state.tiles[3].hasConditionEffect = true;
    expect(f.runner.graph().parents.has('4,0')).toBe(false);
    f.state.tiles[3].hasConditionEffect = false; f.state.tiles[3].isBlocking = true;
    expect(f.runner.graph().parents.has('4,0')).toBe(false);
  });
  it('shoots destructible castle walls even when they are props', () => {
    const f = fixture(); f.state.objects = [{ ...enemy('Fortified Destructible Castle Wall', 99, 4, 0), blocksMovement: true }];
    f.runner.tick(0);
    expect(f.sdk.combat.aimAtPosition).toHaveBeenCalledWith(4, 0);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
    expect(f.sdk.dodge.lockEnemy).not.toHaveBeenCalled();
  });
  it('does not navigate on unavailable terrain or while the character is spawning', () => {
    const f = fixture(); f.runner.tick(0);
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
    f.sdk.self.getHP = () => 0; f.state.portals = [portal("Oryx's Chamber")]; f.runner.tick(1000);
    expect(f.state.portals[0].enter).not.toHaveBeenCalled();
  });
});
