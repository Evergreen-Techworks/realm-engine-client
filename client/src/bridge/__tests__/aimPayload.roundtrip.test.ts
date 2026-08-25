import { describe, it, expect } from 'vitest';
import { decodeAimPayload, AIM_SCHEMA_VERSION } from '../DllAimBus.js';

// These fixtures are the byte-for-byte output shape of the C++ encoder
// IpcMessages::EncodeAim (internal/src/core/ipc/IpcMessages.cpp). The layout is
// `1;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>`
// — exactly 11 ';'-separated tokens. If either side changes the field order or
// the version token, this test must fail; that is the whole point of the version.

describe('decodeAimPayload', () => {
  it('exposes schema version 1', () => {
    expect(AIM_SCHEMA_VERSION).toBe(1);
  });

  it('decodes a full version-1 payload', () => {
    const payload = '1;1;1;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321';
    expect(decodeAimPayload(payload)).toEqual({
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
    });
  });

  it('decodes armed=0 as armed:false rather than returning null', () => {
    const payload = '1;0;0;0;0.000;0.000;5.000;6.000;0.350;12.000;42';
    const aim = decodeAimPayload(payload);
    expect(aim).not.toBeNull();
    expect(aim!.armed).toBe(false);
    expect(aim!.mode).toBe(0);
    expect(aim!.targetId).toBe(0);
  });

  it('rejects a version other than AIM_SCHEMA_VERSION', () => {
    const payload = '2;1;0;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321';
    expect(decodeAimPayload(payload)).toBeNull();
  });

  it('rejects a 10-token payload', () => {
    const payload = '1;1;0;12345;10.500;20.250;5.000;6.000;0.350;12.000';
    expect(decodeAimPayload(payload)).toBeNull();
  });

  it('rejects a 12-token payload', () => {
    const payload = '1;1;0;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321;7';
    expect(decodeAimPayload(payload)).toBeNull();
  });

  it('rejects NaN or inf in any float token', () => {
    const floatTokenIndexes = [4, 5, 6, 7, 8, 9]; // tx, ty, px, py, standoff, maxOffset
    const base = '1;1;0;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321'.split(';');
    for (const bad of ['nan', '-nan', 'inf', '-inf', 'Infinity']) {
      for (const i of floatTokenIndexes) {
        const segs = [...base];
        segs[i] = bad;
        expect(decodeAimPayload(segs.join(';'))).toBeNull();
      }
    }
  });

  it('rejects a non-integer targetId or stamp', () => {
    const base = '1;1;0;12345;10.500;20.250;5.000;6.000;0.350;12.000;987654321'.split(';');
    for (const i of [3, 10]) {
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

// These strings are what `snprintf("%d;%d;%d;%d;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%u", ...)`
// at internal/src/core/ipc/IpcMessages.cpp:129-134 emits for the given
// IpcAim values. If the C++ format string changes, update BOTH sides.
describe('EncodeAim C++ output fixtures', () => {
  it('decodes the exact bytes EncodeAim emits for a disarmed aim', () => {
    // IpcAim{} default-constructed, stampMs = 0
    expect(decodeAimPayload('1;0;0;0;0.000;0.000;0.000;0.000;0.000;0.000;0'))
      .toEqual({
        armed: false, mode: 0, targetId: 0,
        tx: 0, ty: 0, px: 0, py: 0,
        standoffTiles: 0, maxOffsetTiles: 0, stamp: 0,
      });
  });

  it('decodes the exact bytes EncodeAim emits at KillAura defaults', () => {
    // standoff 0.35 (KillAura.cpp:25), maxOffset 12 (KillAura.cpp:26),
    // both printed with %.3f.
    const aim = decodeAimPayload(
      '1;1;0;99;41.250;13.750;40.900;13.750;0.350;12.000;4294967295');
    expect(aim).not.toBeNull();
    expect(aim!.standoffTiles).toBe(0.35);
    expect(aim!.maxOffsetTiles).toBe(12);
    expect(aim!.stamp).toBe(4294967295); // uint32 max — %u, not %d
  });
});
