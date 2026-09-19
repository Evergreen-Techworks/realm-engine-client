import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAllowedPacketName,
  dispatchPacket,
  ProjDefTracker,
  buildStartRecord,
  buildMapRecord,
  buildMoveRecord,
  buildProjDefRecord,
  buildShotRecord,
  buildHitRecord,
  buildGroundRecord,
  buildDeathRecord,
  buildPShootRecord,
  buildEHitRecord,
  buildArmRecord,
  buildEndRecord,
  testlabCoreMarker,
  TESTLAB_PRIVATE_ONLY,
  type ProjDefInput,
} from '../recorderCore.js';

const T = 1_700_000_000_000;

const PROJ: ProjDefInput = {
  oname: 'Ghost Bear',
  speed: 8.5,
  life: 1400,
  size: 0.15,
  amplitude: 0,
  frequency: 0,
  magnitude: 3,
  wavy: false,
  parametric: false,
  boomerang: false,
  acceleration: 0,
  accelerationDelay: 0,
  speedClamp: 0,
};

describe('recorderCore: private-only marker', () => {
  it('survives as a literal and a called function', () => {
    expect(TESTLAB_PRIVATE_ONLY).toBe('TESTLAB_PRIVATE_ONLY');
    expect(testlabCoreMarker()).toBe('TESTLAB_PRIVATE_ONLY');
  });
});

describe('recorderCore: allow-list', () => {
  it('accepts exactly the eight contract packet names', () => {
    for (const name of [
      'MAPINFO', 'MOVE', 'ENEMYSHOOT', 'PLAYERHIT', 'GROUNDDAMAGE', 'DEATH', 'PLAYERSHOOT', 'ENEMYHIT',
    ]) {
      expect(isAllowedPacketName(name)).toBe(true);
    }
  });

  it('rejects HELLO, LOAD, CREATE, TEXT and anything else', () => {
    for (const name of ['HELLO', 'LOAD', 'CREATE', 'TEXT', 'UPDATE', 'FAILURE', '']) {
      expect(isAllowedPacketName(name)).toBe(false);
    }
  });

  it('dispatchPacket produces NOTHING for disallowed packets, even with account-shaped fields', () => {
    const accountShaped = {
      accountId: 'user@example.com',
      guid: 'user@example.com',
      email: 'user@example.com',
      token: 'secret-token-value',
      characterName: 'MySecretChar',
      password: 'hunter2',
    };
    const tracker = new ProjDefTracker();
    for (const name of ['HELLO', 'LOAD', 'CREATE', 'TEXT']) {
      const out = dispatchPacket(name, T, accountShaped, {}, tracker);
      expect(out).toEqual([]);
      // Belt-and-suspenders: nothing in the (empty) output can possibly leak the string.
      expect(JSON.stringify(out)).not.toContain('user@example.com');
      expect(JSON.stringify(out)).not.toContain('secret-token-value');
    }
  });

  it('DEATH record never carries the account id', () => {
    const data = {
      accountId: 'user@example.com',
      charId: 5,
      killedBy: 'Ghost God',
      unknownInt: 0,
      fameEarned: 100,
      accountLevel: 20,
      accountXP: 500,
    };
    const tracker = new ProjDefTracker();
    const [rec] = dispatchPacket('DEATH', T, data, {}, tracker);
    expect(rec).toEqual({ k: 'death', t: T, killedBy: 'Ghost God' });
    expect(JSON.stringify(rec)).not.toContain('user@example.com');
    expect((rec as any).accountId).toBeUndefined();
  });
});

describe('recorderCore: one test per record kind', () => {
  it('start', () => {
    expect(buildStartRecord(T, { version: '1.0.5', commit: 'abc1234' })).toEqual({
      k: 'start', t: T, v: 1, build: { version: '1.0.5', commit: 'abc1234' },
    });
  });

  it('start with unknown build info -> nulls, not "unknown"', () => {
    expect(buildStartRecord(T, { version: null, commit: null })).toEqual({
      k: 'start', t: T, v: 1, build: { version: null, commit: null },
    });
  });

  it('map', () => {
    const data = { name: 'Realm', width: 100, height: 100, displayName: 'The Realm' };
    expect(buildMapRecord(T, data)).toEqual({ k: 'map', t: T, name: 'Realm', w: 100, h: 100 });
  });

  it('move: x/y is the last record, recs holds every [time,x,y] sample', () => {
    const data = {
      tickId: 42,
      serverRealTimeMSofLastNewTick: 12345,
      records: [
        { time: 0, x: 10, y: 20 },
        { time: 50, x: 10.5, y: 20.5 },
      ],
    };
    expect(buildMoveRecord(T, data)).toEqual({
      k: 'move', t: T, tick: 42, x: 10.5, y: 20.5,
      recs: [[0, 10, 20], [50, 10.5, 20.5]],
    });
  });

  it('move: empty records -> x/y null, recs empty (may be empty per contract)', () => {
    const data = { tickId: 1, serverRealTimeMSofLastNewTick: 0, records: [] };
    expect(buildMoveRecord(T, data)).toEqual({ k: 'move', t: T, tick: 1, x: null, y: null, recs: [] });
  });

  it('projdef: only non-default path properties are included', () => {
    expect(buildProjDefRecord(T, 0x123, 0, PROJ)).toEqual({
      k: 'projdef', t: T, otype: 0x123, bt: 0, oname: 'Ghost Bear',
      speed: 8.5, life: 1400, size: 0.15,
    });
  });

  it('projdef: non-default path properties are included by name', () => {
    const wavyProj: ProjDefInput = { ...PROJ, wavy: true, amplitude: 2, magnitude: 5 };
    expect(buildProjDefRecord(T, 0x123, 1, wavyProj)).toEqual({
      k: 'projdef', t: T, otype: 0x123, bt: 1, oname: 'Ghost Bear',
      speed: 8.5, life: 1400, size: 0.15,
      wavy: true, amplitude: 2, magnitude: 5,
    });
  });

  it('shot: n defaults to 1 when numShots is absent or 255', () => {
    const base = { bulletId: 7, ownerId: 999, bulletType: 0, position: { x: 1, y: 2 }, angle: 0.5, damage: 40 };
    expect(buildShotRecord(T, { ...base }, 0x123).n).toBe(1);
    expect(buildShotRecord(T, { ...base, numShots: 255 }, 0x123).n).toBe(1);
    expect(buildShotRecord(T, { ...base, numShots: 3 }, 0x123).n).toBe(3);
  });

  it('shot: full field mapping', () => {
    const data = {
      bulletId: 7, ownerId: 999, bulletType: 2,
      position: { x: 12.5, y: 34.25 }, angle: 1.57, damage: 40,
      numShots: 3, angleInc: 0.1,
    };
    expect(buildShotRecord(T, data, 0x123)).toEqual({
      k: 'shot', t: T, bid: 7, oid: 999, otype: 0x123, bt: 2,
      x: 12.5, y: 34.25, a: 1.57, dmg: 40, n: 3, ainc: 0.1,
    });
  });

  it('hit: bid/oid from the packet, everything else from the resolved lookup', () => {
    const data = { bulletId: 7, objectId: 999 };
    const lookup = { otype: 0x123, x: 10, y: 20, odist: 3.5, edist: 1.2, hp: 40, maxhp: 100 };
    expect(buildHitRecord(T, data, lookup)).toEqual({
      k: 'hit', t: T, bid: 7, oid: 999, otype: 0x123, x: 10, y: 20, odist: 3.5, edist: 1.2, hp: 40, maxhp: 100,
    });
  });

  it('hit: unresolved lookups are null, not fabricated', () => {
    const data = { bulletId: 7, objectId: 999 };
    const lookup = { otype: null, x: null, y: null, odist: null, edist: null, hp: null, maxhp: null };
    const rec = buildHitRecord(T, data, lookup);
    expect(rec.otype).toBeNull();
    expect(rec.odist).toBeNull();
    expect(rec.edist).toBeNull();
  });

  it('ground', () => {
    expect(buildGroundRecord(T, { time: 0, position: { x: 5, y: 6 } })).toEqual({ k: 'ground', t: T, x: 5, y: 6 });
  });

  it('death', () => {
    expect(buildDeathRecord(T, { killedBy: 'Ghost God' })).toEqual({ k: 'death', t: T, killedBy: 'Ghost God' });
  });

  it('pshoot', () => {
    expect(buildPShootRecord(T, { bulletId: 9 })).toEqual({ k: 'pshoot', t: T, bid: 9 });
  });

  it('ehit: oid is the target hit, not the shooter', () => {
    expect(buildEHitRecord(T, { ownerId: 111, targetId: 222, kill: true })).toEqual({
      k: 'ehit', t: T, oid: 222, kill: true,
    });
  });

  it('arm', () => {
    expect(buildArmRecord(T, 'switch', 'A')).toEqual({ k: 'arm', t: T, key: 'switch', value: 'A' });
  });

  // The A/B switch interleaver calls mark('ab.start', {key, a, b, blockMinutes,
  // seed}) and mark('ab.stop', {key, restored}) — object values, not strings.
  // buildArmRecord must pass a JSON-serialisable object through unchanged (it
  // must not stringify it into `value` becoming a string, and must not reject
  // it), since the Test Lab reader expects `arm.value` to be a string OR an
  // object depending on the key.
  it('arm passes a JSON-serialisable object value through unchanged (ab.start/ab.stop shape)', () => {
    const payload = { key: 'udodgeEnemyStandoff', a: 'off', b: 'auto', blockMinutes: 3, seed: 42 };
    const rec = buildArmRecord(T, 'ab.start', payload);
    expect(rec).toEqual({ k: 'arm', t: T, key: 'ab.start', value: payload });
    expect(typeof rec.value).toBe('object');
    // And it survives a real JSON round-trip (what the writer actually does).
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });

  it('end', () => {
    expect(buildEndRecord(T, 'disabled')).toEqual({ k: 'end', t: T, reason: 'disabled' });
    expect(buildEndRecord(T, null)).toEqual({ k: 'end', t: T, reason: null });
  });
});

describe('recorderCore: projdef emitted once per (otype, bt) per file/session', () => {
  let tracker: ProjDefTracker;
  beforeEach(() => { tracker = new ProjDefTracker(); });

  const shotData = { bulletId: 1, ownerId: 999, bulletType: 0, position: { x: 0, y: 0 }, angle: 0, damage: 10 };

  it('emits projdef before the first shot using it, then never again for the same pair', () => {
    const ctx = { ownerType: 0x123, projectile: PROJ };
    const first = dispatchPacket('ENEMYSHOOT', T, shotData, ctx, tracker);
    expect(first.map((r) => r.k)).toEqual(['projdef', 'shot']);

    const second = dispatchPacket('ENEMYSHOOT', T + 100, { ...shotData, bulletId: 2 }, ctx, tracker);
    expect(second.map((r) => r.k)).toEqual(['shot']);
  });

  it('a different bulletType on the same owner gets its own projdef', () => {
    const ctx0 = { ownerType: 0x123, projectile: PROJ };
    const ctx1 = { ownerType: 0x123, projectile: { ...PROJ, speed: 20 } };
    dispatchPacket('ENEMYSHOOT', T, shotData, ctx0, tracker);
    const forBt1 = dispatchPacket('ENEMYSHOOT', T, { ...shotData, bulletType: 1 }, ctx1, tracker);
    expect(forBt1.map((r) => r.k)).toEqual(['projdef', 'shot']);
  });

  it('omits projdef when GameData has no match, but still emits the shot', () => {
    const ctx = { ownerType: 0x123, projectile: null };
    const out = dispatchPacket('ENEMYSHOOT', T, shotData, ctx, tracker);
    expect(out.map((r) => r.k)).toEqual(['shot']);
  });

  it('omits projdef when the owner type could not be resolved', () => {
    const ctx = { ownerType: null, projectile: PROJ };
    const out = dispatchPacket('ENEMYSHOOT', T, shotData, ctx, tracker);
    expect(out.map((r) => r.k)).toEqual(['shot']);
    expect((out[0] as any).otype).toBeNull();
  });
});
