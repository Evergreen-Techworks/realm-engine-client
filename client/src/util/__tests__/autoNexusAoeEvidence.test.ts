import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (original) => ({
  ...(await original<Record<string, unknown>>()), sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []), getDllThreatsAgeMs: vi.fn(() => null), getDllGround: vi.fn(() => null),
}));
import { fixture } from './helpers/autoNexusFixture.js';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
function setup() {
  const f = fixture();
  f.settings.get('ForceAutoNexusHealth')!(5);
  f.settings.get('PredictiveNexusHealth')!(1);
  f.settings.get('BurstGuard')!(false);
  f.client.playerData.defense = 20;
  const position = { x: 10, y: 10 };
  (f.ctx as any).getWorldState = () => ({ getEntity: () => ({ pos: position }) });
  const blast = (damage = 125, x = 10) => f.emit('AOE', {
    position: { x, y: 10 }, radius: 3, damage, effect: 1, effectDuration: 5,
    originType: 0xc2ee, armorPierce: false,
  });
  const ack = (x = 10) => f.emit('AOEACK', { time: 1, position: { x, y: 10 } });
  return { ...f, position, blast, ack };
}
it('does not subtract already-settled blasts again as lingering forecast zones', () => {
  const f = setup(); f.hp(500);
  f.blast(); f.ack(); f.hp(395);
  f.blast(); f.ack(); f.hp(290);
  f.hp(186); // later ground/other loss, both 105 HP blasts already settled
  vi.advanceTimersByTime(200);
  expect(f.escapes()).toBe(0);
});
it('a missed blast does not damage a player who subsequently walks into its old location', () => {
  const f = setup(); f.hp(100); f.position.x = 20;
  f.blast(); f.ack(20); f.position.x = 10;
  vi.advanceTimersByTime(200);
  expect(f.escapes()).toBe(0);
});
it('charges a matched in-radius acknowledgement once and preserves both packets', () => {
  const f = setup(); f.hp(140);
  expect(f.blast().send).toBe(true);
  expect(f.ack().send).toBe(true); // 140 - 105 = 35, below actual threshold 50
  expect(f.escapes()).toBe(1);
  expect(f.escapeLog()[0]).toContain('layer=hit-ledger');
  f.ack();
  expect(f.escapes()).toBe(1);
});
it('does not match an old-map blast to a new-map acknowledgement', () => {
  const f = setup(); f.hp(500); f.blast();
  f.emit('MAPINFO', { name: 'Realm' }); f.hp(100); f.ack();
  vi.advanceTimersByTime(200);
  expect(f.escapes()).toBe(0);
});
it('keeps FIFO alignment through a malformed/zero-damage placeholder', () => {
  const f = setup(); f.hp(140);
  f.emit('AOE', { damage: NaN }); f.blast();
  f.ack(); expect(f.escapes()).toBe(0);
  f.ack(); expect(f.escapes()).toBe(1);
});
it('consumes a miss before a later in-radius impact', () => {
  const f = setup(); f.hp(140); f.blast(125, 50); f.blast();
  f.ack(); expect(f.escapes()).toBe(0);
  f.ack(); expect(f.escapes()).toBe(1);
});
it('does not charge disabled or invulnerable area impacts', () => {
  const f = setup(); f.hp(140);
  f.settings.get('PredictiveNexusAoe')!(false); f.blast();
  f.settings.get('PredictiveNexusAoe')!(true); f.ack();
  expect(f.escapes()).toBe(0);
  f.setCondition('Invulnerable'); f.blast(); f.ack();
  expect(f.escapes()).toBe(0);
});
it('expired acknowledgements consume their own slot without stealing the next impact', () => {
  const f = setup(); f.hp(140); f.blast(); vi.advanceTimersByTime(2100);
  f.blast(); f.ack(); expect(f.escapes()).toBe(0);
  f.ack(); expect(f.escapes()).toBe(1);
});
it('stops association on queue overflow rather than pairing an acknowledgement to the wrong blast', () => {
  const f = setup(); f.hp(140);
  for (let i = 0; i < 4097; i++) f.blast();
  f.ack(); expect(f.escapes()).toBe(0);
  expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('queue overflow'));
});
