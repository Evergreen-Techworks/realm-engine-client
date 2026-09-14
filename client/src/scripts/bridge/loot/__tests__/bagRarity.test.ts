import { describe, expect, it, vi } from 'vitest';
import { loot } from '@realmengine/sdk';
import { install } from '../index.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

// Bag ids are objects.xml `type`s; each colour is the bag's lofiObj4 sprite
// sampled from mapObjects.png (RotMG 86ad651b).
const BAGS: Array<[string, string, number]> = [
  ['Loot Bag 5 (dark blue)', 'blue', 0x050b],
  ['Loot Bag 5 Boost (dark blue)', 'blue', 0x06be],
  ['Loot Bag 7 (gold)', 'blue', 0x050e],
  ['Loot Bag 7 Boost (gold)', 'blue', 0x06bc],
  ['Loot Bag 8 (orange)', 'blue', 0x050f],
  ['Loot Bag 8 Boost (orange)', 'blue', 0x06bf],
  ['Loot Bag 9 (red)', 'blue', 0x06ac],
  ['Loot Bag 9 Boost (red)', 'blue', 0x06c0],
  ['Loot Bag 6 (white)', 'white', 0x050c],
  ['Loot Bag 6 Boost (white)', 'white', 0x0510],
];

const entities = new Map<number, { pos: { x: number; y: number }; stats: Record<string, number> }>();
const hooks = new Map<string, (client: unknown, packet: unknown) => void>();
install({
  clientRef: { current: undefined },
  worldState: { getEntity: (id: number) => entities.get(id) ?? null },
  gameData: { getAllObjects: () => [], getObject: () => undefined },
  proxy: { hookPacket: vi.fn((name: string, fn: any) => hooks.set(name, fn)), packetFactory: { createByName: vi.fn() } },
} as unknown as BridgeDeps);

describe('loot bag rarity', () => {
  it.each(BAGS)('%s is labelled %s', (_name, rarity, bagType) => {
    const objectId = 7000 + bagType;
    entities.set(objectId, { pos: { x: 0, y: 0 }, stats: { '8': 0xa17 } });
    hooks.get('UPDATE')!({}, {
      isDefined: true,
      data: { newObjs: [{ objectType: bagType, status: { objectId, position: { x: 0, y: 0 }, data: [{ id: 8, value: 0xa17 }] } }] },
    });
    expect(loot.getBags().find((bag) => bag.objectId === objectId)?.rarity).toBe(rarity);
  });
});
