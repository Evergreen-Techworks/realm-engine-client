import { PacketFactory } from '../../PacketFactory.js';
import PACKET_DEFINITIONS from '../../packetDefinitions.generated.js';
import STAT_TYPES from '../../statTypes.generated.js';

export interface ShotTrace {
  pinHash: string;
  caseName: string;
  mode: 'native' | 'script';
  frames: Array<{ atMs: number; bytesHex: string; verifiedAngleByteOffsets: number[] }>;
  expectedProjectileCounts: number[];
  cadenceToleranceMs: number;
}

export interface TraceReview {
  pinHash: string;
  caseName: string;
  provenance: string;
  allowedAngleByteOffsets: number[];
}

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function validateShotTrace(trace: ShotTrace, review: TraceReview): Buffer[] {
  requireEvidence(/^[a-f0-9]{64}$/.test(trace.pinHash) && trace.pinHash === review.pinHash, 'missing or mismatched pin');
  requireEvidence(Boolean(review.provenance.trim()) && Boolean(trace.caseName.trim()) && trace.caseName === review.caseName,
    'missing provenance or mismatched case');
  requireEvidence(trace.mode === 'native' || trace.mode === 'script', 'invalid mode');
  requireEvidence(Number.isFinite(trace.cadenceToleranceMs) && trace.cadenceToleranceMs >= 0, 'invalid cadence tolerance');
  requireEvidence(trace.frames.length > 0 && trace.expectedProjectileCounts.length > 0 &&
    trace.expectedProjectileCounts.every(count => Number.isSafeInteger(count) && count > 0) &&
    trace.expectedProjectileCounts.reduce((total, count) => total + count, 0) === trace.frames.length, 'invalid reviewed counts');
  let previousTime = -1;
  return trace.frames.map(frame => {
    requireEvidence(Number.isFinite(frame.atMs) && frame.atMs >= 0 && frame.atMs >= previousTime, 'invalid frame time');
    previousTime = frame.atMs;
    requireEvidence(/^(?:[a-f0-9]{2})+$/i.test(frame.bytesHex), 'invalid frame hex');
    const bytes = Buffer.from(frame.bytesHex, 'hex');
    requireEvidence(bytes.length >= 5 && bytes.readInt32BE(0) === bytes.length, 'invalid frame length');
    const packet = factory.createFromBytes(bytes, 'client');
    requireEvidence(packet.isDefined && packet.name === 'PLAYERSHOOT' && factory.serialize(packet).equals(bytes), 'invalid PLAYERSHOOT roundtrip');
    requireEvidence(new Set(frame.verifiedAngleByteOffsets).size === frame.verifiedAngleByteOffsets.length &&
      frame.verifiedAngleByteOffsets.every(offset => Number.isSafeInteger(offset) && offset >= 5 && offset < bytes.length &&
        review.allowedAngleByteOffsets.includes(offset)), 'unsupported angle offsets');
    return bytes;
  });
}

export function verifyShotRewrite(trace: ShotTrace, review: TraceReview, frameIndex: number, rewritten: Buffer): void {
  const original = validateShotTrace(trace, review)[frameIndex];
  requireEvidence(Boolean(original) && original.length === rewritten.length, 'invalid rewritten frame length');
  const allowed = new Set(trace.frames[frameIndex].verifiedAngleByteOffsets);
  for (let offset = 0; offset < original.length; offset++)
    requireEvidence(original[offset] === rewritten[offset] || allowed.has(offset), 'non-angle byte changed');
  const before = factory.createFromBytes(original, 'client');
  const after = factory.createFromBytes(rewritten, 'client');
  requireEvidence(after.isDefined && factory.serialize(after).equals(rewritten), 'invalid rewritten PLAYERSHOOT');
  for (const field of ['attackIndex', 'bulletId', 'unknownShort'])
    requireEvidence(before.data[field] === after.data[field], `protected ${field} changed`);
  requireEvidence(before.unreadData.equals(after.unreadData), 'opaque trailing bytes changed');
}

export function compareShotTraces(native: ShotTrace, nativeReview: TraceReview, script: ShotTrace, scriptReview: TraceReview): void {
  const nativeFrames = validateShotTrace(native, nativeReview);
  const scriptFrames = validateShotTrace(script, scriptReview);
  requireEvidence(native.mode === 'native' && script.mode === 'script' && native.pinHash === script.pinHash &&
    native.caseName === script.caseName, 'incompatible trace pair');
  requireEvidence(JSON.stringify(native.expectedProjectileCounts) === JSON.stringify(script.expectedProjectileCounts), 'projectile count mismatch');
  requireEvidence(native.cadenceToleranceMs === script.cadenceToleranceMs, 'inconsistent reviewed cadence tolerance');
  let frameIndex = 0;
  let previousNative = native.frames[0].atMs;
  let previousScript = script.frames[0].atMs;
  for (const count of native.expectedProjectileCounts) {
    const nativeTime = native.frames[frameIndex].atMs;
    const scriptTime = script.frames[frameIndex].atMs;
    requireEvidence(Math.abs((nativeTime - previousNative) - (scriptTime - previousScript)) <= native.cadenceToleranceMs,
      'volley cadence mismatch');
    previousNative = nativeTime;
    previousScript = scriptTime;
    for (let projectile = 0; projectile < count; projectile++) {
      const nativePacket = factory.createFromBytes(nativeFrames[frameIndex], 'client');
      const scriptPacket = factory.createFromBytes(scriptFrames[frameIndex], 'client');
      requireEvidence(nativePacket.data.containerType === scriptPacket.data.containerType &&
        nativePacket.data.attackIndex === scriptPacket.data.attackIndex, 'weapon/subattack pattern mismatch');
      requireEvidence(Math.abs((native.frames[frameIndex].atMs - nativeTime) -
        (script.frames[frameIndex].atMs - scriptTime)) <= native.cadenceToleranceMs, 'projectile cadence mismatch');
      frameIndex++;
    }
  }
}
