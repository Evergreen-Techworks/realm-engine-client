import { describe, expect, it } from 'vitest';
import type { BridgeDeps } from '../../BridgeDeps.js';
import type { TrackedEntity } from '../../../../state/GameWorldState.js';
import { WorldObjectService } from '../WorldObjectService.js';

function makeService(): WorldObjectService {
  const entities: TrackedEntity[] = [
    { objectId: 10, objectType: 0x072f, pos: { x: 1, y: 1 }, lastUpdate: 1 },
    { objectId: 20, objectType: 0x0704, pos: { x: 5, y: 5 }, lastUpdate: 1 },
  ];
  const defs = new Map<number, Record<string, unknown>>([
    [0x072f, { id: 'Guild Hall Portal', displayId: '', dungeonName: 'Guild Hall' }],
    [0x0704, { id: 'Realm Portal', displayId: '', dungeonName: '' }],
  ]);
  const deps = {
    clientRef: { current: { connected: true, playerData: { pos: { x: 0, y: 0 } } } },
    worldState: {
      getEntitiesSnapshot: () => entities,
      getEntity: (id: number) => entities.find((entity) => entity.objectId === id),
    },
    gameData: {
      getObject: (type: number) => defs.get(type),
      getObjectCategory: (type: number) => defs.has(type) ? 'Portal' : 'Other',
    },
    proxy: {
      packetFactory: { createByName: () => ({ data: {}, modified: false }) },
    },
  } as unknown as BridgeDeps;
  return new WorldObjectService(deps);
}

describe('WorldObjectService portals', () => {
  it('projects portals as complete SDK game objects with destinations', () => {
    const [guild, realm] = makeService().portals();
    expect(guild).toMatchObject({
      objectId: 10,
      objectType: 0x072f,
      name: 'Guild Hall Portal',
      destination: 'Guild Hall',
      isRealm: false,
    });
    expect(realm).toMatchObject({
      objectId: 20,
      objectType: 0x0704,
      name: 'Realm Portal',
      destination: 'Realm',
      isRealm: true,
    });
  });

  it('never treats the Guild Hall portal type as a Realm entrance', () => {
    expect(makeService().portals().filter((portal) => portal.isRealm).map((portal) => portal.objectType))
      .toEqual([0x0704]);
  });
});
