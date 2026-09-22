import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async original => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => null), getDllGround: vi.fn(() => null),
}));
import { getDllGround, getDllThreats, getDllThreatsAgeMs } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

function replay() {
  vi.mocked(getDllThreats).mockReturnValue([]);
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(null);
  const state = fixture();
  state.settings.get('ForceAutoNexusHealth')!(10);
  state.settings.get('BurstGuard')!(false);
  state.hp(800);
  state.enemyShoot(5001, 7, 0, 450, 2);
  vi.advanceTimersByTime(200);
  return state;
}

function scan(ageMs: number, hitMs = 150, bullets = [7, 8]) {
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(ageMs);
  vi.mocked(getDllThreats).mockReturnValue(bullets.map(bulletId => ({
    attackerObjId: 5001, bulletId, tHitMs: hitMs, fallbackDamage: 450, fallbackArmorPiercing: true,
  })));
}

describe('synthetic forecast policy replays, not current-game acceptance', () => {
  it.each([99, 100, 101])('honors the actual scan-age boundary at %s ms', ageMs => {
    const state = replay(); scan(ageMs); vi.advanceTimersByTime(20);
    if (ageMs <= 100) {
      expect(state.observation()).toMatchObject({ predictedHp: -100, lethal: true });
      expect(state.escapes()).toBe(1);                       // prediction active by default (owner decision 2026-09-22)
    } else {
      expect(state.observation()).toBeNull();
      expect(state.escapes()).toBe(0);
    }
  });

  it('distinguishes threshold crossing from a combined lethal volley', () => {
    const state = replay();
    state.settings.get('ForceAutoNexusHealth')!(40);
    state.enemyShoot(5001, 20, 0, 500);
    scan(20, 100, [20]); vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ predictedHp: 300, effectiveThreshold: 400, thresholdCrossed: true, lethal: false });
    expect(state.escapes()).toBe(1);                         // crossing the threshold is enough to act
    scan(20, 100); vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ predictedHp: -100, thresholdCrossed: true, lethal: true });
    expect(state.escapes()).toBe(1);                         // latched: the volley adds no second send
  });

  it('does not double-count a ledger hit or duplicate scan identity', () => {
    const state = replay(); state.playerHit(7, 5001);
    scan(20, 100, [7, 8, 8]); vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ pendingDamage: 450, predictedHp: -100 });
  });

  it.each([null, 500, NaN])('discards unavailable, stalled or invalid scan age %s', ageMs => {
    const state = replay(); scan(20); vi.mocked(getDllThreatsAgeMs).mockReturnValue(ageMs);
    vi.advanceTimersByTime(20); expect(state.observation()).toBeNull();
  });

  it('ages elapsed impacts without refreshing old scans', () => {
    const state = replay(); scan(100, 67); vi.advanceTimersByTime(20);
    expect(state.observation()).toBeNull();
    scan(100, 68); vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ lethal: true });
  });

  it('rejects stale native scans after a new character generation even if IDs match', () => {
    const state = replay(); scan(50, 100);
    state.client.admission.generation = state.client.recovery.beginGeneration();
    state.emit('CREATESUCCESS'); state.hp(800); state.enemyShoot(5001, 7, 0, 450, 2);
    vi.advanceTimersByTime(20);
    expect(state.observation()).toBeNull();
  });

  it.each(['missing', 'disagreeing'])('records %s server-anchor provenance as ambiguous but still acts on packet-recorded bullets', provenance => {
    const state = replay(); scan(20, 100);
    state.client.playerData.position = provenance === 'missing' ? undefined : { x: 9999, y: -9999 };
    vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ sourceCertainty: 'ambiguous', mode: 'active' });
    expect(state.escapes()).toBe(1);
  });

  it('ground/AoE geometry and XML-only damage never count; a numeric fallback does', () => {
    const state = replay();
    state.enemy(7001, 0x9999, 'Synthetic fixture', { 0: { damage: 30000 } });
    vi.mocked(getDllGround).mockReturnValue({ rawDamage: 30000, tHitMs: 0, events: [] });
    scan(20, 100, [999]);
    vi.advanceTimersByTime(20);
    expect(state.observation()).toMatchObject({ predictedHp: 350 });   // bullet 999 charged at the fallback 450
    expect(getDllGround).not.toHaveBeenCalled();
    expect(state.escapes()).toBe(0);                                   // 350 > the 100 HP point
  });
});
