import { describe, expect, it } from 'vitest';
import { World, RealmEngine } from '@realmengine/sdk';
import { BridgeWorld } from '../World.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

describe('World map dimensions', () => {
  it('reads full dimensions from the current connection and clears them on disconnect', () => {
    const clientRef = { current: { playerData: { mapWidth: 2048, mapHeight: 1024 } } as any };
    BridgeWorld.install({ clientRef } as BridgeDeps);
    expect(RealmEngine.world.getSize()).toEqual({ width: 2048, height: 1024 });
    clientRef.current = { playerData: { mapWidth: 800, mapHeight: 600 } };
    expect(RealmEngine.world.getSize()).toEqual({ width: 800, height: 600 });
    clientRef.current = undefined;
    expect(RealmEngine.world.getSize()).toEqual({ width: 0, height: 0 });
  });
});
