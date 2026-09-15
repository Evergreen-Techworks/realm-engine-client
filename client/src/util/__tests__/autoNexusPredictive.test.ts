import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../plugins/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendDllFeature: vi.fn(),
  getDllThreats: vi.fn(() => []),
  getDllThreatsAgeMs: vi.fn(() => null),
  getDllGround: vi.fn(() => null),
}));
import { getDllThreats, getDllThreatsAgeMs, sendDllFeature } from '../../../plugins/api.js';
import type { DllThreat } from '../../../plugins/api.js';
import { fixture } from './helpers/autoNexusFixture.js';

const JELLY_ID = 5001;
const JELLY_TYPE = 0x7219;
/** objects.xml "Deep Sea Jellyfish" (DisplayId Hadopelagic Jellyfish), game 86ad651b. */
const JELLY_PROJECTILES = {
  0: { damage: 150, lifetimeMs: 2150,
    conditionEffects: [{ effect: 'Slowed', durationSec: 3.6 }, { effect: 'Exposed', durationSec: 1.8 }] },
  1: { damage: 120, lifetimeMs: 1875 },
  2: { damage: 120, lifetimeMs: 2500 },
};

function threats(list: Partial<DllThreat>[], ageMs = 20): void {
  vi.mocked(getDllThreats).mockReturnValue(list.map(t => ({
    attackerObjId: JELLY_ID, bulletId: 0, tHitMs: 50, fallbackDamage: 120, fallbackArmorPiercing: false, ...t,
  })));
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(ageMs);
}

/** max HP 1000, nexus at 10% (100 HP), no burst guard, defense 0, one Jellyfish in view. */
function plain() {
  const f = fixture({ allowActivePredictionForTests: true });
  f.settings.get('ForceAutoNexusHealth')!(10);
  f.settings.get('BurstGuard')!(false);
  f.enemy(JELLY_ID, JELLY_TYPE, 'Hadopelagic Jellyfish', JELLY_PROJECTILES);
  return f;
}

beforeEach(() => {
  vi.mocked(getDllThreats).mockReturnValue([]);
  vi.mocked(getDllThreatsAgeMs).mockReturnValue(null);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('hit ledger (layer 2)', () => {
  it('replays the 2026-09-14 Hadopelagic Jellyfish death: one escape before the lethal total', () => {
    const f = fixture({ allowActivePredictionForTests: true });
    f.client.playerData.effectiveMaxHealth = 675;
    f.client.playerData.defense = 39;
    f.enemy(JELLY_ID, JELLY_TYPE, 'Hadopelagic Jellyfish', JELLY_PROJECTILES);
    f.hp(544); vi.advanceTimersByTime(100); f.hp(464);     // largest recent burst 80 -> guard 100 < 25% threshold
    vi.advanceTimersByTime(202);                            // health evidence age=202ms
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);                 // bullets 100..102, 120 each
    f.enemyShoot(JELLY_ID, 103, 0, 150, 2);                 // bullets 103..104, 150 each, apply Exposed

    f.playerHit(100, JELLY_ID);                             // 120 - 39 = 81   -> 383
    f.playerHit(103, JELLY_ID);                             // 150 - 39 = 111  -> 272, now Exposed
    f.playerHit(101, JELLY_ID);                             // 120 - 19 = 101  -> 171 (> 168.75)
    expect(f.escapes()).toBe(0);
    f.playerHit(102, JELLY_ID);                             // 101 -> 70: escape
    expect(f.escapes()).toBe(1);
    f.playerHit(104, JELLY_ID);                             // 131 -> 525 total >= 464: the lethal one
    expect(f.escapes()).toBe(1);

    const [line] = f.escapeLog();
    expect(line).toContain('layer=hit-ledger; predicted HP=70/675; escape point=169 HP (threshold 25%)');
    expect(line).toContain('confirmed HP=464/675 age=202ms');
    expect(line).toContain('bullets=4 [Hadopelagic Jellyfish 0x7219 raw 120 -> 81 def, '
      + 'Hadopelagic Jellyfish 0x7219 raw 150 -> 111 def, Hadopelagic Jellyfish 0x7219 raw 120 -> 101 def, '
      + 'Hadopelagic Jellyfish 0x7219 raw 120 -> 101 def]');
    f.emit('DEATH', { killedBy: 'Hadopelagic Jellyfish' });
    expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('ledger HP=-61 (5 charged hit(s), 5 shot(s) known)'));
  });

  it('charges a non-piercing 80 against defense 58 as 22', () => {
    const f = plain(); f.client.playerData.defense = 58;
    f.enemy(JELLY_ID, JELLY_TYPE, 'Hadopelagic Jellyfish', { 1: { damage: 80 } });
    f.hp(125);
    f.enemyShoot(JELLY_ID, 7, 1, 80, 2);
    f.playerHit(7, JELLY_ID);                               // 22 -> 103: above 100
    expect(f.escapes()).toBe(0);
    f.playerHit(8, JELLY_ID);                               // 22 -> 81
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('raw 80 -> 22 def, Hadopelagic Jellyfish 0x7219 raw 80 -> 22 def');
  });

  it('charges armor-piercing bullets in full', () => {
    const f = plain(); f.client.playerData.defense = 58;
    f.enemy(JELLY_ID, JELLY_TYPE, 'Hadopelagic Jellyfish', { 1: { damage: 80, armorPiercing: true } });
    f.hp(179);
    f.enemyShoot(JELLY_ID, 7, 1, 80);
    f.playerHit(7, JELLY_ID);                               // 80 -> 99
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('raw 80 -> 80 pierce');
  });

  it('treats a bullet with unknown projectile properties as armor-piercing', () => {
    const f = plain(); f.client.playerData.defense = 58;
    f.entityTypes.set(6001, 0x9999);                        // in view, but no definition for its type
    f.hp(179);
    f.enemyShoot(6001, 7, 0, 80);
    f.enemyShoot(7001, 9, 0, 80);                           // owner not even in the world state
    f.playerHit(7, 6001);                                   // 80 in full -> 99
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('0x9999 raw 80 -> 80 pierce(unknown)');
  });

  it('treats an unknown owner as armor-piercing as well', () => {
    const f = plain(); f.client.playerData.defense = 58;
    f.hp(179);
    f.enemyShoot(7001, 9, 0, 80);
    f.playerHit(9, 7001);
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('unknown owner raw 80 -> 80 pierce(unknown)');
  });

  it('never charges a bullet without a packet damage, and charges each identity once', () => {
    const f = plain();
    f.hp(230);
    f.playerHit(55, JELLY_ID);                              // never announced
    f.enemyShoot(JELLY_ID, 7, 1, 120);
    f.playerHit(7, JELLY_ID);                               // 120 -> 110
    f.playerHit(7, JELLY_ID);                               // duplicate report of the same bullet
    f.playerHit(7, JELLY_ID);
    expect(f.escapes()).toBe(0);
  });

  it('expands numShots and wraps bullet ids the way the uint16 PLAYERHIT does', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 65535, 1, 120, 2);               // 65535 and 0
    f.playerHit(0, JELLY_ID);                               // 180
    f.playerHit(65535, JELLY_ID);                           // 60
    expect(f.escapes()).toBe(1);
  });

  it('charges nothing while invulnerable', () => {
    const f = plain(); f.setCondition('Invulnerable');
    f.hp(150);
    f.enemyShoot(JELLY_ID, 7, 1, 120, 3);
    for (const id of [7, 8, 9]) f.playerHit(id, JELLY_ID);
    expect(f.escapes()).toBe(0);
    f.setCondition('Invulnerable', false);
    f.playerHit(7, JELLY_ID);                               // already consumed while invulnerable
    expect(f.escapes()).toBe(0);
  });

  it('restarts from each server HP update, so a confirmed hit is not charged twice', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    f.playerHit(100, JELLY_ID);                             // 180 predicted
    f.hp(180);                                              // server applied it
    f.enemyShoot(JELLY_ID, 200, 1, 50);
    f.playerHit(200, JELLY_ID);                             // 130, not 180 - 120 - 50 = 10
    expect(f.escapes()).toBe(0);
    f.hp(400);                                              // a heal also replaces the ledger
    f.playerHit(101, JELLY_ID); f.playerHit(102, JELLY_ID); // 400 - 240 = 160
    expect(f.escapes()).toBe(0);
  });

  it('drops the charge of a bullet the server confirms with DAMAGE', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 2);
    f.playerHit(100, JELLY_ID);                             // 180 predicted
    f.emit('DAMAGE', { targetId: 1, damageAmount: 120, kill: false, bulletId: 100, objectId: JELLY_ID });
    expect(f.escapes()).toBe(0);                            // 180 confirmed, not 60
    f.playerHit(100, JELLY_ID);
    expect(f.escapes()).toBe(0);
    f.playerHit(101, JELLY_ID);                             // 60
    expect(f.escapes()).toBe(1);
  });

  it('resets shots and charges on map change', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    f.playerHit(100, JELLY_ID);                             // 180 predicted
    f.emit('MAPINFO', { name: 'Realm of the Mad God' }); f.emit('CREATESUCCESS');
    f.client.playerData.health = 250;
    f.emit('NEWTICK', { statuses: [] });                   // seeds 250 without an explicit HP stat
    f.playerHit(101, JELLY_ID);                             // announced on the previous map
    f.enemyShoot(JELLY_ID, 300, 1, 100);
    f.playerHit(300, JELLY_ID);                             // 150
    expect(f.escapes()).toBe(0);
  });

  it('resets shots and charges when the plugin is disabled and enabled again', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    f.playerHit(100, JELLY_ID);
    f.disable(); f.enable();
    f.client.playerData.health = 250;
    f.emit('NEWTICK', { statuses: [] });
    f.playerHit(101, JELLY_ID);
    f.enemyShoot(JELLY_ID, 300, 1, 100);
    f.playerHit(300, JELLY_ID);                             // 150
    expect(f.escapes()).toBe(0);
  });

  it('does not escape in a safe zone', () => {
    const f = plain();
    f.emit('MAPINFO', { name: 'Nexus' }); f.emit('CREATESUCCESS');
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    for (const id of [100, 101, 102]) f.playerHit(id, JELLY_ID);
    expect(f.escapes()).toBe(0);
  });

  it('charges enemy-owned SERVERPLAYERSHOOT and ignores player-owned ones', () => {
    const f = plain(); f.client.playerData.defense = 58;
    f.entityTypes.set(42, 0x0300);                          // another player: no <Enemy/>
    f.hp(125);
    f.serverPlayerShoot(42, 5, 0x0a00, 500);
    f.playerHit(5, 42);
    expect(f.escapes()).toBe(0);
    f.serverPlayerShoot(JELLY_ID, 6, 0x0a00, 80, 1);        // Jellyfish projectile 1: not piercing
    f.playerHit(6, JELLY_ID);                               // 22 -> 103
    expect(f.escapes()).toBe(0);
    f.serverPlayerShoot(JELLY_ID, 7, 0x0a00, 80, 1);
    f.playerHit(7, JELLY_ID);                               // 22 -> 81
    expect(f.escapes()).toBe(1);
  });

  it('forwards every outgoing PLAYERHIT byte-identical, whatever the ledger decides', () => {
    const f = plain();
    f.playerHit(1, JELLY_ID);                               // no HP yet, unknown bullet
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    f.playerHit(100, JELLY_ID);                             // charged
    f.playerHit(100, JELLY_ID);                             // duplicate
    f.setCondition('Invulnerable'); f.playerHit(101, JELLY_ID); f.setCondition('Invulnerable', false);
    f.enemyShoot(JELLY_ID, 200, 1, 120, 2);
    f.playerHit(200, JELLY_ID);                             // 60: escapes
    f.playerHit(201, JELLY_ID);                             // after the escape
    f.settings.get('PredictiveNexusForecast')!(false);
    f.playerHit(102, JELLY_ID);
    expect(f.escapes()).toBe(1);                            // each playerHit call asserted the bytes
  });
});

describe('short forecast (layer 3)', () => {
  it('escapes when fired bullets with packet damage are predicted to hit within the horizon', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100, tHitMs: 60 }, { bulletId: 101, tHitMs: 90 }]);
    vi.advanceTimersByTime(20);
    expect(f.escapes()).toBe(1);                            // 300 - 240 = 60
    const line = f.escapeLog()[0];
    expect(line).toContain('layer=forecast; predicted HP=60/1000; escape point=100 HP (threshold 10%)');
    expect(line).toContain('confirmed HP=300/1000');
    expect(line).toContain('bullets=2 [Hadopelagic Jellyfish 0x7219 raw 120 -> 120 def in 40ms, '
      + 'Hadopelagic Jellyfish 0x7219 raw 120 -> 120 def in 70ms]');
    expect(line).toContain('native scan age 20ms');
  });

  it('ignores hits predicted beyond the horizon', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100, tHitMs: 100 }, { bulletId: 101, tHitMs: 300 }]); // 280ms after the scan age
    vi.advanceTimersByTime(200);
    expect(f.escapes()).toBe(0);
    threats([{ bulletId: 100, tHitMs: 100 }, { bulletId: 101, tHitMs: 260 }]); // 240ms: inside
    vi.advanceTimersByTime(20);
    expect(f.escapes()).toBe(1);
  });

  it('follows the horizon setting', () => {
    const f = plain();
    f.settings.get('PredictiveNexusHorizonMs')!(150);
    expect(sendDllFeature).toHaveBeenCalledWith('autoNexusPredictedTimeMs', 250);
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100, tHitMs: 100 }, { bulletId: 101, tHitMs: 200 }]); // 180ms
    vi.advanceTimersByTime(100);
    expect(f.escapes()).toBe(0);
  });

  it('discards a native scan older than 100 ms', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100, tHitMs: 200 }, { bulletId: 101, tHitMs: 220 }], 150);
    vi.advanceTimersByTime(200);
    expect(f.escapes()).toBe(0);
    threats([{ bulletId: 100, tHitMs: 200 }, { bulletId: 101, tHitMs: 220 }], 100);
    vi.advanceTimersByTime(20);
    expect(f.escapes()).toBe(1);
  });

  it('counts each bullet identity once', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100, tHitMs: 50 }, { bulletId: 100, tHitMs: 60 }, { bulletId: 100 + 65536, tHitMs: 70 }]);
    vi.advanceTimersByTime(200);
    expect(f.escapes()).toBe(0);                            // 180, not -60
  });

  it('never counts a bullet already charged by its PLAYERHIT', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    f.playerHit(100, JELLY_ID);                             // ledger: 180
    threats([{ bulletId: 100, tHitMs: 0 }]);                // the same bullet, still on the native list
    vi.advanceTimersByTime(200);
    expect(f.escapes()).toBe(0);
  });

  it('does not count anything while invulnerable', () => {
    const f = plain(); f.setCondition('Invincible');
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100 }, { bulletId: 101 }, { bulletId: 102 }]);
    vi.advanceTimersByTime(200);
    expect(f.escapes()).toBe(0);
  });

  it('rejects three synthetic 9999 AoE threats even when real bullets share their ids', () => {
    const f = plain();
    f.hp(300);
    f.enemyShoot(JELLY_ID, 20000, 1, 120, 3);               // real bullets 20000..20002 exist
    threats([0, 1, 2].map(i => ({ bulletId: 20000 + i, tHitMs: 30, fallbackDamage: 9999, fallbackArmorPiercing: false })));
    vi.advanceTimersByTime(500);
    expect(f.escapes()).toBe(0);
    threats([0, 1, 2].map(i => ({ bulletId: 20000 + i, tHitMs: 30, fallbackDamage: 120 })));
    vi.advanceTimersByTime(20);
    expect(f.escapes()).toBe(1);                            // the same identities from a real scan do count
  });

  it('never counts unknown bullets, fallback damage or ground forecasts', () => {
    const f = plain();
    f.hp(300);
    threats([{ bulletId: 1, fallbackDamage: 29000 }, { attackerObjId: 9, bulletId: 2, fallbackDamage: 9999 }]);
    vi.advanceTimersByTime(500);
    expect(f.escapes()).toBe(0);
  });

  it('with the forecast off, never escapes on forecasts but the hit ledger still works', () => {
    const f = plain();
    f.settings.get('PredictiveNexusForecast')!(false);
    expect(vi.mocked(sendDllFeature).mock.calls.filter(([k]) => k === 'autoNexusEnabled').at(-1)).toEqual(['autoNexusEnabled', false]);
    f.hp(300);
    f.enemyShoot(JELLY_ID, 100, 1, 120, 3);
    threats([{ bulletId: 100 }, { bulletId: 101 }, { bulletId: 102 }]);
    vi.advanceTimersByTime(500);
    expect(f.escapes()).toBe(0);
    f.playerHit(100, JELLY_ID); f.playerHit(101, JELLY_ID); // 60
    expect(f.escapes()).toBe(1);
    expect(f.escapeLog()[0]).toContain('layer=hit-ledger');
  });

  it('arms the native projectile forecast only, and disarms it when the plugin is disabled', () => {
    const f = plain();
    const last = (key: string) => vi.mocked(sendDllFeature).mock.calls.filter(([k]) => k === key).at(-1)?.[1];
    expect(last('autoNexusEnabled')).toBe(true);
    expect(last('autoNexusProjPredict')).toBe(true);
    expect(last('autoNexusTilePredict')).toBe(false);
    expect(last('autoNexusDebugDraw')).toBe(false);
    expect(last('autoNexusPredictedTimeMs')).toBe(350);
    f.disable();
    expect(last('autoNexusEnabled')).toBe(false);
    expect(last('autoNexusProjPredict')).toBe(false);
  });
});
