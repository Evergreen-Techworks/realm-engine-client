import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async original => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => 0), getDllGround: vi.fn(() => null),
}));
import { getDllThreats, sendDllFeature } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('production observation-only prediction gate', () => {
  it.each(['fresh', 'legacy-true', 'active', 'observe', 'off'])('%s cannot enable prediction-origin ESCAPE', mode => {
    const fixtureState = fixture();
    fixtureState.settings.get('BurstGuard')!(false);
    if (mode === 'legacy-true') fixtureState.settings.get('PredictiveNexusForecast')!(true);
    if (['active', 'observe', 'off'].includes(mode)) fixtureState.settings.get('PredictionMode')!(mode);
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
    expect(sendDllFeature).not.toHaveBeenCalledWith('autoNexusTilePredict', true);
    expect(sendDllFeature).not.toHaveBeenCalledWith('autoNexusDebugDraw', true);
  });
});
