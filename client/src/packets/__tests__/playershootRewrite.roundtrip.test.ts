import { describe, it, expect } from 'vitest';
import { PacketFactory } from '../PacketFactory.js';
import PACKET_DEFINITIONS from '../packetDefinitions.generated.js';
import STAT_TYPES from '../statTypes.generated.js';

// Does rewriting PLAYERSHOOT.projectilePosition produce a packet that differs
// from the original in EXACTLY the 8 bytes of that field and nowhere else?
//
// The killaura plugin's existing guard only proves serialize(UNMODIFIED) ==
// rawBytes. It never checked serialize(MODIFIED), so a re-encode that corrupts
// some other field would look armed and healthy while the server rejects the
// frame. Every time the rewrite armed in-game the server sent FAILURE and
// dropped the connection ~1.4-3.4s later, so this is the check that was missing.
describe('PLAYERSHOOT projectilePosition rewrite', () => {
  const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

  // Build a realistic PLAYERSHOOT the same way the factory reads one, so the
  // test does not depend on a captured capture file.
  function buildPlayerShoot(): Buffer {
    const p = factory.createByName('PLAYERSHOOT');
    p.data.time = 123456;
    p.data.shotId = 4242;
    p.data.containerType = 1234;
    p.data.attackIndex = 2;
    p.data.projectilePosition = { x: 100.5, y: 200.25 };
    p.data.angle = 1.25;
    p.data.bulletId = 7;
    p.data.unknownShort = -3;
    p.data.playerPosition = { x: 100.0, y: 200.0 };
    p.modified = true;
    return factory.serialize(p);
  }

  it('serializes and re-parses to the same bytes (baseline)', () => {
    const bytes = buildPlayerShoot();
    const parsed = factory.createFromBytes(bytes);
    expect(parsed.name).toBe('PLAYERSHOOT');
    expect(parsed.isDefined).toBe(true);
    const reserialized = factory.serialize(parsed);
    expect(reserialized.equals(bytes)).toBe(true);
  });

  it('changes ONLY the projectilePosition bytes when rewritten', () => {
    const original = buildPlayerShoot();
    const parsed = factory.createFromBytes(original);

    parsed.data.projectilePosition = { x: 111.5, y: 222.25 };
    parsed.modified = true;
    const rewritten = factory.serialize(parsed);

    expect(rewritten.length).toBe(original.length);

    const differing: number[] = [];
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== rewritten[i]) differing.push(i);
    }
    // Every changed byte must fall inside ONE 8-byte window (the two float32 of
    // projectilePosition). Not "exactly 8": two nearby floats can share bytes,
    // so the count varies -- what must hold is that nothing OUTSIDE that field
    // moved. A collateral change anywhere else is the corruption we are hunting.
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.length).toBeLessThanOrEqual(8);
    expect(differing[differing.length - 1] - differing[0]).toBeLessThanOrEqual(7);

    // And every other field must survive intact.
    const back = factory.createFromBytes(rewritten);
    expect(back.data.time).toBe(123456);
    expect(back.data.shotId).toBe(4242);
    expect(back.data.containerType).toBe(1234);
    expect(back.data.attackIndex).toBe(2);
    expect(back.data.angle).toBeCloseTo(1.25, 5);
    expect(back.data.bulletId).toBe(7);
    expect(back.data.unknownShort).toBe(-3);
    expect(back.data.playerPosition.x).toBeCloseTo(100.0, 5);
    expect(back.data.playerPosition.y).toBeCloseTo(200.0, 5);
    expect(back.data.projectilePosition.x).toBeCloseTo(111.5, 5);
    expect(back.data.projectilePosition.y).toBeCloseTo(222.25, 5);
  });
});
