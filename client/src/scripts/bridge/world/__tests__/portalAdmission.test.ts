import { afterEach, describe, expect, it, vi } from 'vitest';
import { World } from '@realmengine/sdk';
import { WorldObjectService } from '../WorldObjectService.js';
import { BridgeWorld } from '../World.js';
import { initialAdmission, reduceAdmission, type AdmissionSnapshot, type AdmissionPhase } from '../../../../proxy/ConnectionAdmission.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { Logger } from '../../../../util/Logger.js';

function fixture() {
  const sendToServer = vi.fn();
  const entity = { objectId: 7, objectType: 9, pos: { x: 0, y: 0 }, stats: {} };
  const client = {
    connected: true,
    admission: { ...initialAdmission(), generation: 1, phase: 'loaded' } as AdmissionSnapshot,
    sendToServer,
    playerData: { pos: { x: 0, y: 0 } },
    lastAttemptedPortalId: null as number | null,
    lastPortalAttemptAt: 0,
    portalAttemptObjectId: null as number | null,
    portalAttemptCount: 0,
    portalDropLogAt: {} as Record<string, number>,
  };
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
    // Simulate the 3 s send-pacing floor having already elapsed (a real caller
    // relying on the latch's own 5 s timeout, or a fresh min-send-interval window,
    // would naturally clear this — this test isolates the refusal-expiry behaviour).
    test.client.lastPortalAttemptAt = 0;
    test.client.admission.retryAt = Date.now() - 1;
    const portal = test.service.toPortal(test.entity as any)!;
    expect(portal.enter()).toBe(true);
    expect(portal.enter()).toBe(false);
    expect(test.sendToServer).toHaveBeenCalledTimes(2);
  });
  describe('unanswered-attempt expiry and send pacing', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    it('lets a retry through once an unanswered attempt has been pending 5 s, and logs the send', () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      vi.spyOn(Logger, 'log').mockImplementation((m: string, msg: string) => { logs.push(`[${m}] ${msg}`); });
      const test = fixture();
      const portal = test.service.toPortal(test.entity as any)!;
      expect(portal.enter()).toBe(true);
      expect(test.sendToServer).toHaveBeenCalledTimes(1);
      // The server never answers: no map-loaded, no portal-refused arrives.
      expect(portal.enter()).toBe(false);
      vi.advanceTimersByTime(4999);
      expect(portal.enter()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(portal.enter()).toBe(true);
      expect(test.sendToServer).toHaveBeenCalledTimes(2);
      expect(logs).toContain('[Portal] USEPORTAL sent objectId=7 attempt=1');
      expect(logs).toContain('[Portal] USEPORTAL sent objectId=7 attempt=2');
    });
    it('never sends more than one USEPORTAL per 3 s even if the latch clears early', () => {
      vi.useFakeTimers();
      const test = fixture();
      const portal = test.service.toPortal(test.entity as any)!;
      expect(portal.enter()).toBe(true);
      // Simulate the latch clearing early (a real 'map-loaded'/'portal-refused' event).
      test.client.lastAttemptedPortalId = null;
      vi.advanceTimersByTime(2999);
      expect(portal.enter()).toBe(false);
      expect(test.sendToServer).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(portal.enter()).toBe(true);
      expect(test.sendToServer).toHaveBeenCalledTimes(2);
    });
    it('rate-limits repeated drop logging for the same reason to once per 10 s', () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      vi.spyOn(Logger, 'log').mockImplementation((m: string, msg: string) => { logs.push(`[${m}] ${msg}`); });
      const test = fixture();
      test.client.admission.phase = 'connecting' as AdmissionPhase;
      const portal = test.service.toPortal(test.entity as any)!;
      expect(portal.enter()).toBe(false);
      expect(portal.enter()).toBe(false);
      vi.advanceTimersByTime(9999);
      expect(portal.enter()).toBe(false);
      const dropLines = () => logs.filter((l) => l.includes('USEPORTAL drop'));
      expect(dropLines()).toEqual(['[Portal] USEPORTAL drop objectId=7 reason=phase=connecting']);
      vi.advanceTimersByTime(1);
      expect(portal.enter()).toBe(false);
      expect(dropLines()).toHaveLength(2);
    });
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
