import { describe, expect, it } from 'vitest';
import { PacketFactory } from '../PacketFactory.js';
import PACKET_DEFINITIONS from '../packetDefinitions.generated.js';
import STAT_TYPES from '../statTypes.generated.js';
import { compareShotTraces, validateShotTrace, verifyShotRewrite, type ShotTrace, type TraceReview } from './helpers/shootingTrace.js';

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

function synthetic(): { trace: ShotTrace; review: TraceReview } {
  const packet = factory.createByName('PLAYERSHOOT');
  packet.data = { time: 123, shotId: 42, containerType: 1234, attackIndex: 2,
    projectilePosition: { x: 100, y: 200 }, angle: 1.25, bulletId: 7,
    unknownShort: -3, playerPosition: { x: 100, y: 200 } };
  packet.unreadData = Buffer.from([0xde, 0xad]);
  const bytes = factory.serialize(packet);
  packet.data.angle = -2.5;
  const changed = factory.serialize(packet);
  const offsets = [...bytes.keys()].filter(offset => bytes[offset] !== changed[offset]);
  const trace: ShotTrace = { pinHash: 'a'.repeat(64), caseName: 'synthetic-validator-only', mode: 'native',
    frames: [0, 100].map(atMs => ({ atMs, bytesHex: bytes.toString('hex'), verifiedAngleByteOffsets: offsets })),
    expectedProjectileCounts: [1, 1], cadenceToleranceMs: 2 };
  return { trace, review: { pinHash: trace.pinHash, caseName: trace.caseName,
    provenance: 'Synthetic unit test; NOT a captured or accepted game trace', allowedAngleByteOffsets: offsets } };
}

describe('synthetic shooting replay prerequisites (not gameplay acceptance)', () => {
  it('validates and roundtrips opaque trailing bytes', () => {
    const { trace, review } = synthetic();
    const frames = validateShotTrace(trace, review);
    for (const bytes of frames) expect(factory.serialize(factory.createFromBytes(bytes, 'client'))).toEqual(bytes);
  });

  it.each(['pin', 'provenance', 'time', 'order', 'hex', 'length', 'offset', 'counts', 'tolerance'])(
    'rejects invalid %s', defect => {
      const { trace, review } = synthetic();
      if (defect === 'pin') trace.pinHash = '';
      if (defect === 'provenance') review.provenance = '';
      if (defect === 'time') trace.frames[0].atMs = -1;
      if (defect === 'order') { trace.frames[0].atMs = 10; trace.frames[1].atMs = 5; }
      if (defect === 'hex') trace.frames[0].bytesHex = 'gg';
      if (defect === 'length') trace.frames[0].bytesHex += '00';
      if (defect === 'offset') trace.frames[0].verifiedAngleByteOffsets = [5];
      if (defect === 'counts') trace.expectedProjectileCounts = [3];
      if (defect === 'tolerance') trace.cadenceToleranceMs = NaN;
      expect(() => validateShotTrace(trace, review)).toThrow();
    });

  it('allows reviewed aim changes but rejects any opaque-byte mutation', () => {
    const { trace, review } = synthetic();
    const bytes = validateShotTrace(trace, review)[0];
    const packet = factory.createFromBytes(bytes, 'client');
    packet.data.angle = -2.5;
    const rewritten = factory.serialize(packet);
    expect(() => verifyShotRewrite(trace, review, 0, rewritten)).not.toThrow();
    for (const key of ['attackIndex', 'bulletId', 'unknownShort'])
      expect(factory.createFromBytes(rewritten, 'client').data[key]).toBe(packet.data[key]);
    rewritten[rewritten.length - 1] ^= 1;
    expect(() => verifyShotRewrite(trace, review, 0, rewritten)).toThrow(/non-angle/);
  });

  it('compares reviewed counts and intervals without comparing unrelated shot IDs', () => {
    const { trace, review } = synthetic();
    const script = structuredClone(trace);
    script.mode = 'script';
    script.frames.forEach(frame => { frame.atMs += 500; });
    const packet = factory.createFromBytes(Buffer.from(script.frames[0].bytesHex, 'hex'), 'client');
    packet.data.shotId = 900;
    packet.data.bulletId = 99;
    script.frames[0].bytesHex = factory.serialize(packet).toString('hex');
    expect(() => compareShotTraces(trace, review, script, review)).not.toThrow();
    script.frames[1].atMs += 10;
    expect(() => compareShotTraces(trace, review, script, review)).toThrow(/cadence/);
  });

  it('rejects changed weapon/subattack sequence and mismatched pins', () => {
    const { trace, review } = synthetic();
    const script = structuredClone(trace);
    script.mode = 'script';
    const packet = factory.createFromBytes(Buffer.from(script.frames[1].bytesHex, 'hex'), 'client');
    packet.data.attackIndex = 3;
    script.frames[1].bytesHex = factory.serialize(packet).toString('hex');
    expect(() => compareShotTraces(trace, review, script, review)).toThrow(/pattern/);
    script.pinHash = 'b'.repeat(64);
    expect(() => compareShotTraces(trace, review, script, review)).toThrow(/pin/);
  });
});
