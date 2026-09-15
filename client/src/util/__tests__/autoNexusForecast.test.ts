import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => [{ fallbackDamage: 29000, tHitMs: 0 }]),
  getDllThreatsAgeMs: vi.fn(() => 0),
  getDllGround: vi.fn(() => ({ damage: 9999 })),
}));
import { sendDllFeature, getDllGround } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });
it('ignores guessed client hits, ground/AoE warnings and damage-less forecasts, including legacy configuration', () => {
  const f = fixture(); f.hp(800);
  for (const name of ['PLAYERHIT','GROUNDDAMAGE','AOE','AOEACK','MOVE'])
    expect(f.emit(name, { damage: 29000, objectId: 2, bulletId: 3 }).send).toBe(true);
  vi.advanceTimersByTime(10000);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  expect(getDllGround).not.toHaveBeenCalled();
  for (const key of ['PredictedAutoNexusHealth','PredictedAutoNexusTime','PredictedUsesForceThreshold','IncludeGroundTicks',
    'UnattributedMargin','HoldLethalPlayerHit','LethalHoldTime','LethalCushionHealth','DrawOverlay'])
    expect(f.settings.has(key)).toBe(false);
  for (const key of ['autoNexusTilePredict','autoNexusDebugDraw'])
    expect(sendDllFeature).toHaveBeenCalledWith(key, false);
  expect(sendDllFeature).not.toHaveBeenCalledWith('autoNexusTilePredict', true);
});
it('uses the current server HP packet and preserves its delivery', () => {
  const f = fixture(); f.hp(800);
  const packet = f.hp(250); // cached playerData still says 800
  expect(f.client.sendToServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'ESCAPE' }));
  expect(packet.send).toBe(true);
});
it('counts confirmed damage once and does not reset it from delta ticks without HP', () => {
  const f = fixture(); f.settings.get('BurstGuard')!(false); f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 300 });
  f.emit('NEWTICK', { statuses: [] });
  f.emit('DAMAGE', { targetId: 1, damageAmount: 200 });
  expect(f.client.sendToServer).not.toHaveBeenCalled(); // 300 HP: no extra unseen-damage margin
  f.emit('DAMAGE', { targetId: 1, damageAmount: 51 });
  expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('authoritative HP heals replace the confirmed ledger without guessed recovery', () => {
  const f = fixture(); f.settings.get('BurstGuard')!(false); f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 400 });
  f.hp(800);
  f.emit('DAMAGE', { targetId: 1, damageAmount: 400 });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});
it('does not escape in safe zones and resets health on map/character entry', () => {
  const f = fixture(); f.emit('MAPINFO', { name: 'Nexus' }); f.emit('CREATESUCCESS'); f.hp(100);
  f.emit('DAMAGE', { targetId: 1, kill: true });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.emit('MAPINFO', { name: 'Realm' }); f.emit('CREATESUCCESS'); f.hp(800);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.hp(100); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('ignores invalid damage and other targets, while honoring confirmed zero HP', () => {
  const f = fixture(); f.hp(800);
  for (const amount of [NaN, Infinity, -29000, '9999', 0])
    f.emit('DAMAGE', { targetId: 1, damageAmount: amount });
  f.emit('DAMAGE', { targetId: 2, kill: true, damageAmount: 9999 });
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.settings.get('ForceAutoNexusHealth')!(0);
  f.hp(0); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
  expect(f.emit('DEATH').send).toBe(true);
});
it('stops escape retries on disable, disconnect and cleanup', () => {
  const f = fixture(); f.hp(100); vi.advanceTimersByTime(400);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
  f.disable(); vi.advanceTimersByTime(5000);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
  f.events.get('clientDisconnected')!(f.client);
  for (const clean of f.cleanup) clean();
  expect(vi.getTimerCount()).toBe(0);
});

it('sends ESCAPE before notification and retries even when notification fails', () => {
  const f = fixture();
  f.ctx.sendNotification.mockImplementation(() => {
    expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
    throw new Error('notification unavailable');
  });
  expect(() => f.hp(100)).not.toThrow();
  vi.advanceTimersByTime(400);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
});
it('retries a failed initial ESCAPE without waiting for another health packet', () => {
  const f = fixture();
  f.client.sendToServer.mockImplementationOnce(() => { throw new Error('send failure'); });
  expect(() => f.hp(100)).not.toThrow();
  vi.advanceTimersByTime(400);
  expect(f.client.sendToServer).toHaveBeenCalledTimes(2);
});
it('records burst-death evidence without claiming confirmed-health mode prevents one-shots', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(5); f.hp(600);
  vi.advanceTimersByTime(150);
  expect(f.emit('DEATH', { killedBy: 'Mushroom Brawler' }).send).toBe(true);
  expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('killer=Mushroom Brawler; confirmed HP=600/1000'));
  expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('health evidence age=150ms; threshold=5%'));
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});

// ── Burst guard ──────────────────────────────────────────────────────────────
// The 2026-09-12 deaths all had their last confirmed HP just above the threshold
// (75/775 @9%, 43/435 @9%, 21/147 @10%) and died before the next health update.
it('escapes above the threshold when a recently confirmed burst could take the remaining HP', () => {
  const f = fixture(); f.client.playerData.effectiveMaxHealth = 147;
  f.settings.get('ForceAutoNexusHealth')!(10);   // 14.7 HP
  f.hp(147);
  vi.advanceTimersByTime(200); f.hp(100);        // 47 HP lost within one reaction window
  expect(f.client.sendToServer).not.toHaveBeenCalled(); // 100 > 47 * 1.25
  vi.advanceTimersByTime(3000); f.hp(55);        // slow decline: no new burst, the 47 is remembered
  expect(f.client.sendToServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'ESCAPE' }));
  expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('burst guard: 47 HP lost within 400ms'));
});
it('without the burst guard the same sequence waits for the plain threshold', () => {
  const f = fixture(); f.client.playerData.effectiveMaxHealth = 147;
  f.settings.get('ForceAutoNexusHealth')!(10); f.settings.get('BurstGuard')!(false);
  f.hp(147); vi.advanceTimersByTime(200); f.hp(100); vi.advanceTimersByTime(3000); f.hp(55);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});
it('caps the raised escape point at half of max HP and forgets bursts after 6 s', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(10); // 100 HP of 1000
  f.hp(1000); vi.advanceTimersByTime(100); f.hp(520);                 // burst 480 -> 600, capped to 500
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(7000); f.hp(450);                            // burst expired; threshold rules
  expect(f.client.sendToServer).not.toHaveBeenCalled();
  f.hp(100); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);
});
it('measures the net loss inside the window, so damage and heals do not add up', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(10);
  for (const hp of [900, 700, 900, 700]) { f.hp(hp); vi.advanceTimersByTime(100); } // largest net loss 200 -> 250
  vi.advanceTimersByTime(1000);                                        // window empty; only the memory remains
  f.hp(300); expect(f.client.sendToServer).not.toHaveBeenCalled();    // summed losses (400 -> 500) would escape here
  f.hp(240); expect(f.client.sendToServer).toHaveBeenCalledTimes(1);  // 240 <= 250
});
it('does not mistake a max-HP change for a burst', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(10);
  f.hp(1000); vi.advanceTimersByTime(100);
  f.client.playerData.effectiveMaxHealth = 400; f.hp(400);             // gear swap, not damage
  vi.advanceTimersByTime(1000); f.hp(140);                            // a 600 "burst" would escape at <=200
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});
it('leaves a deliberate 0% threshold alone', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(0);
  f.hp(1000); vi.advanceTimersByTime(100); f.hp(100);
  expect(f.client.sendToServer).not.toHaveBeenCalled();
});
it('reports the burst guard escape point in the death diagnostic', () => {
  const f = fixture(); f.settings.get('ForceAutoNexusHealth')!(5);
  f.hp(1000); vi.advanceTimersByTime(100); f.hp(700);                  // burst 300 -> 375; 700 is above it
  f.emit('DEATH', { killedBy: 'Bone Tower 1' });
  expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('burstGuard=on (escape point 375 HP, largest recent burst 300)'));
});
