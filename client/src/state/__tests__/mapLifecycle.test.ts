import { describe, it, expect, vi } from 'vitest';
import { StateManager } from '../StateManager.js';
import { PlayerData } from '../PlayerData.js';
import { GameWorldState } from '../GameWorldState.js';
import type { Proxy } from '../../proxy/Proxy.js';

vi.mock('../../util/Logger.js', () => ({ Logger: { log: vi.fn() } }));
function hooksFor(state: StateManager | GameWorldState) {
  const hooks = new Map<string, (c: any, p: any) => void>();
  state.attach({ hookPacket: (name: string, hook: any) => hooks.set(name, hook) } as unknown as Proxy);
  return (name: string, client: any, data: any) => hooks.get(name)!(client, { isDefined: true, data });
}

describe('map lifecycle', () => {
  it('preserves MAPINFO across player creation while clearing character state', () => {
    const emit = hooksFor(new StateManager());
    const c: any = { playerData: new PlayerData() };
    emit('MAPINFO', c, { name: 'Realm of the Mad God', width: 2048, height: 2048, allowPlayerTeleport: true });
    c.playerData.health = 999; c.playerData.inventory[0] = 123;
    emit('CREATESUCCESS', c, { objectId: 42 });
    expect(c.playerData).toMatchObject({ mapName: 'Realm of the Mad God', mapWidth: 2048, mapHeight: 2048, teleportAllowed: true, ownerObjectId: 42, health: 0 });
    expect(c.playerData.inventory[0]).toBe(-1);
    emit('MAPINFO', c, { name: "Oryx's Castle", width: 256, height: 256, allowPlayerTeleport: false });
    emit('CREATESUCCESS', c, { objectId: 43 });
    expect(c.playerData).toMatchObject({ mapName: "Oryx's Castle", mapWidth: 256, mapHeight: 256, teleportAllowed: false });
  });
  it('supports player creation before MAPINFO without granting teleport early', () => {
    const emit = hooksFor(new StateManager()); const c: any = { playerData: new PlayerData() };
    emit('CREATESUCCESS', c, { objectId: 42 });
    expect(c.playerData.teleportAllowed).toBe(false);
    emit('MAPINFO', c, { name: 'Realm', width: 2048, height: 2048, allowPlayerTeleport: true });
    expect(c.playerData.teleportAllowed).toBe(true);
  });
});

describe('local tile queries', () => {
  it('returns the same bounded tiles for dense and sparse maps, including type zero', () => {
    const world = new GameWorldState();
    const emit = hooksFor(world);
    const c: any = { playerData: new PlayerData(), state: {} };
    const tiles = Array.from({ length: 10000 }, (_, i) => ({ x: i % 100, y: Math.floor(i / 100), type: i % 3 }));
    emit('UPDATE', c, { tiles, newObjects: [], drops: [] });
    const rows: number[][] = [];
    world.forEachKnownTileInBounds(10, 12, 20, 22, (x, y, t) => rows.push([x, y, t]));
    expect(rows).toHaveLength(9);
    expect(rows).toContainEqual([10, 20, 0]);
    expect(rows.every(([x, y]) => x >= 10 && x <= 12 && y >= 20 && y <= 22)).toBe(true);
    const large: number[][] = [];
    world.forEachKnownTileInBounds(-1, 101, -1, 101, (x, y, t) => large.push([x, y, t]));
    expect(large).toHaveLength(10000);
    world.clear();
    world.forEachKnownTileInBounds(10, 12, 20, 22, () => { throw new Error('stale tile'); });
  });
});

it('retains confirmed deaths across stream-out, but never treats an ordinary drop as a kill', () => {
  const world = new GameWorldState(); const emit = hooksFor(world);
  const c: any = { playerData: new PlayerData(), state: {} };
  emit('DAMAGE', c, { targetId: 40, kill: true });
  emit('UPDATE', c, { drops: [40, 41] });
  expect(world.isObjectDead(40)).toBe(true);
  expect(world.isObjectDead(41)).toBe(false);
  emit('UPDATE', c, { newObjs: [{ objectType: 1, status: { objectId: 40, position: { x: 1, y: 1 }, data: [] } }] });
  expect(world.isObjectDead(40)).toBe(false); // explicit instance re-creation
  emit('DAMAGE', c, { targetId: 40, kill: true });
  emit('MAPINFO', c, {});
  expect(world.isObjectDead(40)).toBe(false);
});
