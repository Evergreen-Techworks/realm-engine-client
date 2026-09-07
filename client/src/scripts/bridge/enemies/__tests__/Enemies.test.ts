import { afterEach, expect, it, vi } from 'vitest';
import { Enemies } from '@realmengine/sdk';
import { BridgeEnemies } from '../Enemies.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { StatType } from '../../../../constants/StatType.js';
import { ConditionEffect } from '../../../../constants/ConditionEffect.js';

afterEach(() => vi.useRealTimers());
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
