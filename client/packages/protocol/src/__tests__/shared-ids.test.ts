import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { BIDIR_PACKET_MAP, OUTGOING_AT_SHARED_IDS, PACKET_DIRECTION, PACKET_MAP } from '../generated/packet-map.js';
import { PacketIO } from '../packetio.js';
import { RawPacket } from '../registry.js';

// Ids 215 and 217 carry a different packet in each direction (game 86ad651b).
// PacketIO plays the game client: numeric lookups name frames it RECEIVES, name
// lookups give the id of frames it SENDS. So at a shared id the number resolves to
// the incoming packet and both names resolve to the id -- upstream realmlib's rule
// (packet-map.ts: "always let an incoming definition win when an id is reused").
describe('packet ids shared by an incoming and an outgoing packet', () => {
  it('maps the number to the incoming packet and both names to the id', () => {
    expect(PACKET_MAP['215']).toBe('PARTY_JOIN_RESULT');
    expect(PACKET_MAP['217']).toBe('PARTY_REQUEST_RESPONSE');
    expect(OUTGOING_AT_SHARED_IDS).toEqual({ '215': 'PARTY_JOIN_REQUEST', '217': 'PARTY_JOIN_REQUEST_RESPONSE' });

    expect(BIDIR_PACKET_MAP['215']).toBe('PARTY_JOIN_RESULT');
    expect(BIDIR_PACKET_MAP['217']).toBe('PARTY_REQUEST_RESPONSE');
    for (const name of ['PARTY_JOIN_REQUEST', 'PARTY_JOIN_RESULT']) expect(BIDIR_PACKET_MAP[name]).toBe('215');
    for (const name of ['PARTY_JOIN_REQUEST_RESPONSE', 'PARTY_REQUEST_RESPONSE']) expect(BIDIR_PACKET_MAP[name]).toBe('217');

    expect(PACKET_DIRECTION.PARTY_JOIN_REQUEST).toBe('Outgoing');
    expect(PACKET_DIRECTION.PARTY_JOIN_RESULT).toBe('Incoming');
    expect(PACKET_DIRECTION.PARTY_JOIN_REQUEST_RESPONSE).toBe('Outgoing');
    expect(PACKET_DIRECTION.PARTY_REQUEST_RESPONSE).toBe('Incoming');
  });

  it('PacketIO sends the outgoing packet at the shared id and names a received frame as the incoming one', () => {
    const written: Buffer[] = [];
    const socket = Object.assign(new EventEmitter(), { write: (b: Buffer) => { written.push(b); return true; } });
    const io = new PacketIO({ socket: socket as any });

    const request = new RawPacket('PARTY_JOIN_REQUEST');
    request.raw = Buffer.from([0, 0, 0, 42]);
    io.send(request);
    expect(written).toHaveLength(1);
    expect(written[0].readInt32BE(0)).toBe(9);
    expect(written[0][4]).toBe(215);

    const types: string[] = [];
    io.on('packet', (p: { type: string }) => types.push(p.type));
    socket.emit('data', Buffer.from([0, 0, 0, 10, 215, 1, 2, 3, 4, 5]));
    expect(types).toEqual(['PARTY_JOIN_RESULT']);
  });
});
