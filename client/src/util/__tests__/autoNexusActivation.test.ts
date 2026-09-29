/**
 * Prediction activation (owner decision 2026-09-22): the hit-ledger and
 * forecast layers ACT by default again — the pre-2026-09-06 predictive
 * coverage, inside the v2 accounting.
 *
 *  - `PredictiveNexusMode` (new key, default 'active') replaces the
 *    observe-only-era `PredictionMode`; a saved profile's stale
 *    `PredictionMode: 'observe'` cannot keep prediction off.
 *  - Global evidence ambiguity no longer vetoes a predictive escape whose
 *    own bullets are clean (per-shot ambiguity still skips those shots).
 *  - Bullets without packet damage charge the DLL's fallback damage, else
 *    the assumed-damage setting (175 armor-piercing by default).
 */
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => [] as unknown[]),
  getDllThreatsAgeMs: vi.fn(() => 0),
}));
import { getDllThreats, getDllThreatsAgeMs } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

/** A native-scan threat ~90ms from impact (scan age 10ms, tHit 100ms). */
const threat = (over: Record<string, unknown> = {}) => ({
  attackerObjId: 2, bulletId: 7, tHitMs: 100, fallbackDamage: 0, fallbackArmorPiercing: false, ...over,
});
function scan(threats: unknown[]): void {
  vi.mocked(getDllThreats).mockReturnValue(threats as any[]);
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(10);
}

// ── Registration / migration ────────────────────────────────────────────────

it('registers PredictiveNexusMode (default active) and retires the observe-era PredictionMode key', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusMode')).toBe(true);
  expect(f.settings.has('PredictionMode')).toBe(false);
});

// ── Active by default ───────────────────────────────────────────────────────

it('forecast escapes by default for a packet-damage bullet predicted to hit', () => {
  const f = fixture(); f.hp(800);
  f.enemyShoot(2, 7, 0, 600);
  scan([threat()]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);
});

it('hit-ledger escapes by default once charged PLAYERHITs cross the escape point', () => {
  const f = fixture(); f.hp(800);
  f.enemyShoot(2, 7, 0, 600);
  f.playerHit(7, 2);
  expect(f.escapes()).toBe(1);
  expect(f.escapeLog().some(l => l.includes('layer=hit-ledger'))).toBe(true);
});

it('observe mode never sends: predictions are recorded, not acted on', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusMode')).toBe(true);
  f.settings.get('PredictiveNexusMode')!('observe');
  f.hp(800);
  f.enemyShoot(2, 7, 0, 600);
  scan([threat()]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
  expect(f.observation()?.mode).toBe('observe');
});

it('an invalid mode value never activates prediction', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusMode')).toBe(true);
  f.settings.get('PredictiveNexusMode')!('bogus');
  f.hp(800);
  f.enemyShoot(2, 7, 0, 600);
  scan([threat()]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
  expect(f.observation()?.mode).toBe('observe');
});

// ── Ambiguity no longer vetoes clean bullets ────────────────────────────────

it('a predictive escape fires while global evidence is ambiguous if its own bullets are clean', () => {
  const f = fixture(); f.hp(800);
  f.enemyShoot(3, 9, 0, 100);
  f.emit('UPDATE', { drops: [3], newObjs: [] }); // owner 3 leaves with a live shot: ambiguity
  f.enemyShoot(2, 7, 0, 600);                    // a different, clean bullet
  scan([threat()]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);
});

// ── Unknown-damage bullets charge again ─────────────────────────────────────

it('a bullet with no packet record charges the DLL fallback damage', () => {
  const f = fixture(); f.hp(800);
  scan([threat({ attackerObjId: 5, bulletId: 11, fallbackDamage: 600, fallbackArmorPiercing: false })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1);
  expect(f.escapeLog().some(l => l.includes('unknown'))).toBe(true);
});

it('a synthetic threat (9999 fallback) charges the assumed damage instead', () => {
  const f = fixture(); f.hp(300);
  scan([threat({ attackerObjId: 6, bulletId: 20005, fallbackDamage: 9999, fallbackArmorPiercing: true })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1); // 300 - 175 (assumed, armor-piercing) = 125 <= 250
});

it('a packet record wins over the DLL fallback for the same bullet', () => {
  const f = fixture(); f.hp(400);
  f.enemyShoot(2, 7, 0, 100); // packet says 100; fallback below says 999
  scan([threat({ fallbackDamage: 999 })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0); // 400 - 100 = 300 > 250; the 999 must not be charged
});

it('packet and unknown bullets sum in one forecast', () => {
  const f = fixture(); f.hp(400);
  f.enemyShoot(2, 7, 0, 100);
  scan([threat(), threat({ attackerObjId: 5, bulletId: 11, fallbackDamage: 0 })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1); // 400 - 100 - 175 (assumed) = 125 <= 250
});

it('counting unknown-damage bullets can be switched off', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusUnknownDamage')).toBe(true);
  f.settings.get('PredictiveNexusUnknownDamage')!(false);
  f.hp(800);
  scan([threat({ attackerObjId: 5, bulletId: 11, fallbackDamage: 600 })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(0);
});

it('the assumed-damage setting sets what an unusable fallback charges', () => {
  const f = fixture();
  expect(f.settings.has('PredictiveNexusAssumedDamage')).toBe(true);
  f.settings.get('PredictiveNexusAssumedDamage')!(400);
  f.hp(600);
  scan([threat({ attackerObjId: 5, bulletId: 11, fallbackDamage: 0 })]);
  vi.advanceTimersByTime(20);
  expect(f.escapes()).toBe(1); // 600 - 400 (assumed) = 200 <= 250
});
