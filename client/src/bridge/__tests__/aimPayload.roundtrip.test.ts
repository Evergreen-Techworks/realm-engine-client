import { describe, it, expect } from 'vitest';
import { decodeAimPayload, AIM_SCHEMA_VERSION } from '../DllAimBus.js';

// These fixtures are the byte-for-byte output shape of the C++ encoder
// IpcMessages::EncodeAim (internal/src/core/ipc/IpcMessages.cpp). The v2 layout is
// `2;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>`
// `;<originValid>;<ox>;<oy>;<generation>`
// — exactly 15 ';'-separated tokens. If either side changes the field order or
// the version token, this test must fail; that is the whole point of the version.
//
// v2 exists because the shot origin used to be solved TWICE — once in the DLL at
// projectile spawn, once here in the client from tx/ty/standoff — and the two
// could disagree, so the server refused the resulting hit claims. The wire now
// carries the DLL's ONE solved origin (ox/oy) plus the refresh `generation` that
// produced it. The four trailing tokens are that contract.

/** A full v2 payload as EncodeAim emits it, as a token array for mutation. */
const V2 = '2;1;1;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321;1;10.150;20.250;77';

describe('decodeAimPayload', () => {
  it('exposes schema version 2', () => {
    expect(AIM_SCHEMA_VERSION).toBe(2);
  });

  it('decodes a full version-2 payload', () => {
    expect(decodeAimPayload(V2)).toEqual({
      armed: true,
      mode: 1,
      targetId: 12345,
      tx: 10.5,
      ty: 20.25,
      px: 5,
      py: 6,
      standoffTiles: 0.35,
      maxOffsetTiles: 12,
      stamp: 987654321,
      originValid: true,
      ox: 10.15,
      oy: 20.25,
      generation: 77,
    });
  });

  it('decodes armed=0 as armed:false rather than returning null', () => {
    const payload = '2;0;0;0;0.000;0.000;5.000;6.000;0.350;12.000;42;0;0.000;0.000;9';
    const aim = decodeAimPayload(payload);
    expect(aim).not.toBeNull();
    expect(aim!.armed).toBe(false);
    expect(aim!.mode).toBe(0);
    expect(aim!.targetId).toBe(0);
  });

  // originValid is the DLL saying "this refresh solved no origin" (the
  // standoff/maxOffset caps refused it). It must survive the decode as a
  // first-class false, NOT as a null payload — the consumer's job is to skip the
  // rewrite, and it can only do that if it still sees the rest of the sample.
  it('decodes originValid=0 as a valid sample with originValid:false', () => {
    const segs = V2.split(';');
    segs[11] = '0';
    const aim = decodeAimPayload(segs.join(';'));
    expect(aim).not.toBeNull();
    expect(aim!.originValid).toBe(false);
    expect(aim!.armed).toBe(true);
    expect(aim!.generation).toBe(77);
  });

  it('rejects a version other than AIM_SCHEMA_VERSION', () => {
    const segs = V2.split(';');
    segs[0] = '3';
    expect(decodeAimPayload(segs.join(';'))).toBeNull();
  });

  // A v1 producer against a v2 decoder: right version-token shape, wrong token
  // count AND wrong version. Both gates must hold.
  it('rejects a v1 (11-token) payload outright', () => {
    expect(decodeAimPayload(
      '1;1;1;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321')).toBeNull();
  });

  it('rejects a 14-token payload', () => {
    expect(decodeAimPayload(V2.split(';').slice(0, 14).join(';'))).toBeNull();
  });

  it('rejects a 16-token payload', () => {
    expect(decodeAimPayload(V2 + ';7')).toBeNull();
  });

  it('rejects NaN or inf in any float token', () => {
    // tx, ty, px, py, standoff, maxOffset, ox, oy
    const floatTokenIndexes = [4, 5, 6, 7, 8, 9, 12, 13];
    const base = V2.split(';');
    for (const bad of ['nan', '-nan', 'inf', '-inf', 'Infinity']) {
      for (const i of floatTokenIndexes) {
        const segs = [...base];
        segs[i] = bad;
        expect(decodeAimPayload(segs.join(';'))).toBeNull();
      }
    }
  });

  it('rejects a non-integer targetId, stamp, or generation', () => {
    const base = V2.split(';');
    for (const i of [3, 10, 14]) {
      const segs = [...base];
      segs[i] = '1.5';
      expect(decodeAimPayload(segs.join(';'))).toBeNull();
      segs[i] = 'nan';
      expect(decodeAimPayload(segs.join(';'))).toBeNull();
    }
  });

  it('returns null for an empty string', () => {
    expect(decodeAimPayload('')).toBeNull();
  });
});

// These strings are what
// `snprintf("%d;%d;%d;%d;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%u;%d;%.3f;%.3f;%u", ...)`
// at internal/src/core/ipc/IpcMessages.cpp emits for the given IpcAim values.
// If the C++ format string changes, update BOTH sides.
describe('EncodeAim C++ output fixtures', () => {
  it('decodes the exact bytes EncodeAim emits for a disarmed aim', () => {
    // IpcAim{} default-constructed, stampMs = 0, generation = 0
    expect(decodeAimPayload('2;0;0;0;0.000;0.000;0.000;0.000;0.000;0.000;0;0;0.000;0.000;0'))
      .toEqual({
        armed: false, mode: 0, targetId: 0,
        tx: 0, ty: 0, px: 0, py: 0,
        standoffTiles: 0, maxOffsetTiles: 0, stamp: 0,
        originValid: false, ox: 0, oy: 0, generation: 0,
      });
  });

  it('decodes the exact bytes EncodeAim emits at KillAura defaults', () => {
    // standoff 0.35, maxOffset 12 (KillAura.cpp), both printed with %.3f.
    const aim = decodeAimPayload(
      '2;1;0;99;41.250;13.750;40.900;13.750;0.350;12.000;4294967295;1;40.900;13.750;123456');
    expect(aim).not.toBeNull();
    expect(aim!.standoffTiles).toBe(0.35);
    expect(aim!.maxOffsetTiles).toBe(12);
    expect(aim!.stamp).toBe(4294967295);      // uint32 max — %u, not %d
    expect(aim!.generation).toBe(123456);
  });

  // uint32 generation is emitted with %u, so it must survive past 2^31 without
  // being read back as a negative or a float.
  it('decodes a generation at uint32 max', () => {
    const segs = V2.split(';');
    segs[14] = '4294967295';
    expect(decodeAimPayload(segs.join(';'))!.generation).toBe(4294967295);
  });

  // The whole point of v2: the origin the DLL solved arrives verbatim, so the
  // outbound rewrite forwards a value rather than re-deriving one. This fixture
  // is the origin for standoff 0.35 at angle 0 against target (10.5, 20.25) —
  // the DLL's own arithmetic, NOT repeated on this side.
  it('carries the solved origin verbatim rather than its ingredients', () => {
    const aim = decodeAimPayload(V2)!;
    expect(aim.ox).toBe(10.15);
    expect(aim.oy).toBe(20.25);
    // ...and it is NOT recomputed from tx/standoff by the decoder.
    expect(aim.ox).not.toBe(aim.tx);
  });
});
