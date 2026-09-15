import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async original => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => null),
}));
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('AutoNexus uses the process-wide recovery lifecycle', () => {
  it('preserves raw DAMAGE including opaque tail and updates acknowledged observation debt', () => {
    const state = fixture();
    state.hp(800); state.enemyShoot(5001, 7, 0, 100); state.playerHit(7, 5001);
    state.damage(7, 5001, 100);
    expect(state.observation()).toMatchObject({ pendingDamage: 0, predictedHp: 700 });
  });
  it('routes manual and confirmed escape through one accepted recovery request', () => {
    const state = fixture();
    const request = vi.spyOn(state.client.recovery, 'requestEscape');
    state.hp(100);
    state.commands.get('nexus')!(state.client);
    expect(request).toHaveBeenCalled();
    expect(state.escapes()).toBe(1);
    vi.advanceTimersByTime(400);
    expect(state.escapes()).toBe(2);
  });

  it('does not schedule plugin-owned retry after synchronous close during initial send', () => {
    const state = fixture();
    state.client.sendToServer.mockImplementationOnce(() => {
      state.client.connected = false;
      state.client.recovery.dispose();
    });
    state.hp(100);
    const timers = vi.getTimerCount();
    expect(timers).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(state.escapes()).toBe(1);
  });

  it.each(['reconnect', 'character', 'disable', 'cleanup'])('cancels retries on %s', lifecycle => {
    const state = fixture();
    state.hp(100);
    if (lifecycle === 'reconnect') state.client.recovery.acceptReconnect(state.client.admission.generation);
    if (lifecycle === 'character') {
      state.client.admission.generation = state.client.recovery.beginGeneration();
      state.emit('CREATESUCCESS');
    }
    if (lifecycle === 'disable') state.disable();
    if (lifecycle === 'cleanup') for (const cleanup of state.cleanup) cleanup();
    vi.advanceTimersByTime(5000);
    expect(state.escapes()).toBe(1);
  });

  it('keeps retries when first send or notification throws without double initial sends', () => {
    const state = fixture();
    state.client.sendToServer.mockImplementationOnce(() => { throw new Error('synthetic send failure'); });
    state.ctx.sendNotification.mockImplementation(() => { throw new Error('synthetic notification failure'); });
    expect(() => state.hp(100)).not.toThrow();
    state.commands.get('nexus')!(state.client);
    vi.advanceTimersByTime(400);
    expect(state.escapes()).toBe(2);
    expect(state.ctx.sendNotification).toHaveBeenCalledWith(state.client, 'AutoNexus', expect.stringContaining('Escape requested'));
  });

  it('retains bounded generation-tagged transition evidence across MAPINFO and CREATESUCCESS', () => {
    const state = fixture();
    state.hp(100);
    const oldGeneration = state.client.admission.generation;
    state.emit('RECONNECT');
    state.emit('MAPINFO', { name: 'Nexus' });
    state.emit('CREATESUCCESS');
    expect(state.transitions()).toEqual([
      expect.objectContaining({ kind: 'escape-requested', generation: oldGeneration }),
      expect.objectContaining({ kind: 'reconnect', generation: oldGeneration }),
      expect.objectContaining({ kind: 'mapinfo', generation: state.client.admission.generation }),
    ]);
    expect(state.observation()).toBeNull();
    for (let index = 0; index < 100; index++) state.emit('MAPINFO', { name: 'Nexus' });
    expect(state.transitions()).toHaveLength(32);
  });
});
