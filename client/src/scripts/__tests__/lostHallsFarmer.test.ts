import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../../script-packages/${path}`, import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
const OryxRunner = new Function(read('farmer/oryx-runner.mjs'))();
const Runner = new Function('OryxRunner', read('farmer/lost-halls-runner.mjs'))(OryxRunner);
const mob = (name: string, objectId = 10, x = 5.5, y = 0.5): any => ({
  name, objectId, objectType: 1, hp: 100, maxHp: 100, isTargetable: true, position: { x, y },
});
const portal = (destination: string, name = `${destination} Portal`): any => ({
  name, destination, objectId: 50, isOpen: true, position: { x: 0.5, y: 0.5 }, enter: vi.fn(() => true),
});
function fixture(mode = 'void', map = 'Lost Halls') {
  const state: any = { position: { x: 0.5, y: 0.5 }, map, enemies: [], objects: [], portals: [], tiles: [], items: [], dead: new Set() };
  const sdk: any = {
    self: { getHP: () => 100, getX: () => state.position.x, getY: () => state.position.y,
      distanceTo: (p: any) => Math.hypot(p.x - state.position.x, p.y - state.position.y) },
    world: { getName: () => state.map, isRealm: () => state.map === 'Realm', isNexus: () => state.map === 'Nexus',
      getSize: () => ({ width: 100, height: 100 }),
      objects: { getAll: () => state.objects, getPortals: () => state.portals, getOpenPortals: () => state.portals.filter((p: any) => p.isOpen),
        isDead: (id: number) => state.dead.has(id), getQuestObject: () => null,
        getTypeName: (id: number) => id === 42 ? 'Vial of Pure Darkness' : 'Potion of Defense' },
      tiles: { getAll: () => state.tiles } },
    enemies: { getAll: () => state.enemies },
    dodge: { clearWaypoint: vi.fn(), clearEnemyLock: vi.fn(), navigateToPosition: vi.fn(), lockEnemy: vi.fn() },
    combat: { stopAiming: vi.fn(), aimAt: vi.fn(), aimAtPosition: vi.fn(), setAutoFire: vi.fn() },
    inventory: { getAll: () => state.items, useItem: vi.fn() },
    loot: { getNearbyBags: vi.fn(() => []), getBags: () => [], pickup: vi.fn(() => true),
      isUT: () => false, isST: () => false, isUsefulStatPot: () => false, isEquipmentUpgrade: () => false },
    walking: { nexus: vi.fn() }, ui: { status: vi.fn() }, log: { info: vi.fn() },
  };
  const farmer: any = { lockId: 0, lastItemActionAt: -Infinity, setFiring: vi.fn(),
    updateTarget: vi.fn(() => { farmer.lockId = 0; farmer.setFiring(false); }), handleLoot: vi.fn(() => false) };
  const runner = new Runner(farmer, sdk, mode); runner.reset(map);
  return { state, sdk, farmer, runner };
}
function floor(f: ReturnType<typeof fixture>, width: number, height: number) {
  f.state.tiles = Array.from({ length: width * height }, (_, i) => ({
    position: { x: i % width + 0.5, y: Math.floor(i / width) + 0.5 },
    isBlocking: false, damaging: false, hasConditionEffect: false,
  }));
}

describe('Lost Halls route selection and unlocks', () => {
  it.each([['void', 'The Void', 'Cultist Hideout'], ['cult', 'Cultist Hideout', 'The Void']])(
    '%s follows only its selected branch', (mode, destination, other) => {
      const f = fixture(mode), p = portal(destination), wrong = portal(other);
      f.state.portals = [wrong, p]; f.runner.tick(0); f.runner.tick(100); f.runner.tick(3000);
      expect(p.enter).toHaveBeenCalledTimes(2); expect(wrong.enter).not.toHaveBeenCalled();
    });
  it('does not enter a locked Cult trapdoor even when marked open', () => {
    const f = fixture('cult'), p = portal('Cultist Hideout', 'Locked Cultist Hideout Portal');
    f.state.portals = [p]; f.runner.tick(0);
    expect(p.enter).not.toHaveBeenCalled();
  });
  it('requires Colossus death before using the vial, and uses it once at the clear location', () => {
    const f = fixture(); const boss = mob('Marble Colossus', 10, 0.5);
    f.state.items = [-1, -1, -1, -1, 42]; f.state.enemies = [boss]; f.runner.tick(0);
    expect(f.sdk.inventory.useItem).not.toHaveBeenCalled();
    f.state.dead.add(10); f.state.enemies = []; f.runner.tick(10000); f.runner.tick(14000);
    expect(f.sdk.inventory.useItem).toHaveBeenCalledOnce();
    expect(f.sdk.inventory.useItem).toHaveBeenCalledWith(4);
    const p = portal('The Void'); f.state.portals = [p]; f.runner.tick(15000);
    expect(p.enter).toHaveBeenCalledOnce();
  });
  it('does not mistake Defender death for Colossus completion', () => {
    const f = fixture(); f.state.enemies = [mob('Marble Defender')]; f.runner.tick(0);
    f.state.enemies = []; f.state.dead.add(10); f.runner.tick(100);
    expect(f.runner.clearAt).toBeNull(); expect(f.sdk.inventory.useItem).not.toHaveBeenCalled();
  });
  it('waits for a group vial and returns to farming if no entrance opens', () => {
    const f = fixture(); f.state.enemies = [mob('Marble Colossus')]; f.runner.tick(0);
    f.state.enemies = []; f.state.dead.add(10); f.runner.tick(100);
    f.runner.tick(120000); expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    f.runner.tick(120101); expect(f.sdk.walking.nexus).toHaveBeenCalledOnce();
  });
  it('allows loot before entry but bounds an uncollectable bag detour', () => {
    const f = fixture(), p = portal('The Void'); f.state.portals = [p];
    f.farmer.handleLoot.mockReturnValue(true); f.runner.tick(0); f.runner.tick(9999);
    expect(p.enter).not.toHaveBeenCalled(); f.runner.tick(10000); expect(p.enter).toHaveBeenCalledOnce();
  });
  it('uses proximity to activate a starting pillar before shooting it', () => {
    const f = fixture(); floor(f, 12, 2);
    const pillar = mob('Lost Halls Pillar'); pillar.isTargetable = false;
    f.state.enemies = [pillar]; f.runner.tick(0);
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenCalled(); expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
    pillar.isTargetable = true; f.runner.tick(500);
    expect(f.sdk.combat.aimAt).toHaveBeenCalledWith(10); expect(f.farmer.setFiring).toHaveBeenLastCalledWith(true);
  });
});

describe('Cult flames and encounters', () => {
  it('clears treasure pots for Cult but skips them on the Void route', () => {
    for (const mode of ['cult', 'void']) {
      const f = fixture(mode); f.state.objects = [mob('Treasure Pot')]; f.runner.tick(0);
      expect(f.sdk.combat.aimAt.mock.calls.length).toBe(mode === 'cult' ? 1 : 0);
    }
  });
  it('counts flame relocation once and never counts sighting or disappearance as collection', () => {
    const f = fixture('cult'); const flame = mob('Pink Flame', 21, 0.5);
    f.state.objects = [flame]; f.runner.tick(0); f.runner.tick(1000);
    expect(f.runner.collectedFlames.size).toBe(0);
    f.state.objects = []; f.runner.tick(2000); expect(f.runner.collectedFlames.size).toBe(0);
    flame.position.x = 40; f.state.objects = [flame]; f.runner.tick(3000); f.runner.tick(4000);
    expect(f.runner.collectedFlames.size).toBe(1);
    expect(f.runner.treasureHint).toEqual(flame.position);
  });
  it('tracks three flames, the 45-second activation delay, and the Titan destination', () => {
    const f = fixture('cult'); const flames = [21, 22, 23].map((id, i) => mob('Pink Flame', id, i + 1));
    f.state.objects = flames; f.runner.tick(0);
    for (const flame of flames) flame.position = { x: 40.5, y: 40.5 };
    f.runner.tick(1000); expect(f.runner.collectedFlames.size).toBe(3);
    expect(f.runner.titanReadyAt).toBe(46000);
    expect(f.sdk.ui.status).toHaveBeenLastCalledWith(expect.stringContaining('treasure room'));
  });
  it('does not camp inactive Titan before collecting flames, but joins a group-activated Titan', () => {
    const f = fixture('cult'); const titan = mob('Agonized Titan'); titan.isTargetable = false;
    f.state.enemies = [titan]; f.runner.tick(0);
    expect(f.runner.encounter).toBeNull(); expect(f.sdk.combat.aimAt).not.toHaveBeenCalled();
    titan.isTargetable = true; f.runner.tick(500);
    expect(f.sdk.combat.aimAt).toHaveBeenCalledWith(10);
    f.state.dead.add(10); f.state.enemies = []; f.runner.tick(1000);
    const p = portal('Cultist Hideout'); f.state.portals = [p]; f.runner.tick(11000);
    expect(p.enter).toHaveBeenCalledOnce();
  });
  it('prioritizes required archdemons without declaring Cult completed on their deaths', () => {
    const f = fixture('cult', 'Cultist Hideout'); const malus = mob('Malus'); malus.isTargetable = false;
    f.state.enemies = [malus, mob('Molek', 11)]; f.runner.tick(0);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
    f.state.dead.add(11); f.state.enemies = [malus, mob('Balaam', 12)]; f.runner.tick(500);
    expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(12); expect(f.runner.terminalAt).toBeNull();
  });
  it('waits through Malus disappearance and loots only after confirmed terminal death', () => {
    const f = fixture('cult', 'Cultist Hideout'); f.state.enemies = [mob('Malus')]; f.runner.tick(0);
    f.state.enemies = []; f.runner.tick(60000); expect(f.runner.terminalAt).toBeNull();
    f.state.dead.add(10); f.runner.tick(61000); f.runner.tick(75999);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    f.runner.tick(76000); expect(f.sdk.walking.nexus).toHaveBeenCalledOnce();
  });
});

describe('Void sectors and phase actors', () => {
  it('resumes a Void Entity whose HP is restored during the completion window', () => {
    const f = fixture('void', 'The Void'), boss = mob('Void Entity');
    f.state.enemies = [boss]; f.runner.tick(0);
    boss.hp = 0; f.runner.tick(1000); expect(f.runner.terminalAt).toBe(1000);
    boss.hp = 100; f.runner.tick(2000); f.runner.tick(20000);
    expect(f.runner.terminalAt).toBeNull(); expect(f.runner.dead.has(boss.objectId)).toBe(false);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
  });
  it('does not finish after one clone dies or the remaining clone becomes hidden', () => {
    const f = fixture('void', 'The Void');
    const a = mob('Void Entity'), b = mob('Void Entity', 11);
    f.state.enemies = [a, b]; f.runner.tick(0); f.state.dead.add(10);
    f.state.enemies = [b]; f.runner.tick(1000); f.runner.tick(20000);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    f.state.enemies = []; f.runner.tick(40000); f.runner.tick(60000);
    expect(f.sdk.walking.nexus).not.toHaveBeenCalled();
    f.state.dead.add(11); f.runner.tick(61000); f.runner.tick(76000);
    expect(f.sdk.walking.nexus).toHaveBeenCalledOnce();
  });
  it('clears nearby Void adds and refuses to pursue targets across corruption', () => {
    const f = fixture('void', 'The Void'); floor(f, 12, 2);
    f.state.tiles.filter((t: any) => Math.floor(t.position.x) === 4).forEach((t: any) => { t.damaging = true; });
    f.state.enemies = [mob('Void Entity', 10, 8.5), mob('Greater Void Shade', 11, 2.5)];
    f.runner.tick(0); expect(f.sdk.combat.aimAt).toHaveBeenLastCalledWith(11);
    f.state.enemies = [mob('Void Entity', 10, 8.5)]; f.runner.tick(500);
    expect(f.sdk.combat.aimAt).not.toHaveBeenCalledWith(10);
    expect(f.sdk.dodge.navigateToPosition).not.toHaveBeenCalled();
  });
  it('refreshes connectivity after a sector splits', () => {
    const f = fixture('void', 'The Void'); floor(f, 12, 2);
    f.state.enemies = [mob('Void Entity', 10, 8.5)]; f.runner.tick(0);
    f.state.tiles.filter((t: any) => Math.floor(t.position.x) === 4).forEach((t: any) => { t.damaging = true; });
    f.runner.tick(500);
    expect(f.runner.reachable({ x: 8.5, y: 0.5 })).toBe(false);
    expect(f.farmer.setFiring).toHaveBeenLastCalledWith(false);
  });
  it('keeps exploring unseen areas when the full terrain map is already revealed', () => {
    const f = fixture(); floor(f, 40, 20); f.runner.tick(0);
    expect(f.runner.exploreGoal).not.toBeNull();
    expect(f.sdk.dodge.navigateToPosition).toHaveBeenCalled();
  });
  it('resets flames, vial use, boss coordinates and exploration between instances', () => {
    const f = fixture(); f.runner.vialUsed = true; f.runner.clearPosition = { x: 20, y: 20 };
    f.runner.treasureHint = { x: 40, y: 40 }; f.runner.collectedFlames.add(1); f.runner.branchVisits.set('1,1', 2);
    f.runner.reset('Lost Halls');
    expect(f.runner.vialUsed).toBe(false); expect(f.runner.clearPosition).toBeNull(); expect(f.runner.treasureHint).toBeNull();
    expect(f.runner.collectedFlames.size).toBe(0); expect(f.runner.branchVisits.size).toBe(0);
  });
});

describe('new Farmer package integration', () => {
  it.each([['lost-halls-void-farmer', 'void'], ['lost-halls-cult-farmer', 'cult']])(
    '%s instantiates its route and prioritizes Lost Halls portals', (folder, mode) => {
      const f = fixture(mode, 'Realm');
      const Farmer = new Function('RealmEngine', 'OryxRunner', read('farmer/index.mjs'))(f.sdk, OryxRunner);
      const Base = new Function('RealmEngine', 'Farmer', 'LostHallsRunner', read('farmer/lost-halls-farmer.mjs'))(f.sdk, Farmer, Runner);
      const Script = new Function('LostHallsFarmer', read(`${folder}/index.mjs`))(Base);
      const script = new Script(); const p = portal('Lost Halls'); f.state.portals = [p];
      script.onLoop(); expect(script.halls.mode).toBe(mode); expect(p.enter).toHaveBeenCalledOnce();
      f.state.map = 'Lost Halls'; f.state.portals = []; script.onLoop(); expect(script.halls.stage).toBe('halls');
      f.state.map = 'Nexus'; script.resetMap('Nexus'); expect(script.halls.stage).toBeNull();
    });
  it('collects a vial even though it is neither equipment nor a stat potion', () => {
    const f = fixture('cult');
    const Farmer = new Function('RealmEngine', 'OryxRunner', read('farmer/index.mjs'))(f.sdk, OryxRunner);
    const Base = new Function('RealmEngine', 'Farmer', 'LostHallsRunner', read('farmer/lost-halls-farmer.mjs'))(f.sdk, Farmer, Runner);
    const script = new Base('cult');
    const bag = { objectId: 90, rarity: 'blue', position: f.state.position, items: [{ slotIndex: 2, objectType: 42 }] };
    f.sdk.loot.getNearbyBags.mockReturnValue([bag]);
    expect(script.bagIsUseful(bag)).toBe(true); script.handleLoot(10000);
    expect(f.sdk.loot.pickup).toHaveBeenCalledWith(bag, 2, { useBackpack: true });
  });
});
