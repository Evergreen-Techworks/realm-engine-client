import type { Proxy } from '../../proxy/Proxy.js';
import type { ClientConnection } from '../../proxy/ClientConnection.js';
import type { Packet } from '../../packets/Packet.js';

export interface CapturedPacket {
  /** Monotonic row id for the sniffer UI. */
  id: number;
  /** RotMG protocol packet type byte (same as Packet.id). */
  packetId: number;
  timestamp: number;
  clientId: string;
  direction: 'C->S' | 'S->C';
  name: string;
  size: number;
  data: Record<string, any> | null;
  /** Full wire image as hex (length prefix + id + body); may be truncated — see rawHexTruncated. */
  rawHex: string;
  rawHexTruncated: boolean;
  isDefined: boolean;
  captureMode: CaptureMode;
}

export type CaptureMode = 'off' | 'summary' | 'full';

/**
 * Captures every packet flowing through the proxy for the dev dashboard.
 * Unknown IDs and parse failures include body hex in `data` for inspection.
 */
export class PacketInspector {
  /** Max raw wire bytes represented in rawHex (limits WS payload size). */
  private static readonly MAX_RAW_HEX_BYTES = 8192;
  /** Max body bytes (after 5-byte header) hex-encoded into `_unknownBodyHex` / parse-failure fields. */
  private static readonly MAX_BODY_DETAIL_BYTES = 65536;

  private readonly buffer: Array<CapturedPacket | undefined>;
  private bufferHead = 0;
  private bufferCount = 0;
  private maxSize: number;
  private listeners: Set<(packet: CapturedPacket) => void> = new Set();
  private packetCount = 0;
  private startTime = Date.now();
  private defaultMode: CaptureMode = 'summary';
  private clientModes = new Map<string, CaptureMode>();

  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
    this.buffer = new Array<CapturedPacket | undefined>(maxSize);
  }

  attach(proxy: Proxy): void {
    proxy.on('clientPacket', (client: ClientConnection, packet: Packet) => {
      this.capture(client, packet, 'C->S');
    });
    proxy.on('serverPacket', (client: ClientConnection, packet: Packet) => {
      this.capture(client, packet, 'S->C');
    });
  }

  setDefaultMode(mode: CaptureMode): void {
    this.defaultMode = mode;
  }

  setClientMode(clientId: string, mode: CaptureMode): void {
    if (!clientId) return;
    this.clientModes.set(clientId, mode);
  }

  clearClientMode(clientId: string): void {
    if (!clientId) return;
    this.clientModes.delete(clientId);
  }

  getClientMode(clientId: string): CaptureMode {
    return this.clientModes.get(clientId) ?? this.defaultMode;
  }

  private capture(client: ClientConnection, packet: Packet, direction: 'C->S' | 'S->C'): void {
    const clientId = String(client.clientId || 'default');
    const mode = this.getClientMode(clientId);
    if (mode === 'off') return;

    const includeDetails = mode === 'full';
    const rawPreview = includeDetails ? this.toPreviewHex(packet.rawBytes) : { hex: '', truncated: false };
    const data = includeDetails ? this.buildCapturedData(packet) : null;

    const captured: CapturedPacket = {
      id: this.packetCount++,
      packetId: packet.id,
      timestamp: Date.now(),
      clientId,
      direction,
      name: packet.name,
      size: packet.rawBytes.length,
      data,
      rawHex: rawPreview.hex,
      rawHexTruncated: rawPreview.truncated,
      isDefined: packet.isDefined,
      captureMode: mode,
    };

    this.pushBuffer(captured);

    for (const listener of this.listeners) {
      try { listener(captured); } catch {}
    }
  }

  subscribe(listener: (packet: CapturedPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRecent(count = 200): CapturedPacket[] {
    const take = Math.max(0, Math.min(count, this.bufferCount));
    const start = (this.bufferHead - take + this.maxSize) % this.maxSize;
    const out: CapturedPacket[] = [];
    for (let i = 0; i < take; i++) {
      const entry = this.buffer[(start + i) % this.maxSize];
      if (entry) out.push(entry);
    }
    return out;
  }

  getRate(): number {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return elapsed > 0 ? Math.round(this.packetCount / elapsed) : 0;
  }

  /** Drop all captured packets (dashboard / admin memory trim). */
  clearBuffer(): void {
    this.buffer.fill(undefined);
    this.bufferHead = 0;
    this.bufferCount = 0;
  }

  private pushBuffer(packet: CapturedPacket): void {
    this.buffer[this.bufferHead] = packet;
    this.bufferHead = (this.bufferHead + 1) % this.maxSize;
    this.bufferCount = Math.min(this.bufferCount + 1, this.maxSize);
  }

  /**
   * Parsed fields plus diagnostic hex for unknown IDs, parse failures, and trailing unread bytes.
   */
  private buildCapturedData(packet: Packet): Record<string, any> {
    const data = this.safeSerialize(packet.data);
    const unknownId = packet.name.startsWith('UNKNOWN_');

    if (unknownId) {
      const body =
        packet.unreadData.length > 0 ? packet.unreadData : packet.rawBytes.subarray(5);
      const bodyHex = this.bodyToHex(body, PacketInspector.MAX_BODY_DETAIL_BYTES);
      data._unknownPacketId = packet.id;
      data._unknownBodyHex = bodyHex.hex;
      if (bodyHex.truncated) data._unknownBodyHexTruncated = true;
      data._unknownNote =
        'No entry for this packet ID in this direction in data/packet-definitions.json — body hex is the payload after the 5-byte header.';
      return data;
    }

    if (!packet.isDefined) {
      data._parseFailureNote =
        'Definition exists but this instance failed to parse — see hex for the unread portion.';
      if (packet.unreadData.length > 0) {
        const bodyHex = this.bodyToHex(packet.unreadData, PacketInspector.MAX_BODY_DETAIL_BYTES);
        data._parseFailureBodyHex = bodyHex.hex;
        if (bodyHex.truncated) data._parseFailureBodyHexTruncated = true;
      }
      return data;
    }

    if (packet.unreadData.length > 0) {
      const tailHex = this.bodyToHex(packet.unreadData, PacketInspector.MAX_BODY_DETAIL_BYTES);
      data._unreadTrailingHex = tailHex.hex;
      if (tailHex.truncated) data._unreadTrailingHexTruncated = true;
    }

    return data;
  }

  private bodyToHex(buf: Buffer, maxBytes: number): { hex: string; truncated: boolean } {
    if (buf.length <= maxBytes) {
      return { hex: buf.toString('hex'), truncated: false };
    }
    return { hex: buf.subarray(0, maxBytes).toString('hex'), truncated: true };
  }

  private safeSerialize(data: Record<string, any>): Record<string, any> {
    try {
      return JSON.parse(JSON.stringify(data, (_, value) => {
        if (Buffer.isBuffer(value)) {
          const preview = value.toString('hex', 0, Math.min(value.length, 20));
          return `<Buffer ${value.length} bytes: ${preview}${value.length > 20 ? '...' : ''}>`;
        }
        return value;
      }));
    } catch {
      return { _error: 'Failed to serialize packet data' };
    }
  }

  private toPreviewHex(rawBytes: Buffer): { hex: string; truncated: boolean } {
    const max = PacketInspector.MAX_RAW_HEX_BYTES;
    if (rawBytes.length <= max) {
      return { hex: rawBytes.toString('hex'), truncated: false };
    }
    return { hex: rawBytes.subarray(0, max).toString('hex'), truncated: true };
  }
}
