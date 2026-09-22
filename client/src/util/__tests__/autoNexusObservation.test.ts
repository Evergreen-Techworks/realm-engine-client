import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async original => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => 0), getDllGround: vi.fn(() => null),
}));
import { getDllThreats, sendDllFeature } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

// Owner decision 2026-09-22: prediction is ACTIVE by default again. The old
// gate — no mode could ever enable a prediction-origin ESCAPE — is reversed;
// Observe and Off keep their refusal, and the native tile predictor and debug
// overlay stay off in every mode.
describe('prediction-origin ESCAPE gate', () => {
  it.each(['fresh default', 'explicit active'])('%s sends ESCAPE from the forecast layer', mode => {
    const fixtureState = fixture();
    fixtureState.settings.get('BurstGuard')!(false);
    if (mode !== 'fresh default') fixtureState.settings.get('PredictiveNexusMode')!('active');
    fixtureState.hp(800);
    fixtureState.enemyShoot(5001, 7, 0, 900);
    vi.mocked(getDllThreats).mockReturnValue([{ attackerObjId: 5001, bulletId: 7, tHitMs: 50,
      fallbackDamage: 900, fallbackArmorPiercing: true }]);
    vi.advanceTimersByTime(20);
    expect(fixtureState.escapes()).toBe(1);
    expect(fixtureState.escapeLog().some(l => l.includes('layer=forecast'))).toBe(true);
    expect(sendDllFeature).not.toHaveBeenCalledWith('autoNexusDebugDraw', true);   // the overlay never arms
  });

  it.each(['observe', 'off'])('%s cannot enable prediction-origin ESCAPE', mode => {
    const fixtureState = fixture();
    fixtureState.settings.get('BurstGuard')!(false);
    fixtureState.settings.get('PredictiveNexusMode')!(mode);
    fixtureState.hp(800);
    fixtureState.enemyShoot(5001, 7, 0, 900);
    vi.mocked(getDllThreats).mockReturnValue([{ attackerObjId: 5001, bulletId: 7, tHitMs: 50,
      fallbackDamage: 900, fallbackArmorPiercing: true }]);
    vi.advanceTimersByTime(20);
    fixtureState.playerHit(7, 5001);
    vi.advanceTimersByTime(500);
    expect(fixtureState.escapes()).toBe(0);
    fixtureState.hp(0);
    expect(fixtureState.escapes()).toBe(1);
    expect(sendDllFeature).not.toHaveBeenCalledWith('autoNexusDebugDraw', true);   // the overlay never arms
  });

  it('legacy PredictiveNexusForecast=true alone does not switch the mode', () => {
    const fixtureState = fixture();
    fixtureState.settings.get('PredictiveNexusMode')!('observe');
    fixtureState.settings.get('PredictiveNexusForecast')!(true);
    fixtureState.hp(800);
    fixtureState.enemyShoot(5001, 7, 0, 900);
    vi.mocked(getDllThreats).mockReturnValue([{ attackerObjId: 5001, bulletId: 7, tHitMs: 50,
      fallbackDamage: 900, fallbackArmorPiercing: true }]);
    vi.advanceTimersByTime(20);
    expect(fixtureState.escapes()).toBe(0);
  });
});
