import { readFileSync } from 'fs';
import { PacketReader } from './PacketReader.js';
import { PacketWriter } from './PacketWriter.js';
import { createPacket, type Packet } from './Packet.js';
import { Logger } from '../util/Logger.js';

/** Field definition from packet-definitions.json. */
interface FieldDef {
  name: string;
  type: string;
  optional?: boolean;
  default?: any;
  lengthType?: string;  // for arrays
  elementType?: string; // for arrays
}

interface PacketDef {
  name: string;
  direction: 'client' | 'server';
  fields: FieldDef[];
  note?: string;
}

interface DataObjectDef {
  fields: FieldDef[];
}

export interface DefsFile {
  packets: Record<string, PacketDef>;
  dataObjects: Record<string, DataObjectDef>;
}

export interface StatTypesFile {
  stringStats: number[];
  statNames?: Record<string, string>;
}

export type PacketDirection = 'client' | 'server';

const PACKET_KEY = /^(?:(client|server):)?(0|[1-9][0-9]{0,2})$/;

/**
 * Parse a key of `packets` in packet-definitions.json: "<id>" for the only packet
 * at an id, "client:<id>" / "server:<id>" where an id carries a different packet
 * in each direction (215 and 217 on game 86ad651b). `direction` is the key's
 * qualifier, null for a plain key; the result is null for a malformed key.
 * scripts/lib/packet-keys.mjs is the build scripts' copy of this grammar.
 */
export function parsePacketKey(key: string): { id: number; direction: PacketDirection | null } | null {
  const match = typeof key === 'string' ? PACKET_KEY.exec(key) : null;
  if (!match) return null;
  const id = Number(match[2]);
  if (id > 255) return null;
  return { id, direction: (match[1] as PacketDirection | undefined) ?? null };
}

/**
 * Data-driven packet factory.
 * Creates Packet instances from raw bytes using JSON definitions.
 * Unknown packets pass through as raw bytes (never crash).
 *
 * Definitions are keyed by (direction, id): RotMG reuses some ids with a different
 * packet each way, so a frame can only be decoded once its direction is known.
 */
export class PacketFactory {
  private definitions: Record<PacketDirection, Map<number, PacketDef>> = { client: new Map(), server: new Map() };
  private nameToPacket = new Map<string, { id: number; def: PacketDef }>();
  private dataObjects = new Map<string, DataObjectDef>();
  private stringStatIds = new Set<number>();

  constructor(defsSource: string | DefsFile, statTypesSource: string | StatTypesFile) {
    const defs: DefsFile = typeof defsSource === 'string'
      ? JSON.parse(readFileSync(defsSource, 'utf8'))
      : defsSource;
    const statTypes: StatTypesFile = typeof statTypesSource === 'string'
      ? JSON.parse(readFileSync(statTypesSource, 'utf8'))
      : statTypesSource;

    // Load packet definitions. Anything that would make a lookup ambiguous is a
    // broken definitions file (scripts/check-packet-drift.mjs guards the shipped one).
    for (const [key, def] of Object.entries(defs.packets)) {
      const parsed = parsePacketKey(key);
      if (!parsed) throw new Error(`packet definitions: malformed packet key "${key}"`);
      if (def.direction !== 'client' && def.direction !== 'server') {
        throw new Error(`packet definitions: "${key}" (${def.name}) has direction ${JSON.stringify(def.direction)}`);
      }
      if (parsed.direction && parsed.direction !== def.direction) {
        throw new Error(`packet definitions: key "${key}" says ${parsed.direction}, but ${def.name} is ${def.direction}`);
      }
      const byId = this.definitions[def.direction];
      const existing = byId.get(parsed.id);
      if (existing) {
        throw new Error(`packet definitions: two ${def.direction} packets at id ${parsed.id} (${existing.name}, ${def.name})`);
      }
      if (this.nameToPacket.has(def.name)) {
        throw new Error(`packet definitions: packet name ${def.name} is used twice`);
      }
      byId.set(parsed.id, def);
      this.nameToPacket.set(def.name, { id: parsed.id, def });
    }

    // Load data object schemas
    for (const [name, def] of Object.entries(defs.dataObjects)) {
      this.dataObjects.set(name, def);
    }

    // Load string stat IDs
    for (const id of statTypes.stringStats) {
      this.stringStatIds.add(id);
    }

    Logger.log('PacketFactory', `Loaded ${this.nameToPacket.size} packet definitions, ${this.dataObjects.size} data objects`);
  }

  /**
   * Create a Packet from raw decrypted bytes (full packet including header).
   * `direction` is the way the frame travelled: 'client' for client->server,
   * 'server' for server->client.
   */
  createFromBytes(rawBytes: Buffer, direction: PacketDirection): Packet {
    if (direction !== 'client' && direction !== 'server') {
      throw new TypeError(`createFromBytes needs the frame's direction ('client' or 'server'), got ${JSON.stringify(direction)}`);
    }
    const id = rawBytes[4]; // byte 5 is the packet ID
    const def = this.definitions[direction].get(id);

    if (!def) {
      // Unknown packet — pass through as raw bytes
      const pkt = createPacket(id, `UNKNOWN_${id}`, 'unknown');
      pkt.rawBytes = rawBytes;
      pkt.bodyLength = rawBytes.length - 5;
      pkt.unreadData = rawBytes.subarray(5);
      return pkt;
    }

    const pkt = createPacket(id, def.name, def.direction);
    pkt.rawBytes = rawBytes;
    pkt.bodyLength = rawBytes.length - 5;
    pkt.isDefined = true;

    try {
      const reader = new PacketReader(rawBytes, 5); // start after header
      pkt.data = this.readFields(reader, def.fields);

      // Capture any unread trailing bytes
      if (reader.remaining > 0) {
        pkt.unreadData = reader.readRemainingBytes();
      }
    } catch (err) {
      // If parsing fails, fall back to raw bytes passthrough
      Logger.warn('PacketFactory', `Failed to parse ${def.name} (id=${id}): ${(err as Error).message}`);
      pkt.isDefined = false;
      pkt.data = {};
      pkt.unreadData = rawBytes.subarray(5);
    }

    return pkt;
  }

  /** Create an empty Packet by name (for sending). */
  createByName(name: string): Packet {
    const entry = this.nameToPacket.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown packet name: ${name}`);
    }
    const pkt = createPacket(entry.id, name, entry.def.direction);
    pkt.isDefined = true;
    return pkt;
  }

  /** Serialize a Packet back to raw bytes (with header), with the layout of its own direction. */
  serialize(packet: Packet): Buffer {
    if (!packet.isDefined) {
      // Unknown packet — return raw bytes as-is
      return packet.rawBytes;
    }

    const def = packet.direction === 'client' || packet.direction === 'server'
      ? this.definitions[packet.direction].get(packet.id)
      : undefined;
    if (!def) {
      return packet.rawBytes;
    }

    const writer = new PacketWriter();
    // Reserve space for length (4 bytes) + packet ID (1 byte)
    writer.writeInt32(0);   // placeholder for length
    writer.writeByte(packet.id);

    try {
      this.writeFields(writer, def.fields, packet.data);

      // Append any unread data that was captured
      if (packet.unreadData.length > 0) {
        writer.writeBytes(packet.unreadData);
      }
    } catch (err) {
      Logger.warn('PacketFactory', `Failed to serialize ${packet.name}: ${(err as Error).message}`);
      return packet.rawBytes;
    }

    const buf = writer.toBuffer();
    // Stamp the total length at offset 0
    PacketWriter.writeInt32At(buf, buf.length, 0);
    return buf;
  }

  /** Get the name of the packet at an ID travelling in `direction`. */
  getPacketName(id: number, direction: PacketDirection): string {
    return this.definitions[direction]?.get(id)?.name ?? `UNKNOWN_${id}`;
  }

  /** Get packet ID for a name. */
  getPacketId(name: string): number | undefined {
    return this.nameToPacket.get(name)?.id;
  }

  // ─── Field Reading ──────────────────────────────────────────────

  private readFields(reader: PacketReader, fields: FieldDef[]): Record<string, any> {
    const data: Record<string, any> = {};
    // Track current StatData id for statValue resolution
    let currentStatId = 0;

    for (const field of fields) {
      // Handle optional fields
      if (field.optional && reader.remaining <= 0) {
        data[field.name] = field.default;
        continue;
      }

      const value = this.readField(reader, field, () => currentStatId);
      data[field.name] = value;

      // Track stat ID for the next statValue field
      if (field.name === 'id' && typeof value === 'number') {
        currentStatId = value;
      }
    }
    return data;
  }

  private readField(reader: PacketReader, field: FieldDef, getStatId: () => number): any {
    switch (field.type) {
      case 'byte':           return reader.readByte();
      case 'sbyte':          return reader.readSByte();
      case 'bool':           return reader.readBool();
      case 'int16':          return reader.readInt16();
      case 'uint16':         return reader.readUInt16();
      case 'int32':          return reader.readInt32();
      case 'uint32':         return reader.readUInt32();
      case 'float':          return reader.readFloat();
      case 'string':         return reader.readString();
      case 'utf32string':    return reader.readUtf32String();
      case 'compressedInt':  return reader.readCompressedInt();

      case 'byteArray16': {
        const len = reader.readInt16();
        return reader.readBytes(len);
      }

      case 'byteArray32': {
        const len = reader.readInt32();
        return reader.readBytes(len);
      }

      case 'statValue': {
        // Read string or compressedInt based on stat ID
        const statId = getStatId();
        if (this.stringStatIds.has(statId)) {
          return reader.readString();
        }
        return reader.readCompressedInt();
      }

      case 'array': {
        return this.readArray(reader, field, getStatId);
      }

      default: {
        // Check if it's a data object reference
        const objDef = this.dataObjects.get(field.type);
        if (objDef) {
          return this.readDataObject(reader, objDef);
        }
        throw new Error(`Unknown field type: ${field.type}`);
      }
    }
  }

  private readArray(reader: PacketReader, field: FieldDef, getStatId: () => number): any[] {
    // Read the length based on lengthType
    let length: number;
    switch (field.lengthType) {
      case 'int16':         length = reader.readInt16(); break;
      case 'uint16':        length = reader.readUInt16(); break;
      case 'int32':         length = reader.readInt32(); break;
      case 'compressedInt': length = reader.readCompressedInt(); break;
      case 'byte':          length = reader.readByte(); break;
      default:              length = reader.readInt16(); break;
    }

    const arr: any[] = [];
    const elementField: FieldDef = { name: '_element', type: field.elementType! };
    for (let i = 0; i < length; i++) {
      arr.push(this.readField(reader, elementField, getStatId));
    }
    return arr;
  }

  private readDataObject(reader: PacketReader, def: DataObjectDef): Record<string, any> {
    return this.readFields(reader, def.fields);
  }

  // ─── Field Writing ──────────────────────────────────────────────

  private writeFields(writer: PacketWriter, fields: FieldDef[], data: Record<string, any>): void {
    let currentStatId = 0;

    // The wire has no presence flags: the reader treats an optional field as
    // absent only when the bytes run out. So an optional field may be omitted
    // only if nothing after it is written. One that precedes a written field
    // must be written, with its default when it has no value, or every later
    // field shifts.
    let lastWritten = -1;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const value = data[field.name];
      if (!field.optional || (value !== undefined && value !== field.default)) lastWritten = i;
    }

    for (let i = 0; i <= lastWritten; i++) {
      const field = fields[i];
      const given = data[field.name];
      const value = field.optional && given === undefined ? field.default : given;

      this.writeField(writer, field, value, () => currentStatId);

      if (field.name === 'id' && typeof value === 'number') {
        currentStatId = value;
      }
    }
  }

  private writeField(writer: PacketWriter, field: FieldDef, value: any, getStatId: () => number): void {
    switch (field.type) {
      case 'byte':           writer.writeByte(value); break;
      case 'sbyte':          writer.writeSByte(value); break;
      case 'bool':           writer.writeBool(value); break;
      case 'int16':          writer.writeInt16(value); break;
      case 'uint16':         writer.writeUInt16(value); break;
      case 'int32':          writer.writeInt32(value); break;
      case 'uint32':         writer.writeUInt32(value); break;
      case 'float':          writer.writeFloat(value); break;
      case 'string':         writer.writeString(value ?? ''); break;
      case 'utf32string':    writer.writeUtf32String(value ?? ''); break;
      case 'compressedInt':  writer.writeCompressedInt(value ?? 0); break;

      case 'byteArray16': {
        const buf = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
        writer.writeInt16(buf.length);
        writer.writeBytes(buf);
        break;
      }

      case 'byteArray32': {
        const buf = Buffer.isBuffer(value) ? value : Buffer.alloc(0);
        writer.writeInt32(buf.length);
        writer.writeBytes(buf);
        break;
      }

      case 'statValue': {
        const statId = getStatId();
        if (this.stringStatIds.has(statId)) {
          writer.writeString(value ?? '');
        } else {
          writer.writeCompressedInt(value ?? 0);
        }
        break;
      }

      case 'array': {
        this.writeArray(writer, field, value ?? [], getStatId);
        break;
      }

      default: {
        const objDef = this.dataObjects.get(field.type);
        if (objDef) {
          this.writeDataObject(writer, objDef, value ?? {});
        } else {
          throw new Error(`Unknown field type: ${field.type}`);
        }
      }
    }
  }

  private writeArray(writer: PacketWriter, field: FieldDef, arr: any[], getStatId: () => number): void {
    switch (field.lengthType) {
      case 'int16':         writer.writeInt16(arr.length); break;
      case 'uint16':        writer.writeUInt16(arr.length); break;
      case 'int32':         writer.writeInt32(arr.length); break;
      case 'compressedInt': writer.writeCompressedInt(arr.length); break;
      case 'byte':          writer.writeByte(arr.length); break;
      default:              writer.writeInt16(arr.length); break;
    }

    const elementField: FieldDef = { name: '_element', type: field.elementType! };
    for (const item of arr) {
      this.writeField(writer, elementField, item, getStatId);
    }
  }

  private writeDataObject(writer: PacketWriter, def: DataObjectDef, data: Record<string, any>): void {
    this.writeFields(writer, def.fields, data);
  }
}
