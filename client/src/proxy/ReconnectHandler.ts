import type { Proxy } from './Proxy.js';
import type { ClientConnection } from './ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import { Logger } from '../util/Logger.js';
import { DebugManager } from '../util/DebugManager.js';
import { GAME_PORT } from '../constants/GameId.js';
import { signalHelloEvent } from '../native/hello-event.js';
import { sendDllFeature } from '../bridge/DllFeatureBus.js';

/**
 * Scan raw decrypted HELLO bytes to find the byte offset of the `key` field.
 * HELLO layout: [4-byte header][1-byte id][int32 gameId][string buildVersion]
 *               [string accessToken][int32 keyTime][byteArray16 key]...
 * Strings = int16 length prefix + N bytes. byteArray16 = int16 length prefix + N bytes.
 * Returns the offset of the key's int16 length prefix, or -1 on failure.
 */
function findHelloKeyOffset(raw: Buffer): number {
  try {
    let off = 5; // skip 4-byte length + 1-byte packet id
    off += 4;    // gameId (int32)
    // buildVersion (string: int16 len + chars)
    const bvLen = raw.readInt16BE(off); off += 2 + bvLen;
    // accessToken (string: int16 len + chars)
    const atLen = raw.readInt16BE(off); off += 2 + atLen;
    off += 4;    // keyTime (int32)
    // `off` now points at the key field's int16 length prefix
    return off;
  } catch {
    return -1;
  }
}

/**
 * Patch the `key` byteArray16 field in a raw HELLO buffer at the given offset.
 * Returns a new buffer with the key replaced; all bytes before and after are preserved.
 */
function patchHelloKey(template: Buffer, keyOffset: number, newKey: Buffer): Buffer {
  const oldKeyLen = template.readInt16BE(keyOffset);
  const beforeKey = template.subarray(0, keyOffset);
  const afterKey  = template.subarray(keyOffset + 2 + oldKeyLen);

  const patched = Buffer.alloc(beforeKey.length + 2 + newKey.length + afterKey.length);
  let pos = 0;
  beforeKey.copy(patched, pos);  pos += beforeKey.length;
  patched.writeInt16BE(newKey.length, pos); pos += 2;
  newKey.copy(patched, pos);     pos += newKey.length;
  afterKey.copy(patched, pos);

  // Fix the 4-byte packet length header
  patched.writeInt32BE(patched.length, 0);
  return patched;
}

/**
 * Handles the critical reconnect interception flow.
 * When the game sends RECONNECT (changing realms/dungeons), this handler:
 * 1. Stores the real server address + key in State
 * 2. Rewrites the packet to point back to 127.0.0.1:2050
 * 3. On next HELLO, restores the real key and connects to the real server
 *
 * Ported from KRelayBetter's ReconnectHandler.cs.
 */
export class ReconnectHandler {
  private proxy!: Proxy;

  attach(proxy: Proxy): void {
    this.proxy = proxy;
    proxy.hookPacket('HELLO', (client, packet) => this.onHello(client, packet));
    proxy.hookPacket('RECONNECT', (client, packet) => this.onReconnect(client, packet));
  }

  private onHello(client: ClientConnection, packet: Packet): void {
    // Unblock the injected DLL's Load() — the DLL waits on this event before
    // calling Run() so the overlay/menu/hooks only come online after the
    // client has actually reached the in-game HELLO handshake.
    signalHelloEvent();
    sendDllFeature('playerColliderSceneReset', 1);

    // Look up or create state for this connection
    const key = packet.data.key as Buffer;
    const keyHex = Buffer.isBuffer(key) ? key.toString('hex') : 'not-a-buffer';
    const keyUtf = Buffer.isBuffer(key) ? key.toString('utf8') : '';
    Logger.debug('reconnect', 'Reconnect', `[HELLO] Received — key (${Buffer.isBuffer(key) ? key.length : 0} bytes): ${keyHex}`);
    Logger.debug('reconnect', 'Reconnect', `[HELLO] Key as UTF-8: "${keyUtf}"`);

    client.state = this.proxy.getState(client, key);

    // Capture the raw HELLO as a template for future reconnects.
    // This avoids re-serialization from potentially stale packet definitions.
    if (packet.rawBytes.length > 0) {
      client.state.helloTemplate = Buffer.from(packet.rawBytes);
      client.state.helloKeyOffset = findHelloKeyOffset(client.state.helloTemplate);
      Logger.debug('reconnect', 'Reconnect', `[HELLO] Captured template (${client.state.helloTemplate.length} bytes, keyOffset=${client.state.helloKeyOffset})`);
    }

    // Capture current gameId (used as a coarse "current map" identifier)
    const helloGameId = packet.data.gameId as number | undefined;
    if (typeof helloGameId === 'number' && Number.isFinite(helloGameId)) {
      client.state.gameId = helloGameId;
    }

    // Capture access token for API calls (e.g., fetching server list)
    const accessToken = packet.data.accessToken as string;
    if (accessToken) {
      client.state.accessToken = accessToken;
    }

    Logger.debug('reconnect', 'Reconnect', `[HELLO] State lookup — conTargetAddress: ${client.state.conTargetAddress}, conTargetPort: ${client.state.conTargetPort}`);
    Logger.debug('reconnect', 'Reconnect', `[HELLO] State lookup — conRealKey (${client.state.conRealKey.length} bytes): ${client.state.conRealKey.toString('hex').slice(0, 80)}`);

    // For the first connection (no prior RECONNECT), use the IP from the DLL hook
    // But ignore 127.0.0.1 — that's our own proxy address from rewritten RECONNECTs
    if (client.originalTargetIp && client.originalTargetIp !== '127.0.0.1' &&
        client.state.conTargetAddress === '54.241.208.233') {
      Logger.debug('reconnect', 'Reconnect', `[HELLO] Overriding default server with DLL target: ${client.originalTargetIp}`);
      client.state.conTargetAddress = client.originalTargetIp;
    }

    // Restore the key from the previous RECONNECT (or clear it for fresh connections).
    // pendingKeyRestore is set when a previous state was found by guid — meaning this
    // HELLO was triggered by a RECONNECT (server-initiated or plugin-initiated).
    if (client.state.pendingKeyRestore) {
      const realKey = client.state.conRealKey;
      Logger.debug('reconnect', 'Reconnect', `[HELLO] Restoring key (${realKey.length} bytes): ${realKey.toString('hex').slice(0, 80) || '(empty — fresh connection)'}`);

      // Patch the key directly in the raw HELLO template instead of re-serializing.
      if (client.state.helloTemplate && client.state.helloKeyOffset >= 0) {
        packet.rawBytes = patchHelloKey(client.state.helloTemplate, client.state.helloKeyOffset, realKey);
        // Do NOT set packet.modified — we want connectToServer to use rawBytes directly
        Logger.debug('reconnect', 'Reconnect', `[HELLO] Patched raw template (${packet.rawBytes.length} bytes)`);
      } else {
        // Fallback: re-serialize (only if template capture failed)
        Logger.warn('Reconnect', '[HELLO] No raw template available, falling back to re-serialization');
        packet.data.key = realKey;
        packet.modified = true;
      }

      client.state.conRealKey = Buffer.alloc(0);
      client.state.pendingKeyRestore = false;
    } else {
      Logger.debug('reconnect', 'Reconnect', `[HELLO] First connection — keeping original key`);
    }

    // ── DIAGNOSTIC: compare original bytes vs re-serialized ────────────────
    // If these differ, re-serialization is corrupting the HELLO. Gated behind the
    // 'reconnect' debug channel — the re-serialize is pure diagnostic work, so we
    // skip it entirely (not just the logging) when the channel is off.
    if (DebugManager.enabled('reconnect') && packet.rawBytes.length > 0) {
      const reserialized = this.proxy.packetFactory.serialize(packet);
      const orig = packet.rawBytes;
      if (orig.length !== reserialized.length) {
        Logger.debug('reconnect', 'Reconnect', `[HELLO DIAG] SIZE MISMATCH: original=${orig.length} serialized=${reserialized.length}`);
      } else {
        let firstDiff = -1;
        for (let i = 0; i < orig.length; i++) {
          if (orig[i] !== reserialized[i]) { firstDiff = i; break; }
        }
        if (firstDiff >= 0) {
          Logger.debug('reconnect', 'Reconnect', `[HELLO DIAG] BYTE MISMATCH at offset ${firstDiff}: orig=0x${orig[firstDiff].toString(16)} ser=0x${reserialized[firstDiff].toString(16)}`);
          Logger.debug('reconnect', 'Reconnect', `[HELLO DIAG] orig[${firstDiff}-${Math.min(firstDiff+20, orig.length)}]: ${orig.subarray(firstDiff, firstDiff+20).toString('hex')}`);
          Logger.debug('reconnect', 'Reconnect', `[HELLO DIAG]  ser[${firstDiff}-${Math.min(firstDiff+20, reserialized.length)}]: ${reserialized.subarray(firstDiff, firstDiff+20).toString('hex')}`);
        } else {
          Logger.debug('reconnect', 'Reconnect', `[HELLO DIAG] Bytes match perfectly (${orig.length} bytes)`);
        }
      }
    }
    // ── END DIAGNOSTIC ──────────────────────────────────────────────────────

    Logger.log('Reconnect', `[HELLO] Connecting to server ${client.state.conTargetAddress}:${client.state.conTargetPort}`);

    // Connect to the real server and send the HELLO
    client.connectToServer(packet);

    // Don't forward the original — connectToServer sends it after TCP connect
    packet.send = false;
  }

  private onReconnect(client: ClientConnection, packet: Packet): void {
    // Log all parsed fields for debugging
    const host = packet.data.host as string;
    const port = packet.data.port as number;
    const gameId = packet.data.gameId;
    const keyTime = packet.data.keyTime;
    const key = packet.data.key as Buffer;
    const name = packet.data.name;

    Logger.log('Reconnect', `[RECONNECT] Received — name: "${name}", host: "${host}", port: ${port}, gameId: ${gameId}, keyTime: ${keyTime}`);
    Logger.debug('reconnect', 'Reconnect', `[RECONNECT] Key (${Buffer.isBuffer(key) ? key.length : 0} bytes): ${Buffer.isBuffer(key) ? key.toString('hex').slice(0, 80) : 'not-a-buffer'}`);
    Logger.debug('reconnect', 'Reconnect', `[RECONNECT] Raw packet size: ${packet.rawBytes.length}, isDefined: ${packet.isDefined}`);
    if (packet.unreadData.length > 0) {
      Logger.log('Reconnect', `[RECONNECT] WARNING: ${packet.unreadData.length} unread trailing bytes`);
    }

    // Track current gameId (map identifier) across reconnects
    if (typeof gameId === 'number' && Number.isFinite(gameId)) {
      client.state.gameId = gameId;
    }

    // Store the real server target from raw bytes (works even if definitions are stale)
    if (host && host !== '') {
      client.state.conTargetAddress = host;
    }
    if (port !== undefined && port !== 0) {
      client.state.conTargetPort = port;
    }

    if (key && Buffer.isBuffer(key) && key.length > 0) {
      client.state.conRealKey = Buffer.from(key);
    }

    Logger.debug('reconnect', 'Reconnect', `[RECONNECT] Stored — address: ${client.state.conTargetAddress}, port: ${client.state.conTargetPort}, keyLen: ${client.state.conRealKey.length}`);

    // Rewrite the packet to redirect client back to our proxy.
    // Patch raw bytes directly instead of re-serializing from definitions.
    // RECONNECT layout: [4-byte len][1-byte id][string name][string host][uint16 port]
    //                   [int32 gameId][int32 keyTime][byteArray16 key]...
    const raw = packet.rawBytes;
    const guidBuf = Buffer.from(client.state.guid, 'utf8');
    const newHost = '127.0.0.1';
    const newPort = GAME_PORT;

    try {
      let off = 5; // skip header
      // name (string)
      const nameLen = raw.readInt16BE(off); off += 2 + nameLen;
      // host (string) — we need to replace this
      const hostOff = off;
      const oldHostLen = raw.readInt16BE(off); off += 2 + oldHostLen;
      // port (uint16) — we need to replace this
      const portOff = off; off += 2;
      // gameId (int32)
      off += 4;
      // keyTime (int32)
      off += 4;
      // key (byteArray16) — we need to replace this
      const keyOff = off;
      const oldKeyLen = raw.readInt16BE(off); off += 2 + oldKeyLen;
      // Everything after key
      const tail = raw.subarray(off);

      // Build patched packet: [before host][new host][new port][gameId+keyTime unchanged][new key][tail]
      const beforeHost = raw.subarray(0, hostOff);
      const newHostBuf = Buffer.from(newHost, 'utf8');
      // Between host and port there's nothing (port follows host immediately)
      // Between port and key: gameId(4) + keyTime(4) = raw bytes from portOff+2 to keyOff
      const portToKey = raw.subarray(portOff + 2, keyOff);

      const patchedLen = beforeHost.length + 2 + newHostBuf.length + 2 + portToKey.length + 2 + guidBuf.length + tail.length;
      const patched = Buffer.alloc(patchedLen);
      let p = 0;
      beforeHost.copy(patched, p); p += beforeHost.length;
      patched.writeInt16BE(newHostBuf.length, p); p += 2;
      newHostBuf.copy(patched, p); p += newHostBuf.length;
      patched.writeUInt16BE(newPort, p); p += 2;
      portToKey.copy(patched, p); p += portToKey.length;
      patched.writeInt16BE(guidBuf.length, p); p += 2;
      guidBuf.copy(patched, p); p += guidBuf.length;
      tail.copy(patched, p);

      // Fix packet length header
      patched.writeInt32BE(patched.length, 0);

      packet.rawBytes = patched;
      // Don't set modified — forwardRaw will use rawBytes
      Logger.debug('reconnect', 'Reconnect', `[RECONNECT] Raw-patched (${patched.length} bytes) — host: ${newHost}, port: ${newPort}, guid: "${client.state.guid}"`);
    } catch (err) {
      // Fallback to re-serialization if raw patching fails
      Logger.warn('Reconnect', `[RECONNECT] Raw patch failed (${(err as Error).message}), falling back to re-serialization`);
      packet.data.key = guidBuf;
      packet.data.host = newHost;
      packet.data.port = newPort;
      packet.modified = true;
    }
    // packet.send = true — let it forward to the client so it reconnects to us
  }
}
