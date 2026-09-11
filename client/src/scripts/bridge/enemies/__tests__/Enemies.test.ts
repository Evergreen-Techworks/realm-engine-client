import { GameWorldState } from '../../../../state/GameWorldState.js';
import { afterEach, expect, it, vi } from 'vitest';
import { Enemies } from '@realmengine/sdk';
import { BridgeEnemies } from '../Enemies.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { StatType } from '../../../../constants/StatType.js';
import { ConditionEffect } from '../../../../constants/ConditionEffect.js';

afterEach(() => vi.useRealTimers());
it('reports both Oryx guard animations without declaring the target invulnerable', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const row = { objectId: 5, objectType: 45363, lastUpdate: 10000, pos: { x: 1, y: 1 },
    stats: { [StatType.HP]: 100, 125: -935464302 } };
  BridgeEnemies.install({ clientRef: { current: { connected: true } },
    worldState: { getEntity: () => row },
    gameData: { getObjectCategory: () => 'Enemy', getObject: () => ({ id: 'Oryx' }), isBoss: () => true },
  } as unknown as BridgeDeps);
  expect(Enemies.getById(5)).toMatchObject({ isGuarding: true, isTargetable: true, animation: -935464302 });
  row.stats[125] = -918686683;
  expect(Enemies.getById(5)?.isGuarding).toBe(true);
  row.stats[125] = 0;
  expect(Enemies.getById(5)?.isGuarding).toBe(false);
  row.stats[125] = -935464302; row.objectType = 1;
  expect(Enemies.getById(5)?.isGuarding).toBe(false);
});
it('excludes stale and invisible targets through every enemy lookup and accepts fresh updates', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const make = (id: number, lastUpdate: number, effects = 0) => ({ objectId: id, objectType: 1,
    lastUpdate, pos: { x: id, y: 0 }, stats: { [StatType.HP]: 100, [StatType.Effects]: effects } });
  const rows = [make(1, 1000), make(2, 10000, 1 << ConditionEffect.Invisible), make(3, 10000)];
  const client = { connected: true, playerData: { pos: { x: 0, y: 0 } } };
  BridgeEnemies.install({ clientRef: { current: client },
    worldState: { getEntity: (id: number) => rows.find(r => r.objectId === id), getEnemiesMatching: () => rows },
    gameData: { getObjectCategory: () => 'Enemy', getObject: () => ({ id: 'Mob' }), isBoss: () => false },
  } as unknown as BridgeDeps);
  expect(Enemies.getAll().map(e => e.objectId)).toEqual([3]);
  expect(Enemies.getNearest()?.objectId).toBe(3);
  expect(Enemies.getById(1)).toBeNull(); expect(Enemies.getById(2)).toBeNull();
  rows[0].lastUpdate = 10000;
  expect(Enemies.getById(1)?.objectId).toBe(1);
  vi.setSystemTime(14000); expect(Enemies.getAll()).toEqual([]);
  client.connected = false; rows[0].lastUpdate = 14000;
  expect(Enemies.getById(1)).toBeNull();
});

it('retains stationary bosses across delta ticks, clears invulnerability, and removes confirmed deaths', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const world = new GameWorldState();
  const hooks = new Map<string, any>();
  world.attach({ hookPacket: (name: string, hook: any) => hooks.set(name,hook) } as any);
  const client = { connected: true, playerData: { pos: { x: 0, y: 0 }, mapName: 'Realm' } };
  const emit = (name: string, data: any) => hooks.get(name)(client,{ isDefined: true, data });
  BridgeEnemies.install({ clientRef: { current: client }, worldState: world,
    gameData: { getObjectCategory: () => 'Enemy', getObject: () => ({ id: 'Scorpion Queen', maxHp: 1000 }),
      isBoss: () => true },
  } as unknown as BridgeDeps);
  emit('UPDATE',{ newObjs: [{ objectType: 1, status: { objectId: 5, position: { x: 3,y: 0 },
    data: [{ id: StatType.HP,value: 1000 },{ id: StatType.Effects,value: 1 << ConditionEffect.Invulnerable }] } }] });
  expect(Enemies.getById(5)?.isTargetable).toBe(false);
  vi.setSystemTime(20000); emit('NEWTICK',{ statuses: [] });
  expect(Enemies.getAll().map(e => e.objectId)).toEqual([5]);
  emit('NEWTICK',{ statuses: [{ objectId: 5, data: [{ id: StatType.Effects,value: 0 }] }] });
  expect(Enemies.getById(5)?.isTargetable).toBe(true);
  emit('DAMAGE',{ targetId: 5,kill: true });
  expect(Enemies.getById(5)).toBeNull(); expect(Enemies.getAll()).toEqual([]);
  emit('NEWTICK',{ statuses: [{ objectId: 5,data: [{ id: StatType.HP,value: 500 }] }] });
  expect(Enemies.getById(5)?.isTargetable).toBe(true);
  emit('UPDATE',{ drops: [5] });
  expect(Enemies.getById(5)).toBeNull();
  vi.setSystemTime(24000); expect(world.isSnapshotFresh(3000)).toBe(false);
  world.clear(); expect(world.isSnapshotFresh(3000)).toBe(false);
});
