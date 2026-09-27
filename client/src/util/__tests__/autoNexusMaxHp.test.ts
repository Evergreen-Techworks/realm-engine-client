import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []),
  getDllThreatsAgeMs: vi.fn(() => null),
  getDllGround: vi.fn(() => null),
}));
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

// Recordings 20260925-encounter-context, 33 runs: HP never exceeded stat 3
// (MaxHP) and reached it at full health, while `effectiveMaxHealth` (stat 3 plus
// the stat-46 boost again) read 775 for a 675-HP character (022132..024713) and
// 325 for a 350-HP one (181811). Stat 3 already includes the boost.
describe('AutoNexus maximum HP', () => {
  it('uses the real maximum (stat 3), not stat 3 plus the boost again', () => {
    const f = fixture({ allowActivePredictionForTests: true });
    f.settings.get('ForceAutoNexusHealth')!(10);
    f.settings.get('BurstGuard')!(false);
    f.client.playerData.maxHealth = 675;
    f.client.playerData.effectiveMaxHealth = 775;
    f.hp(70);                                    // 10% of 675 = 67.5: not yet
    expect(f.escapes()).toBe(0);
    f.hp(67);
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('confirmed HP=67/675');
  });

  it('uses the real maximum when the boost made the derived value lower (181811: 350 vs 325)', () => {
    const f = fixture({ allowActivePredictionForTests: true });
    f.settings.get('ForceAutoNexusHealth')!(10);
    f.settings.get('BurstGuard')!(false);
    f.client.playerData.maxHealth = 350;
    f.client.playerData.effectiveMaxHealth = 325;
    f.hp(34);                                    // 10% of 350 = 35: escape; of 325 = 32.5: would not
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('/350');
  });
});
