/**
 * The #52 coverage port (owner decision 2026-09-22, option C): ground-damage
 * awareness, AoE tracking from the server's own AOE packets, the method_29
 * regen model, and the unknown-bullet PLAYERHIT charge — all on the v2
 * accounting. The v2 rules that survive: packets are never held, dropped or
 * modified; per-shot ambiguity still refuses that shot; no native ESCAPE.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []),
  getDllThreatsAgeMs: vi.fn(() => 0),
  getDllGround: vi.fn(() => null),
}));
import { getDllGround, getDllThreats, getDllThreatsAgeMs, sendDllFeature as sendDllFeatureExports } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

beforeEach(() => {
  vi.mocked(getDllThreats).mockReturnValue([]);
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(0);
  vi.mocked(getDllGround).mockReturnValue(null);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

function scan(threats: unknown[], ground: unknown = null): void {
  vi.mocked(getDllThreats).mockReturnValue(threats as any[]);
  vi.mocked(getDllGround).mockReturnValue(ground as any);
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(10);
}
function atPlayer(f: ReturnType<typeof fixture>): void {
  f.entityTypes.set(1, 0x0631);                    // the player's own entity
  f.entityPos.set(1, { x: 10, y: 10 });
}

// ── Ground damage ───────────────────────────────────────────────────────────

it('charges a native ground-damage forecast and arms the native tile predictor by default', () => {
  const f = fixture(); f.hp(500);
  scan([], { rawDamage: 300, tHitMs: 100, events: [{ rawDamage: 300, tHitMs: 100 }] });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);                     // 500 - 300 = 200 <= 250
  expect(f.escapeLog()[0]).toContain('ground');
  const tile = vi.mocked(sendDllFeatureExports).mock.calls.filter(([k]) => k === 'autoNexusTilePredict').at(-1);
  expect(tile).toEqual(['autoNexusTilePredict', true]);
});

it('ground counting can be switched off and disarms the native tile predictor', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusGround')).toBe(true);
  f.settings.get('PredictiveNexusGround')!(false);
  f.hp(300);
  scan([], { rawDamage: 300, tHitMs: 100, events: [{ rawDamage: 300, tHitMs: 100 }] });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
  const tile = vi.mocked(sendDllFeatureExports).mock.calls.filter(([k]) => k === 'autoNexusTilePredict').at(-1);
  expect(tile).toEqual(['autoNexusTilePredict', false]);
});

it('ground and bullet forecasts sum', () => {
  const f = fixture(); f.hp(400);
  f.enemyShoot(2, 7, 0, 100);
  scan([{ attackerObjId: 2, bulletId: 7, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }],
    { rawDamage: 100, tHitMs: 100, events: [{ rawDamage: 100, tHitMs: 100 }] });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);                     // 400 - 100 - 100 = 200 <= 250
});

// ── AoE ─────────────────────────────────────────────────────────────────────

it('charges a server-announced AoE the player stands in, at its packet damage', () => {
  const f = fixture(); atPlayer(f); f.hp(500);
  f.emit('AOE', { position: { x: 10, y: 10 }, radius: 3, damage: 400, armorPierce: false, effectDuration: 2 });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);                     // 500 - 400 = 100 <= 250
  expect(f.escapeLog()[0]).toContain('AoE');
});

it('ignores an AoE the player does not stand in', () => {
  const f = fixture(); atPlayer(f); f.hp(300);
  f.emit('AOE', { position: { x: 50, y: 50 }, radius: 3, damage: 29000, armorPierce: true, effectDuration: 2 });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
});

it('AoE counting can be switched off; AoEs without damage or radius never count', () => {
  const f = fixture(); atPlayer(f);
  expect(f.settings.has('PredictiveNexusAoe')).toBe(true);
  f.settings.get('PredictiveNexusAoe')!(false);
  f.hp(300);
  f.emit('AOE', { position: { x: 10, y: 10 }, radius: 3, damage: 29000, armorPierce: true, effectDuration: 2 });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
  f.settings.get('PredictiveNexusAoe')!(true);
  f.emit('AOE', { position: { x: 10, y: 10 }, damage: 0, armorPierce: false });
  f.emit('AOE', { radius: 3, damage: 29000, armorPierce: true });
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
});

// ── Regen (method_29) ───────────────────────────────────────────────────────

it('regen credit accrues with vitality between HP updates and lifts predicted HP', () => {
  const f = fixture();
  f.settings.get('BurstGuard')!(false);
  f.client.playerData.effectiveVitality = 40;      // 2*(1+0.12*40) = 11.6 HP/s
  f.hp(300);
  vi.advanceTimersByTime(2000);                    // ~23 credit
  f.enemyShoot(2, 7, 0, 80);
  scan([{ attackerObjId: 2, bulletId: 7, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }]);
  vi.advanceTimersByTime(20);
  expect(f.observation()).toMatchObject({ predictedHp: 243 });   // 300 - 80 + 23
});

it('an explicit server HP restarts the regen credit', () => {
  const f = fixture();
  f.settings.get('BurstGuard')!(false);
  f.client.playerData.effectiveVitality = 40;
  f.hp(300);
  vi.advanceTimersByTime(2000);
  f.hp(290);                                       // server speaks: credit resets
  f.enemyShoot(2, 7, 0, 80);
  scan([{ attackerObjId: 2, bulletId: 7, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }]);
  vi.advanceTimersByTime(20);
  expect(f.observation()).toMatchObject({ predictedHp: 210 });   // 290 - 80 + 0
});

it('bleeding drains and sick suppresses regen credit', () => {
  const f = fixture();
  f.settings.get('BurstGuard')!(false);
  f.client.playerData.effectiveVitality = 0;       // 2 HP/s base
  f.client.playerData.hasConditionEffect = (name: string) => name === 'Bleeding';
  f.hp(300);
  vi.advanceTimersByTime(2000);                    // +4 regen, -40 bleed -> floored at 0
  f.enemyShoot(2, 7, 0, 80);
  scan([{ attackerObjId: 2, bulletId: 7, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }]);
  vi.advanceTimersByTime(20);
  expect(f.observation()).toMatchObject({ predictedHp: 220 });   // 300 - 80 + 0
  f.client.playerData.hasConditionEffect = (name: string) => name === 'Sick';
  f.hp(300);
  vi.advanceTimersByTime(2000);                    // sick: no gain at all
  f.enemyShoot(2, 8, 0, 80);
  scan([{ attackerObjId: 2, bulletId: 8, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }]);
  vi.advanceTimersByTime(20);
  expect(f.observation()).toMatchObject({ predictedHp: 220 });
});

// ── Unknown-bullet PLAYERHIT charge ─────────────────────────────────────────

it('charges an unannounced bullet at the assumed damage when the game reports the hit', () => {
  const f = fixture(); f.hp(450);
  f.playerHit(55, 9);                              // never announced by ENEMYSHOOT
  expect(f.escapes()).toBe(0);                     // 450 - 175 = 275 > 250: charged, not crossed
  expect(f.observation()).toMatchObject({ predictedHp: 275 });
  scan([{ attackerObjId: 9, bulletId: 55, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false }]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);                     // the same bullet is not counted twice
});

it('the unknown-bullet PLAYERHIT charge follows the unknown-damage switch', () => {
  const f = fixture();
  f.settings.get('PredictiveNexusUnknownDamage')!(false);
  f.hp(300);
  f.playerHit(56, 9);
  expect(f.escapes()).toBe(0);                     // uncharged: 300 above the 250 point
  expect(f.observation()).toBeNull();
});
