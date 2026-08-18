import { describe, it, expect } from 'vitest';
import { decodeThreatPayload, THREAT_SCHEMA_VERSION } from '../DllThreatBus.js';

// These fixtures are the byte-for-byte output shape of the C++ encoder
// IpcMessages::EncodeThreats (internal/src/core/ipc/IpcMessages.cpp). The layout
// is `1;<ground>;<threats>;<T>`. If either side changes the field order or the
// version token, this test must fail — that is the whole point of the version.

describe('decodeThreatPayload', () => {
  it('exposes schema version 1', () => {
    expect(THREAT_SCHEMA_VERSION).toBe(1);
  });

  it('decodes a full version-1 payload (truncated=0)', () => {
    const payload = '1;10:200|5:250;7:9:180.0:40:1,8:9:190.0:35:0;0';
    const { threats, ground, truncated } = decodeThreatPayload(payload);

    expect(threats).toEqual([
      { attackerObjId: 7, bulletId: 9, tHitMs: 180, fallbackDamage: 40, fallbackArmorPiercing: true },
      { attackerObjId: 8, bulletId: 9, tHitMs: 190, fallbackDamage: 35, fallbackArmorPiercing: false },
    ]);
    // The leading ground summary segment (10:200) is skipped; ground
    // rawDamage/tHitMs come from the first event, matching the DLL projection.
    expect(ground).toEqual({
      rawDamage: 5,
      tHitMs: 250,
      events: [{ rawDamage: 5, tHitMs: 250 }],
    });
    expect(truncated).toBe(false);
  });

  it('reads the trailing truncated flag (truncated=1)', () => {
    const payload = '1;10:200|5:250;7:9:180.0:40:1,8:9:190.0:35:0;1';
    const { threats, truncated } = decodeThreatPayload(payload);
    expect(threats).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('rejects a version other than THREAT_SCHEMA_VERSION (returns empty)', () => {
    const payload = '2;10:200|5:250;7:9:180.0:40:1;0';
    const { threats, ground, truncated } = decodeThreatPayload(payload);
    expect(threats).toEqual([]);
    expect(ground).toEqual({ rawDamage: 0, tHitMs: -1, events: [] });
    expect(truncated).toBe(false);
  });

  it('decodes a payload with no threats', () => {
    const payload = '1;10:200|5:250;;0';
    const { threats, ground, truncated } = decodeThreatPayload(payload);
    expect(threats).toEqual([]);
    expect(ground.events).toEqual([{ rawDamage: 5, tHitMs: 250 }]);
    expect(truncated).toBe(false);
  });

  it('returns empty for an empty string', () => {
    const { threats, ground, truncated } = decodeThreatPayload('');
    expect(threats).toEqual([]);
    expect(ground).toEqual({ rawDamage: 0, tHitMs: -1, events: [] });
    expect(truncated).toBe(false);
  });
});
