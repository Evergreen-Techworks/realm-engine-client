import { describe, expect, it, vi } from 'vitest';
import { World } from '@realmengine/sdk';
import { WorldObjectService } from '../WorldObjectService.js';
import { BridgeWorld } from '../World.js';
import { initialAdmission, reduceAdmission, type AdmissionSnapshot, type AdmissionPhase } from '../../../../proxy/ConnectionAdmission.js';
import type { BridgeDeps } from '../../BridgeDeps.js';

function fixture() {
  const sendToServer = vi.fn();
  const entity = { objectId: 7, objectType: 9, pos: { x: 0, y: 0 }, stats: {} };
  const client = { connected: true, admission: { ...initialAdmission(), generation: 1, phase: 'loaded' } as AdmissionSnapshot, sendToServer, playerData: { pos: { x: 0, y: 0 } }, lastAttemptedPortalId: null as number | null };
  const clientRef = { current: client };
  const createByName = vi.fn(() => ({ data: {}, modified: false }));
  const deps = { clientRef, proxy: { packetFactory: { createByName } }, worldState: { getEntity: () => entity }, gameData: { getObject: () => ({ id: 'Portal', dungeonName: 'Realm' }), getObjectCategory: () => 'Portal' } } as unknown as BridgeDeps;
  return { client, clientRef, deps, entity, createByName, sendToServer, service: new WorldObjectService(deps) };
}

describe('portal admission bridge', () => {
  it.each(['queued', 'admission-pending', 'connecting', 'cancelled', 'dead', 'terminal', 'disconnected'])('blocks %s without creating a packet', phase => {
    const test = fixture();
    test.client.admission.phase = phase as AdmissionPhase;
    expect(test.service.toPortal(test.entity as any)!.enter()).toBe(false);
    expect(test.createByName).not.toHaveBeenCalled();
  });
  it('invalidates stale closures on generation and client replacement', () => {
    const test = fixture();
    const portal = test.service.toPortal(test.entity as any)!;
    test.client.admission.generation++;
    expect(portal.enter()).toBe(false);
    const newer = test.service.toPortal(test.entity as any)!;
    test.clientRef.current = { ...test.client };
    expect(newer.enter()).toBe(false);
    expect(test.sendToServer).not.toHaveBeenCalled();
  });
  it('blocks a verified refused portal until expiry, permits another and one retry', () => {
    const test = fixture();
    test.client.admission = reduceAdmission(test.client.admission as any, { type: 'portal-refused', generation: 1, portalId: 7, retryAt: Date.now() + 1000, reason: 'verified-full' });
    expect(test.service.toPortal(test.entity as any)!.enter()).toBe(false);
    expect(test.service.toPortal({ ...test.entity, objectId: 8 } as any)!.enter()).toBe(true);
    test.client.lastAttemptedPortalId = null;
    test.client.admission.retryAt = Date.now() - 1;
    const portal = test.service.toPortal(test.entity as any)!;
    expect(portal.enter()).toBe(true);
    expect(portal.enter()).toBe(false);
    expect(test.sendToServer).toHaveBeenCalledTimes(2);
  });
  it('returns a copied connection status and null without a client', () => {
    const test = fixture();
    BridgeWorld.install(test.deps);
    const status = World.getConnectionStatus()!;
    expect(status.phase).toBe('loaded');
    status.phase = 'dead';
    expect(test.client.admission.phase).toBe('loaded');
    (test.clientRef as any).current = null;
    expect(World.getConnectionStatus()).toBeNull();
  });
});
