import { describe, it, expect } from 'vitest';
import { PacketFactory } from '../PacketFactory.js';
import PACKET_DEFINITIONS from '../packetDefinitions.generated.js';
import STAT_TYPES from '../statTypes.generated.js';

// An optional field whose value equals its default used to be skipped by
// PacketFactory.writeFields even when a LATER field was still written, so every
// later field shifted on the wire. SERVERPLAYERSHOOT (12), ENEMYSHOOT (35) and
// MAPINFO (92) are the packets with an optional field before another field.
// The proxy re-serializes a packet only when a hook marks it modified, so the
// bug corrupted exactly the packets something had changed.
//
// Every frame here is synthetic and built byte by byte with Buffer, not with
// PacketWriter, so the expected bytes do not come from the code under test.
// Captured traffic never belongs in this file.

const factory = new PacketFactory(PACKET_DEFINITIONS as any, STAT_TYPES as any);

const u8 = (v: number) => Buffer.from([v & 0xff]);
const bool = (v: boolean) => u8(v ? 1 : 0);
const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const f32 = (v: number) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; };
const str = (v: string) => { const s = Buffer.from(v, 'utf8'); return Buffer.concat([i16(s.length), s]); };

/** length (int32, whole frame) + id (byte) + body, as the proxy sees a decrypted frame. */
function frame(id: number, parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([i32(5 + body.length), u8(id), body]);
}

/** The proxy's modified-packet path: parse, then serialize from the parsed fields only. */
function reserialize(bytes: Buffer): Buffer {
  const parsed = factory.createFromBytes(bytes);
  expect(parsed.isDefined).toBe(true);
  expect(parsed.unreadData.length).toBe(0);
  parsed.modified = true;
  // An empty rawBytes means a write failure returns an empty buffer instead of
  // silently handing back the original frame, which would look byte-exact.
  parsed.rawBytes = Buffer.alloc(0);
  return factory.serialize(parsed);
}

// MAPINFO's required head: width, height, name, displayName, realmName, fp,
// background, difficulty, allowPlayerTeleport, noSave, showDisplays, maxPlayers,
// gameOpenedTime, serverVersion, viewDistance.
const MAPINFO_HEAD = [
  i32(256), i32(256), str('Synthetic Map'), str('Synthetic'), str(''), i32(0x1234567),
  i32(1), f32(0.5), bool(true), bool(false), bool(true), i16(85),
  i32(1_700_000_000), str('0.0.0.0.0-test'), i16(15),
];

describe('PacketFactory optional fields at their default before a written field', () => {
  it('MAPINFO: every optional at its default except the last re-serializes byte-exactly', () => {
    const bytes = frame(92, [
      ...MAPINFO_HEAD,
      i32(0),      // bgColor (default 0)
      str(''),     // modifier (default '')
      i16(0),      // unknownShort1 (default 0)
      bool(false), // unknownBool (default false)
      i16(0),      // unknownShort2 (default 0)
      i32(0),      // maxRealmScore (default 0)
      i32(1234),   // currentRealmScore: not the default, so everything before it is on the wire
    ]);

    const out = reserialize(bytes);

    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
    expect(factory.createFromBytes(out).data.currentRealmScore).toBe(1234);
  });

  it('MAPINFO: defaults in the middle are written, and absent trailing fields stay absent', () => {
    // A non-realm shape: the realm scores are not on the wire at all.
    const bytes = frame(92, [
      ...MAPINFO_HEAD,
      i32(0x102030), // bgColor (not the default)
      str(''),       // modifier (default)
      i16(0),        // unknownShort1 (default)
      bool(false),   // unknownBool (default)
      i16(7),        // unknownShort2 (not the default): the last field on the wire
    ]);

    const parsed = factory.createFromBytes(bytes);
    // The read side is unchanged: running out of bytes means the optional is absent.
    expect(parsed.data.maxRealmScore).toBe(0);
    expect(parsed.data.currentRealmScore).toBe(0);

    const out = reserialize(bytes);
    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
  });

  it('MAPINFO: a hook edit keeps the length and every other field', () => {
    const bytes = frame(92, [...MAPINFO_HEAD, i32(0), str(''), i16(0), bool(false), i16(0), i32(0), i32(1234)]);
    const parsed = factory.createFromBytes(bytes);
    parsed.data.currentRealmScore = 4321;
    parsed.modified = true;

    const out = factory.serialize(parsed);

    expect(out.length).toBe(bytes.length);
    const back = factory.createFromBytes(out);
    expect(back.unreadData.length).toBe(0);
    expect(back.data).toEqual({ ...parsed.data, currentRealmScore: 4321 });
  });

  it('ENEMYSHOOT: numShots at its default before angleInc re-serializes byte-exactly', () => {
    const bytes = frame(35, [
      u16(513), i32(9001), u8(2), f32(10.5), f32(20.25), f32(1.5), i16(80),
      u8(255),   // numShots (default 255)
      f32(0.25), // angleInc (not the default)
    ]);

    const out = reserialize(bytes);

    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
    expect(factory.createFromBytes(out).data.angleInc).toBe(0.25);
  });

  it('SERVERPLAYERSHOOT: bulletType at its default before numShots and angleInc re-serializes byte-exactly', () => {
    const bytes = frame(12, [
      u16(700), i32(1111), i32(0xa00), f32(3.5), f32(4.5), f32(-0.75), i16(120), i32(1111),
      u8(255),  // bulletType (default 255)
      u8(3),    // numShots (not the default)
      f32(0.5), // angleInc (not the default)
    ]);

    const out = reserialize(bytes);

    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
  });

  it('a created packet writes the default for an undefined optional that precedes a written field', () => {
    const p = factory.createByName('ENEMYSHOOT');
    Object.assign(p.data, { bulletId: 1, ownerId: 2, bulletType: 3, position: { x: 1, y: 2 }, angle: 0, damage: 50, angleInc: 0.5 });
    // numShots is left undefined.

    const out = factory.serialize(p);

    expect(out.equals(frame(35, [u16(1), i32(2), u8(3), f32(1), f32(2), f32(0), i16(50), u8(255), f32(0.5)]))).toBe(true);
  });
});

describe('PacketFactory trailing optional fields', () => {
  it('SERVERPLAYERSHOOT: trailing optionals absent on the wire are not appended', () => {
    const bytes = frame(12, [
      u16(700), i32(1111), i32(0xa00), f32(3.5), f32(4.5), f32(-0.75), i16(120), i32(1111),
      u8(4), // bulletType (not the default); numShots and angleInc are not on the wire
    ]);

    const out = reserialize(bytes);

    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
  });

  it('INVENTORYSWAP: a trailing optional left undefined or at its default is omitted, and written otherwise', () => {
    const base = {
      time: 42,
      position: { x: 5, y: 6 },
      slotObject1: { objectId: 10, slotId: 4, objectType: 2594 },
      slotObject2: { objectId: 10, slotId: 5, objectType: -1 },
    };
    const head = [i32(42), f32(5), f32(6), i32(10), i32(4), i32(2594), i32(10), i32(5), i32(-1)];
    const build = (extra: Record<string, unknown>) => {
      const p = factory.createByName('INVENTORYSWAP');
      Object.assign(p.data, base, extra);
      return factory.serialize(p);
    };

    expect(build({}).equals(frame(55, head))).toBe(true);
    expect(build({ tickId: 0 }).equals(frame(55, head))).toBe(true);
    expect(build({ tickId: 77 }).equals(frame(55, [...head, i32(77)]))).toBe(true);
  });
});
