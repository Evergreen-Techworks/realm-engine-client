import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (original) => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => null), getDllGround: vi.fn(() => null),
}));
import { fixture } from './helpers/autoNexusFixture.js';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
function setup() {
  const f = fixture();
  f.settings.get('ForceAutoNexusHealth')!(20);
  f.settings.get('PredictiveNexusForecast')!(false);
  f.settings.get('BurstGuard')!(false);
  f.hp(500);
  f.enemy(42, 5, 'Known shooter', { 0: { damage: 160 } });
  f.enemyShoot(42, 1, 0, 160);
  return f;
}
it.each(['before', 'after'])('retains confirmed unmatched damage %s a distinct pending hit', order => {
  const f = setup();
  if (order === 'before') f.damage(8, 99, 150);
  f.playerHit(1, 42);
  if (order === 'after') f.damage(8, 99, 150);
  expect(f.escapes()).toBe(1); // 500 - 150 confirmed - 160 distinct pending = 190
  expect(f.escapeLog()[0]).toContain('predicted HP=190/1000');
});
it('does not subtract a matched acknowledgement twice', () => {
  const f = setup(); f.playerHit(1, 42); f.damage(1, 42, 160);
  expect(f.escapes()).toBe(0); // 340 HP, not 180
});
it('an explicit later HP sample replaces unattributed loss', () => {
  const f = setup(); f.damage(8, 99, 150); f.hp(500); f.playerHit(1, 42);
  expect(f.escapes()).toBe(0);
});

it('does not double-charge a pending hit whose owner disappeared before DAMAGE', () => {
  const f = setup(); f.playerHit(1, 42);
  f.emit('UPDATE', { drops: [42], newObjs: [] });
  f.damage(1, 42, 160);
  expect(f.escapes()).toBe(0);
});
it('does not invent a pending-hit association for DAMAGE without wire identity', () => {
  const f = setup(); f.playerHit(1, 42);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 160 });
  expect(f.escapes()).toBe(0);
});

it('does not assume a server DAMAGE is distinct from a previously acknowledged area impact', () => {
  const f = setup(); f.hp(400);
  f.emit('AOE', { position: { x: 10, y: 10 }, radius: 3, damage: 150, originType: 5 });
  f.emit('AOEACK', { position: { x: 10, y: 10 } });
  f.damage(0, 42, 150);
  expect(f.escapes()).toBe(0); // 250, not a manufactured 100 HP
});

it.each([{objectId:null,bulletId:null}, {objectId:-1,bulletId:0}, {objectId:99,bulletId:65536}])(
  'does not manufacture a distinct identity from malformed fields %j', fields => {
    const f = setup(); f.playerHit(1, 42);
    f.emit('DAMAGE', { targetId: 1, damageAmount: 160, ...fields });
    expect(f.escapes()).toBe(0);
  });
