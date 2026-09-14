// Keys of `packets` in client/data/packet-definitions.json.
//
// RotMG reuses some ids with a different packet in each direction (215 and 217 on
// game 86ad651b), so a packet is identified by (direction, id), not by id alone:
//
//   "12"          the only packet at id 12; its `direction` field says which way
//   "client:215"  the client->server packet at id 215
//   "server:215"  the server->client packet at id 215
//
// An id with one packet uses the plain key. An id with a packet in each direction
// uses the two qualified keys and never the plain one. Qualified keys follow every
// plain key, in (id, client-before-server) order: JSON.parse always enumerates
// integer-like keys first, so any other placement would not survive the
// JSON.parse -> JSON.stringify round trip the ID sync rewrites this file with.
//
// src/packets/PacketFactory.ts parses the same grammar in TypeScript (the build
// scripts run under plain node and cannot import it). The vitest suite
// src/packets/__tests__/directionKeys.test.ts proves the two parse identically.

export const DIRECTIONS = ['client', 'server'];

const KEY = /^(?:(client|server):)?(0|[1-9][0-9]{0,2})$/;

/**
 * @param {string} key
 * @returns {{ id: number, direction: 'client' | 'server' | null } | null}
 *   `direction` is the key's qualifier (null for a plain key); null for a malformed key.
 */
export function parsePacketKey(key) {
  const match = typeof key === 'string' ? KEY.exec(key) : null;
  if (!match) return null;
  const id = Number(match[2]);
  if (id > 255) return null;
  return { id, direction: match[1] ?? null };
}

/** The canonical key for a packet at `id` travelling `direction`, given whether the id is shared. */
export function packetKey(id, direction, shared) {
  return shared ? `${direction}:${id}` : String(id);
}

/**
 * Every packet with its parsed identity, in file order.
 * @returns {{ key: string, id: number, direction: string, packet: object }[]}
 * @throws on a malformed key; run packetKeyProblems() first for a full report.
 */
export function packetEntries(packets) {
  return Object.entries(packets ?? {}).map(([key, packet]) => {
    const parsed = parsePacketKey(key);
    if (!parsed) throw new Error(`malformed packet key "${key}"`);
    return { key, id: parsed.id, direction: packet?.direction, packet };
  });
}

/**
 * Build a canonical `packets` object from (id, packet) pairs, choosing plain or
 * qualified keys and their order. For tools that move ids (the packet-ID sync).
 * @param {{ id: number, packet: { direction: string } }[]} list
 * @throws when two packets share a (direction, id) or a direction is unknown
 */
export function keyPackets(list) {
  const byId = new Map();
  for (const { id, packet } of list) {
    if (!DIRECTIONS.includes(packet?.direction)) throw new Error(`packet ${packet?.name} at id ${id}: unknown direction ${packet?.direction}`);
    const slot = byId.get(id) ?? {};
    if (slot[packet.direction]) {
      throw new Error(`two ${packet.direction} packets at id ${id}: ${slot[packet.direction].name} and ${packet.name}`);
    }
    slot[packet.direction] = packet;
    byId.set(id, slot);
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  const out = {};
  for (const id of ids) {
    const slot = byId.get(id);
    if (!(slot.client && slot.server)) out[String(id)] = slot.client ?? slot.server;
  }
  for (const id of ids) {
    const slot = byId.get(id);
    if (slot.client && slot.server) {
      out[packetKey(id, 'client', true)] = slot.client;
      out[packetKey(id, 'server', true)] = slot.server;
    }
  }
  return out;
}

/**
 * Everything non-canonical about the keys of a `packets` object; empty when canonical.
 * @returns {string[]}
 */
export function packetKeyProblems(packets) {
  const problems = [];
  const slots = new Map(); // id -> { plain: key[], client: key[], server: key[] }
  const qualifiedOrder = [];
  // Where qualified keys sit relative to plain ones is not visible here: every
  // parsed object enumerates integer-like keys first. check-packet-drift.mjs checks
  // the file's own byte layout for that.
  for (const [key, packet] of Object.entries(packets ?? {})) {
    const parsed = parsePacketKey(key);
    if (!parsed) {
      problems.push(`malformed packet key "${key}" (want "<id 0-255>" or "client:<id>" / "server:<id>")`);
      continue;
    }
    const direction = packet?.direction;
    if (!DIRECTIONS.includes(direction)) {
      problems.push(`"${key}" (${packet?.name}): direction must be client or server, not ${JSON.stringify(direction)}`);
      continue;
    }
    if (parsed.direction && parsed.direction !== direction) {
      problems.push(`"${key}" (${packet?.name}): the key says ${parsed.direction} but its direction is ${direction}`);
    }
    const slot = slots.get(parsed.id) ?? { keys: [], plain: [], client: [], server: [] };
    slot.keys.push(key);
    if (!parsed.direction) slot.plain.push(key);
    slot[direction].push(key); // a plain key occupies its packet's direction too
    slots.set(parsed.id, slot);

    if (parsed.direction) {
      qualifiedOrder.push({ key, rank: parsed.id * 2 + (parsed.direction === 'server' ? 1 : 0) });
    }
  }
  for (const [id, slot] of [...slots].sort((a, b) => a[0] - b[0])) {
    for (const direction of DIRECTIONS) {
      if (slot[direction].length > 1) problems.push(`id ${id}: more than one ${direction} packet (${slot[direction].join(', ')})`);
    }
    const shared = slot.client.length > 0 && slot.server.length > 0;
    if (shared && slot.plain.length > 0) {
      problems.push(`id ${id} carries a packet in each direction, so it needs "client:${id}" and "server:${id}", not "${slot.plain.join('", "')}"`);
    }
    if (slot.keys.length === 1 && slot.plain.length === 0) {
      problems.push(`id ${id} has one packet, so its key is "${id}", not "${slot.keys[0]}"`);
    }
  }
  for (let i = 1; i < qualifiedOrder.length; i++) {
    if (qualifiedOrder[i].rank <= qualifiedOrder[i - 1].rank) {
      problems.push(`"${qualifiedOrder[i].key}" is out of order: qualified keys go by id, client before server`);
    }
  }
  return problems;
}
