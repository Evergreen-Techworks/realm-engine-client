import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { PacketFactory, parsePacketKey, type DefsFile } from '../PacketFactory.js';
import PACKET_DEFINITIONS from '../packetDefinitions.generated.js';
import STAT_TYPES from '../statTypes.generated.js';
import { Proxy } from '../../proxy/Proxy.js';
import { ClientConnection } from '../../proxy/ClientConnection.js';
import type { Packet } from '../Packet.js';
// The build scripts' copy of the key grammar (they run under plain node and
// cannot import TypeScript). The two must agree; see the last describe block.
import { keyPackets, parsePacketKey as parseScriptPacketKey, packetKeyProblems } from '../../../scripts/lib/packet-keys.mjs';

// RotMG reuses some packet ids with a different packet in each direction. On
// game 86ad651b the binary's own serializers/deserializers show exactly two:
//
//   215 C->S  PartyJoinRequest          uint32
//   215 S->C  PartyJoinRequest          uint32, PartyResponse enum   (realmlib: PartyJoinResult)
//   217 C->S  PartyJoinRequestResponse  string, uint16, uint16, byte
//   217 S->C  PartyRequestResponse      string, uint16, uint16, PartyResponse enum
//
// PacketFactory used to key definitions by id alone, so one direction of each
// was decoded with the other direction's layout. Every frame here is synthetic
// and built byte by byte with Buffer, not with PacketWriter, so the expected
// bytes do not come from the code under test. Captured traffic never belongs here.

const factory = new PacketFactory(PACKET_DEFINITIONS as DefsFile, STAT_TYPES as any);

const u8 = (v: number) => Buffer.from([v & 0xff]);
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const str = (v: string) => { const s = Buffer.from(v, 'utf8'); const n = Buffer.alloc(2); n.writeInt16BE(s.length); return Buffer.concat([n, s]); };

/** length (int32, whole frame) + id (byte) + body, as the proxy sees a decrypted frame. */
function frame(id: number, parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([i32(5 + body.length), u8(id), body]);
}

/** The proxy's modified-packet path: parse, then serialize from the parsed fields only. */
function reserialize(packet: Packet): Buffer {
  packet.modified = true;
  // An empty rawBytes means a write failure returns an empty buffer instead of
  // silently handing back the original frame, which would look byte-exact.
  packet.rawBytes = Buffer.alloc(0);
  return factory.serialize(packet);
}

const PARTY_ID = 3_000_000_001; // above int32 max: proves uint32
const PENDING = 1;
const ACCEPTED = 3;

const C2S_215_SHORT = frame(215, [u32(PARTY_ID)]);
const C2S_215_TAIL = frame(215, [u32(PARTY_ID), u8(PENDING)]);
const S2C_215 = frame(215, [u32(PARTY_ID), u8(ACCEPTED)]);
const S2C_217 = frame(217, [str('Requester'), u16(0x0307), u16(0x1234), u8(PENDING)]);
const C2S_217 = frame(217, [str('Requester'), u16(0x0307), u16(0x1234), u8(ACCEPTED)]);

describe('packet definitions are keyed by (direction, id)', () => {
  it('215 C->S decodes with the client layout, with and without the optional tail', () => {
    const short = factory.createFromBytes(C2S_215_SHORT, 'client');
    expect(short).toMatchObject({ id: 215, name: 'PARTYJOINREQUEST', direction: 'client', isDefined: true });
    expect(short.data.partyId).toBe(PARTY_ID);
    expect(short.data.unknownByte).toBeUndefined();
    expect(short.unreadData.length).toBe(0);
    expect(reserialize(short).equals(C2S_215_SHORT)).toBe(true);

    const tail = factory.createFromBytes(C2S_215_TAIL, 'client');
    expect(tail).toMatchObject({ name: 'PARTYJOINREQUEST', direction: 'client', isDefined: true });
    expect(tail.data).toEqual({ partyId: PARTY_ID, unknownByte: PENDING });
    expect(tail.unreadData.length).toBe(0);
    expect(reserialize(tail).equals(C2S_215_TAIL)).toBe(true);
  });

  it('215 S->C decodes with the server layout', () => {
    const p = factory.createFromBytes(S2C_215, 'server');
    expect(p).toMatchObject({ id: 215, name: 'PARTYJOINRESULT', direction: 'server', isDefined: true });
    expect(p.data).toEqual({ partyId: PARTY_ID, state: ACCEPTED });
    expect(p.unreadData.length).toBe(0);
    expect(reserialize(p).equals(S2C_215)).toBe(true);
  });

  it('a server 215 without its state byte is a parse failure, not a client packet', () => {
    const p = factory.createFromBytes(C2S_215_SHORT, 'server');
    expect(p.name).toBe('PARTYJOINRESULT');
    expect(p.isDefined).toBe(false);
    expect(factory.serialize(p).equals(C2S_215_SHORT)).toBe(true); // raw passthrough
  });

  it('217 decodes as a different packet in each direction, each byte-exact', () => {
    const s = factory.createFromBytes(S2C_217, 'server');
    expect(s).toMatchObject({ id: 217, name: 'PARTYJOINREQUESTRESPONSE', direction: 'server', isDefined: true });
    expect(s.data).toEqual({ name: 'Requester', classId: 0x0307, skinId: 0x1234, state: PENDING });
    expect(reserialize(s).equals(S2C_217)).toBe(true);

    const c = factory.createFromBytes(C2S_217, 'client');
    expect(c).toMatchObject({ id: 217, name: 'PARTYJOINRESPONSE', direction: 'client', isDefined: true });
    expect(c.data).toEqual({ name: 'Requester', classId: 0x0307, skinId: 0x1234, state: ACCEPTED });
    expect(reserialize(c).equals(C2S_217)).toBe(true);
  });

  it('an edited packet re-encodes with its own direction\'s layout', () => {
    const p = factory.createFromBytes(S2C_215, 'server');
    p.data.state = PENDING;
    expect(reserialize(p).equals(frame(215, [u32(PARTY_ID), u8(PENDING)]))).toBe(true);

    const c = factory.createFromBytes(C2S_215_TAIL, 'client');
    delete c.data.unknownByte;
    expect(reserialize(c).equals(C2S_215_SHORT)).toBe(true);
  });

  it('a frame at an id defined only for the other direction passes through undecoded', () => {
    // TELEPORT (1) is client-only; NEWTICK (10) is server-only.
    for (const [id, direction] of [[1, 'server'], [10, 'client']] as const) {
      const bytes = frame(id, [i32(7), str('x')]);
      const p = factory.createFromBytes(bytes, direction);
      expect(p).toMatchObject({ id, name: `UNKNOWN_${id}`, isDefined: false });
      expect(factory.serialize(p).equals(bytes)).toBe(true);
    }
  });

  it('refuses to decode a frame without a direction', () => {
    expect(() => (factory as any).createFromBytes(S2C_215)).toThrow(/direction/);
    expect(() => (factory as any).createFromBytes(S2C_215, 'unknown')).toThrow(/direction/);
  });
});

describe('name lookup at a shared id', () => {
  it('createByName carries the right id and direction, and survives the wire', () => {
    const cases = [
      ['PARTYJOINREQUEST', 215, 'client', { partyId: 42 }],
      ['PARTYJOINRESULT', 215, 'server', { partyId: 42, state: ACCEPTED }],
      ['PARTYJOINREQUESTRESPONSE', 217, 'server', { name: 'a', classId: 1, skinId: 2, state: PENDING }],
      ['PARTYJOINRESPONSE', 217, 'client', { name: 'a', classId: 1, skinId: 2, state: ACCEPTED }],
    ] as const;
    for (const [name, id, direction, data] of cases) {
      const p = factory.createByName(name);
      expect(p).toMatchObject({ id, name, direction, isDefined: true });
      Object.assign(p.data, data);
      const bytes = factory.serialize(p);
      expect(bytes[4]).toBe(id);
      const back = factory.createFromBytes(bytes, direction);
      expect(back.name).toBe(name);
      expect(back.data).toEqual(data);
      expect(factory.getPacketId(name)).toBe(id);
      expect(factory.getPacketName(id, direction)).toBe(name);
    }
  });

  it('the party bridge\'s join request is still the 5-byte frame it always sent', () => {
    const p = factory.createByName('PARTYJOINREQUEST');
    p.data = { partyId: PARTY_ID, unknownByte: 0 };
    p.modified = true;
    expect(factory.serialize(p).equals(frame(215, [u32(PARTY_ID), u8(0)]))).toBe(true);
  });

  it('getPacketName names an undefined (direction, id) as unknown', () => {
    expect(factory.getPacketName(1, 'server')).toBe('UNKNOWN_1');
    expect(factory.getPacketName(1, 'client')).toBe('TELEPORT');
  });
});

describe('the proxy decodes each frame in the direction it travelled', () => {
  function connection() {
    const proxy = new Proxy(factory);
    const clientSocket = Object.assign(new EventEmitter(), {
      setNoDelay() {}, destroyed: false, written: [] as Buffer[],
      write(b: Buffer) { this.written.push(Buffer.from(b)); return true; },
    });
    const serverSocket = { destroyed: false, written: [] as Buffer[], write(b: Buffer) { this.written.push(Buffer.from(b)); return true; } };
    const conn = new ClientConnection(proxy, clientSocket as any);
    // Plaintext stand-ins for the four RC4 streams.
    const plain = { cipher() {} };
    Object.assign(conn as any, {
      serverSocket, clientReceiveCipher: plain, clientSendCipher: plain, serverReceiveCipher: plain, serverSendCipher: plain,
    });
    const seen: string[] = [];
    for (const name of ['PARTYJOINREQUEST', 'PARTYJOINRESULT', 'PARTYJOINREQUESTRESPONSE', 'PARTYJOINRESPONSE']) {
      proxy.hookPacket(name, (_c, packet) => { seen.push(`${packet.direction}:${packet.name}`); });
    }
    return { proxy, conn, clientSocket, serverSocket, seen };
  }

  it('fires the hook for the packet each direction really carries, and forwards bytes untouched', () => {
    const { conn, clientSocket, serverSocket, seen } = connection();
    clientSocket.emit('data', C2S_215_SHORT);
    (conn as any).onServerData(S2C_215);
    (conn as any).onServerData(S2C_217);
    clientSocket.emit('data', C2S_217);

    expect(seen).toEqual([
      'client:PARTYJOINREQUEST', 'server:PARTYJOINRESULT', 'server:PARTYJOINREQUESTRESPONSE', 'client:PARTYJOINRESPONSE',
    ]);
    expect(serverSocket.written).toEqual([C2S_215_SHORT, C2S_217]);
    expect(clientSocket.written).toEqual([S2C_215, S2C_217]);
  });

  it('a hook edit on a server 215 is re-encoded with the server layout', () => {
    const { proxy, conn, clientSocket } = connection();
    proxy.hookPacket('PARTYJOINRESULT', (_c, packet) => { packet.data.state = PENDING; packet.modified = true; });
    (conn as any).onServerData(S2C_215);
    expect(clientSocket.written).toEqual([frame(215, [u32(PARTY_ID), u8(PENDING)])]);
  });
});

describe('loading definitions', () => {
  const field = { name: 'v', type: 'byte' };
  const load = (packets: Record<string, unknown>) => new PacketFactory({ packets, dataObjects: {} } as any, { stringStats: [] });

  it('accepts a plain key per id and a qualified key per direction at a shared id', () => {
    const f = load({
      '9': { name: 'A', direction: 'client', fields: [field] },
      'client:215': { name: 'B', direction: 'client', fields: [field] },
      'server:215': { name: 'C', direction: 'server', fields: [field] },
    });
    expect(f.getPacketName(9, 'client')).toBe('A');
    expect(f.getPacketName(215, 'client')).toBe('B');
    expect(f.getPacketName(215, 'server')).toBe('C');
  });

  it('refuses definitions that would make a lookup ambiguous or wrong', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['malformed key', { '21x': { name: 'A', direction: 'client', fields: [] } }],
      ['id above 255', { '256': { name: 'A', direction: 'client', fields: [] } }],
      ['qualifier disagrees with direction', { 'server:215': { name: 'A', direction: 'client', fields: [] } }],
      ['unknown direction', { '5': { name: 'A', direction: 'both', fields: [] } }],
      ['two packets at one (direction, id)', {
        '215': { name: 'A', direction: 'client', fields: [] },
        'client:215': { name: 'B', direction: 'client', fields: [] },
      }],
      ['duplicate name', {
        '1': { name: 'A', direction: 'client', fields: [] },
        '2': { name: 'A', direction: 'server', fields: [] },
      }],
    ];
    for (const [why, packets] of bad) expect(() => load(packets), why).toThrow();
  });
});

describe('the key grammar is the same in the factory and the build scripts', () => {
  const keys = ['0', '9', '10', '99', '215', '255', 'client:215', 'server:215', 'server:0',
    '256', 'client:256', '-1', '01', '1.0', ' 1', 'client:', ':215', 'Client:215', 'both:215', '215:client', 'client:server:215', 'client:01', 'x', ''];

  it('parses every key identically', () => {
    for (const key of keys) expect(parseScriptPacketKey(key), key).toEqual(parsePacketKey(key));
  });

  it('the canonical file has canonical keys', () => {
    expect(packetKeyProblems((PACKET_DEFINITIONS as DefsFile).packets)).toEqual([]);
  });

  it('keyPackets turns moved ids into canonical keys, splitting and merging shared ids', () => {
    const def = (name: string, direction: string) => ({ name, direction, fields: [] });
    const A = def('A', 'client'), B = def('B', 'server'), C = def('C', 'server'), D = def('D', 'client');
    const keyed = keyPackets([{ id: 217, packet: A }, { id: 9, packet: C }, { id: 217, packet: B }, { id: 5, packet: D }]);
    expect(Object.keys(keyed)).toEqual(['5', '9', 'client:217', 'server:217']);
    expect(keyed).toEqual({ '5': D, '9': C, 'client:217': A, 'server:217': B });
    expect(packetKeyProblems(keyed)).toEqual([]);
    // A pair whose client packet moves away becomes a plain key again.
    expect(Object.keys(keyPackets([{ id: 218, packet: A }, { id: 217, packet: B }]))).toEqual(['217', '218']);
    expect(() => keyPackets([{ id: 9, packet: A }, { id: 9, packet: D }])).toThrow(/two client packets at id 9/);
  });

  it('packetKeyProblems names what is wrong with a non-canonical packets object', () => {
    const def = (name: string, direction: string) => ({ name, direction, fields: [] });
    const problems = (packets: Record<string, unknown>) => packetKeyProblems(packets);
    const same = problems({ 'client:215': def('A', 'client'), 'server:215': def('B', 'client') }).join('\n');
    expect(same).toMatch(/more than one client packet/);
    expect(same).not.toMatch(/one packet, so/);
    expect(problems({ '215': def('A', 'client'), 'server:215': def('B', 'server') }).join('\n')).toMatch(/215/);
    expect(problems({ 'client:215': def('A', 'client') }).join('\n')).toMatch(/one packet/);
    expect(problems({ 'client:215': def('A', 'server'), 'server:215': def('B', 'server') }).join('\n')).toMatch(/direction/);
    expect(problems({ 'client:217': def('A', 'client'), 'server:217': def('B', 'server'), 'client:215': def('C', 'client'), 'server:215': def('D', 'server') }).join('\n')).toMatch(/order/);
    expect(problems({ 'abc': def('A', 'client') }).join('\n')).toMatch(/abc/);
  });
});
