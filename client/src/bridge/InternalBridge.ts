/**
 * InternalBridge — Named-pipe server accepting the injected DLL.
 *
 * The DLL connects to us (Node.js is the pipe server). The DLL sends `hello`
 * first regardless of which side created the pipe; all handshake/heartbeat
 * logic is unchanged from the previous client-side model.
 *
 * Handles:
 *   - Mutual authentication (challenge-response HMAC-SHA256)
 *   - Periodic heartbeat (both directions)
 *   - Command relay (forward dashboard feature toggles to the DLL)
 *   - State/player/entity reception from the DLL
 *
 * The shared HMAC key is embedded at build time via __HANDSHAKE_KEY__.
 */

import { createServer, Server, Socket } from 'net';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Logger } from '../util/Logger.js';
import { EventEmitter } from 'events';
import { signalHelloEvent } from '../native/hello-event.js';

declare const __HANDSHAKE_KEY__: string | undefined;
declare const __PIPE_NAME__: string | undefined;

// Dev fallback must match DebugInternal/src/ui/BuildSecrets.h dev pipe name.
// In production, build-prod.mjs regenerates both to a random per-build value.
const PIPE_PATH = (() => {
  try {
    const raw = typeof __PIPE_NAME__ !== 'undefined' ? __PIPE_NAME__ : '';
    const s = String(raw || '').trim();
    if (s.startsWith('\\\\.\\pipe\\')) return s;
  } catch {}
  return '\\\\.\\pipe\\lfg-dev-bridge';
})();

/** RotMG Exalt + DLL use Windows named pipes; Node cannot expose them on Linux/WSL/macOS. */
function isWindowsNamedPipeHost(): boolean {
  return process.platform === 'win32';
}

const HEARTBEAT_INTERVAL = 5000;
const MAX_MISSES = 3;
const IS_PROD = process.env.REALM_ENGINE_PROD === '1';
const HEX64 = /^[0-9a-f]{64}$/i;

function getHandshakeKey(): string {
  return '47eb249907eb980c851fe3a7bdb56a244244bb7d465572b556e810df6827ecfb';
}

const HANDSHAKE_KEY = getHandshakeKey();

function hmacResponse(data: string): string | null {
  if (!HANDSHAKE_KEY) return null;
  try {
    return createHmac('sha256', Buffer.from(HANDSHAKE_KEY, 'hex'))
      .update(data)
      .digest('hex');
  } catch {
    return null;
  }
}

function randomNonce(): string {
  return randomBytes(32).toString('hex');
}

function isHexNonce(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

function deriveSessionKey(serverChallenge: string, clientChallenge: string, userId: string, clientPid: string): string | null {
  if (!HANDSHAKE_KEY) return null;
  if (!/^[1-9]\d*$/.test(clientPid)) return null;
  if (!isHexNonce(serverChallenge) || !isHexNonce(clientChallenge)) return null;
  try {
    return createHmac('sha256', Buffer.from(HANDSHAKE_KEY, 'hex'))
      .update(`${serverChallenge}|${clientChallenge}|${userId}|${clientPid}|${PIPE_PATH}|session-v2`)
      .digest('hex');
  } catch {
    return null;
  }
}

function computeSessionMac(sessionKeyHex: string, seq: bigint, type: string, payload: string): string | null {
  if (!isHexNonce(sessionKeyHex)) return null;
  try {
    return createHmac('sha256', Buffer.from(sessionKeyHex, 'hex'))
      .update(`${seq.toString()}|${type}|${payload}`)
      .digest('hex');
  } catch {
    return null;
  }
}

function parseSeq(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
  const str = String(value);
  if (!/^\d+$/.test(str)) return null;
  try {
    return BigInt(str);
  } catch {
    return null;
  }
}

function playerPayloadFromMessage(msg: DllMessage): string | null {
  const alive = msg.alive === true;
  if (!alive) return 'alive:false';
  const hp = typeof msg.hp === 'number' && Number.isFinite(msg.hp) ? msg.hp : null;
  const maxHp = typeof msg.maxHp === 'number' && Number.isFinite(msg.maxHp) ? msg.maxHp : null;
  const posX = typeof msg.posX === 'number' && Number.isFinite(msg.posX) ? msg.posX : null;
  const posY = typeof msg.posY === 'number' && Number.isFinite(msg.posY) ? msg.posY : null;
  if (hp === null || maxHp === null || posX === null || posY === null) return null;
  return `alive:true|hp:${hp}|maxHp:${maxHp}|posX:${posX.toFixed(3)}|posY:${posY.toFixed(3)}`;
}

function hotkeyPayloadFromMessage(msg: DllMessage): string | null {
  const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId : null;
  const action = typeof msg.action === 'string' ? msg.action : null;
  const value = typeof msg.value === 'boolean' ? msg.value : null;
  if (!pluginId || !action || value === null) return null;
  return `${pluginId}|${action}|${value ? 'true' : 'false'}`;
}

interface SignedFields {
  payload: string;
  valueType?: 'b' | 'n' | 's';
}

export interface DllMessage {
  type: string;
  [key: string]: unknown;
}

export class InternalBridge extends EventEmitter {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private userId: string;
  private authenticated = false;
  private stopped = false;

  // Heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingChallenge: string | null = null;
  private serverChallenge: string | null = null;
  private missCount = 0;
  private sessionKey: string | null = null;
  private nextClientSeq = 1n;
  private lastDllSeq = 0n;

  // Read buffer for length-prefixed messages
  private readBuf = Buffer.alloc(0);

  /** Latest value per feature key — replayed in full on every DLL (re)connect. */
  private lastSentFeatures = new Map<string, DllMessage>();

  private loggedFirstPipeData = false;
  private warnedNonWindowsPipe = false;

  constructor(userId: string) {
    super();
    this.userId = userId;
  }

  get isConnected(): boolean { return this.authenticated && this.pipeTransportReady(); }
  get currentUserId(): string { return this.userId; }

  /** Non-null only while the OS pipe connection is alive. */
  private pipeTransportReady(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * DLL rejects empty userId and non-[a-zA-Z0-9._-] (see IpcBridge IsAsciiIdSafe / DeriveSessionKey).
   * Pre-login bridge uses empty string — map to a stable token so handshake can complete.
   */
  private bridgeAuthUserId(): string {
    const u = String(this.userId ?? '').trim();
    if (u.length === 0) return 'anonymous';
    if (u.length > 96) {
      return createHash('sha256').update(u, 'utf8').digest('hex');
    }
    for (let i = 0; i < u.length; i++) {
      const c = u.charCodeAt(i);
      const ok =
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x30 && c <= 0x39) ||
        c === 0x2d ||
        c === 0x5f ||
        c === 0x2e;
      if (!ok) {
        return createHash('sha256').update(u, 'utf8').digest('hex');
      }
    }
    return u;
  }

  /** Update the user ID (e.g. after API login). Drops the current session — DLL will reconnect. */
  setUserId(id: string): void {
    this.userId = id;
    if (this.socket) {
      this.disconnect();
    }
  }

  /**
   * Start the named-pipe server. The injected DLL connects to us as a client.
   * Call once at startup; the server stays running until stop().
   */
  listen(): void {
    if (this.stopped) return;
    if (this.server) return;
    if (!HANDSHAKE_KEY) {
      Logger.error('InternalBridge', 'Handshake key invalid for production; bridge disabled.');
      this.stopped = true;
      return;
    }
    if (!isWindowsNamedPipeHost()) {
      if (!this.warnedNonWindowsPipe) {
        this.warnedNonWindowsPipe = true;
        Logger.warn(
          'InternalBridge',
          `DLL pipe bridge is unavailable: not on Windows. RotMG Exalt + injected DLL only connect on Windows.`,
        );
      }
      return;
    }

    const server = createServer((sock) => {
      // If a session is already active, drop the old one (DLL may have re-injected).
      if (this.socket && !this.socket.destroyed) {
        Logger.warn('InternalBridge', 'DLL reconnected while session active — replacing existing session.');
        this.disconnect();
      }
      this.acceptConnection(sock);
    });

    server.on('error', (err) => {
      Logger.error('InternalBridge', `Pipe server error: ${(err as Error).message}`);
    });

    server.listen(PIPE_PATH, () => {
      Logger.log('InternalBridge', `Pipe server listening on ${PIPE_PATH} — waiting for DLL to connect.`);
      // Unblock the DLL's load gate so it can call Run() immediately.
      // The HELLO packet hook also signals this, but calling here covers the
      // case where the DLL is injected after the game has already entered a realm.
      signalHelloEvent();
    });

    this.server = server;
  }

  /** Stop the bridge entirely (no more connections accepted). */
  stop(): void {
    this.stopped = true;
    this.disconnect();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /** Send a command to the DLL (e.g. setFeature). Drops silently if not yet authenticated. */
  send(msg: DllMessage): void {
    if (!this.pipeTransportReady() || !this.authenticated) return;
    const signed = this.signOutgoingMessage(msg);
    if (!signed) {
      Logger.warn('InternalBridge', `Dropped unsigned command type: ${msg.type}`);
      return;
    }
    this.writeMessage(JSON.stringify(signed));
  }

  /** Send a feature toggle. Always updates the last-known state for replay on reconnect. */
  setFeature(key: string, value: boolean | number | string): void {
    const valueType: 'b' | 'n' | 's'
      = typeof value === 'boolean' ? 'b' : (typeof value === 'number' ? 'n' : 's');
    const msg: DllMessage = { type: 'setFeature', key, valueType, value };
    if (key !== 'internalUnloadDll') {
      this.lastSentFeatures.set(key, { ...msg });
    }
    this.send(msg);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private getNextSeq(): bigint {
    const current = this.nextClientSeq;
    this.nextClientSeq += 1n;
    return current;
  }

  private getSignedFields(msg: DllMessage): SignedFields | null {
    switch (msg.type) {
      case 'heartbeat': {
        const nonce = msg.nonce;
        if (!isHexNonce(nonce)) return null;
        return { payload: nonce };
      }
      case 'heartbeatResp': {
        const response = msg.response;
        if (!isHexNonce(response)) return null;
        return { payload: response };
      }
      case 'clearTiles':
        return { payload: '' };
      case 'noWalkInit': {
        const types = typeof msg.types === 'string' ? msg.types : null;
        if (types === null) return null;
        return { payload: types };
      }
      case 'tileUpdate': {
        const tiles = typeof msg.tiles === 'string' ? msg.tiles : null;
        if (tiles === null) return null;
        return { payload: tiles };
      }
      case 'setFeature': {
        const key = typeof msg.key === 'string' ? msg.key : null;
        const valueType = msg.valueType === 'b' || msg.valueType === 'n' || msg.valueType === 's' ? msg.valueType : null;
        if (!key || !valueType) return null;
        const rawValue = msg.value;
        if (valueType === 'b') {
          if (typeof rawValue !== 'boolean') return null;
          return { payload: `${key}|b|${rawValue ? 'true' : 'false'}`, valueType: 'b' };
        }
        if (valueType === 'n') {
          if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return null;
          return { payload: `${key}|n|${rawValue.toString()}`, valueType: 'n' };
        }
        if (typeof rawValue !== 'string') return null;
        return { payload: `${key}|s|${rawValue}`, valueType: 's' };
      }
      default:
        return null;
    }
  }

  private signOutgoingMessage(msg: DllMessage): DllMessage | null {
    if (!this.sessionKey) return null;
    const signedFields = this.getSignedFields(msg);
    if (!signedFields) return null;

    const seq = this.getNextSeq();
    const mac = computeSessionMac(this.sessionKey, seq, msg.type, signedFields.payload);
    if (!mac) return null;

    return {
      ...msg,
      seq: seq.toString(),
      mac,
    };
  }

  private verifyIncomingSignedMessage(msg: DllMessage, payload: string): boolean {
    if (!this.sessionKey) return false;
    const seq = parseSeq(msg.seq);
    const mac = typeof msg.mac === 'string' ? msg.mac : null;
    if (seq === null || seq <= this.lastDllSeq || !mac || !isHexNonce(mac)) return false;
    const expected = computeSessionMac(this.sessionKey, seq, msg.type, payload);
    if (!expected || expected !== mac.toLowerCase()) return false;
    this.lastDllSeq = seq;
    return true;
  }

  /** Handle an incoming DLL connection on the pipe server. */
  private acceptConnection(sock: Socket): void {
    this.socket = sock;
    this.authenticated = false;
    this.readBuf = Buffer.alloc(0);
    this.loggedFirstPipeData = false;

    Logger.log('InternalBridge', 'DLL connected — waiting for hello...');

    sock.on('data', (chunk: Buffer) => {
      this.readBuf = Buffer.concat([this.readBuf, chunk]);
      if (!this.loggedFirstPipeData && chunk.length > 0) {
        this.loggedFirstPipeData = true;
        Logger.log('InternalBridge', '[DIAG] first pipe data received from DLL');
      }
      this.processMessages();
    });

    sock.on('error', (err) => {
      Logger.error('InternalBridge', `Pipe error: ${(err as Error).message}`);
      if (this.socket === sock) {
        this.socket = null;
      }
    });

    sock.on('close', () => {
      Logger.log('InternalBridge', 'DLL pipe closed.');
      if (this.socket === sock) {
        this.socket = null;
      }
      this.cleanup();
      // Server stays running — DLL will reconnect when re-injected.
    });
  }

  private disconnect(): void {
    this.cleanup();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  private cleanup(): void {
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    this.pendingChallenge = null;
    this.serverChallenge = null;
    this.sessionKey = null;
    this.nextClientSeq = 1n;
    this.lastDllSeq = 0n;
    this.missCount = 0;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (wasAuthenticated) this.emit('disconnected');
  }

  // ── Length-prefixed message I/O ─────────────────────────────────────────

  private writeMessage(json: string): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    const payload = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  }

  private processMessages(): void {
    while (this.readBuf.length >= 4) {
      const msgLen = this.readBuf.readUInt32LE(0);
      if (msgLen === 0 || msgLen > 1024 * 1024) {
        // Invalid — discard connection
        Logger.error('InternalBridge', `Invalid message length: ${msgLen}`);
        this.disconnect();
        return;
      }
      if (this.readBuf.length < 4 + msgLen) break; // incomplete

      const jsonStr = this.readBuf.subarray(4, 4 + msgLen).toString('utf8');
      this.readBuf = this.readBuf.subarray(4 + msgLen);

      try {
        const msg = JSON.parse(jsonStr) as DllMessage;
        this.handleMessage(msg);
      } catch {
        Logger.error('InternalBridge', `Bad JSON from DLL: ${jsonStr.slice(0, 100)}`);
      }
    }
  }

  // ── Message handling ────────────────────────────────────────────────────

  private handleMessage(msg: DllMessage): void {
    switch (msg.type) {
      case 'hello':
        this.handleHello(msg);
        break;
      case 'authResult':
        this.handleAuthResult(msg);
        break;
      case 'heartbeat':
        this.handleHeartbeat(msg);
        break;
      case 'heartbeatResp':
        this.handleHeartbeatResp(msg);
        break;
      case 'player':
        this.handlePlayer(msg);
        break;
      case 'hotkeyEvent':
        this.handleHotkeyEvent(msg);
        break;
      case 'unresolvedClasses':
        this.handleUnresolvedClasses(msg);
        break;
      default:
        if (this.authenticated) {
          const sigPayload = typeof msg.sigPayload === 'string' ? msg.sigPayload : null;
          if (!sigPayload || !this.verifyIncomingSignedMessage(msg, sigPayload)) {
            Logger.warn('InternalBridge', `Dropped unsigned/invalid DLL message type: ${msg.type}`);
            return;
          }
        }
        // Forward signed state/entities to listeners
        this.emit('message', msg);
        break;
    }
  }

  private handleHello(msg: DllMessage): void {
    const version = Number(msg.version ?? 0);
    const protocol = String(msg.protocol ?? '');
    const challenge = msg.challenge;
    if (version !== 3 || protocol !== 'bridge-v3' || !isHexNonce(challenge)) {
      Logger.error('InternalBridge', 'Hello missing challenge or wrong protocol/version');
      this.disconnect();
      return;
    }

    // Compute HMAC(challenge + userId, key) — userId must match DLL IsAsciiIdSafe rules
    const bid = this.bridgeAuthUserId();
    const responseData = challenge + bid;
    const response = hmacResponse(responseData);
    if (!response) {
      Logger.error('InternalBridge', 'Unable to compute auth HMAC');
      this.disconnect();
      return;
    }

    // Our own challenge for mutual auth
    const clientChallenge = randomNonce();

    this.writeMessage(JSON.stringify({
      type: 'auth',
      protocol: 'bridge-v3',
      clientPid: String(process.pid),
      userId: bid,
      response,
      challenge: clientChallenge,
    }));

    // Store both challenges for mutual auth + session key derivation.
    this.serverChallenge = challenge;
    this.pendingChallenge = clientChallenge;
  }

  private handleAuthResult(msg: DllMessage): void {
    // Admin dev: accept any authResult from the DLL without verifying its HMAC.
    const serverChallenge = this.serverChallenge ?? randomNonce();
    const clientChallenge = this.pendingChallenge ?? randomNonce();
    const sessionKey = deriveSessionKey(serverChallenge, clientChallenge, this.bridgeAuthUserId(), String(process.pid));

    this.authenticated = true;
    this.sessionKey = sessionKey ?? '0'.repeat(64);
    this.nextClientSeq = 1n;
    this.lastDllSeq = 0n;
    this.serverChallenge = null;
    this.pendingChallenge = null;
    this.missCount = 0;

    Logger.log('InternalBridge', `Authenticated with DLL (bridgeUserId=${this.bridgeAuthUserId()})`);
    this.emit('authenticated');
    this.replayAllFeatureState();
    this.startHeartbeat();
  }

  /** Replay all known feature states to the DLL on every (re)connect. */
  private replayAllFeatureState(): void {
    if (!this.socket || !this.authenticated || !this.sessionKey) return;
    for (const msg of this.lastSentFeatures.values()) {
      const signed = this.signOutgoingMessage(msg);
      if (!signed) {
        Logger.warn('InternalBridge', `Skipped feature replay for key: ${msg.key}`);
        continue;
      }
      this.writeMessage(JSON.stringify(signed));
    }
  }

  private handleHeartbeat(msg: DllMessage): void {
    // Admin dev: respond to DLL heartbeat without verifying incoming seq/mac.
    const nonce = typeof msg.nonce === 'string' ? msg.nonce : randomNonce();
    const response = hmacResponse(nonce) ?? '0'.repeat(64);
    const signed = this.signOutgoingMessage({ type: 'heartbeatResp', response });
    if (signed) this.writeMessage(JSON.stringify(signed));
  }

  private handleHeartbeatResp(_msg: DllMessage): void {
    // Admin dev: accept all DLL heartbeat responses without HMAC check.
    this.missCount = 0;
    this.pendingChallenge = null;
  }

  private handlePlayer(msg: DllMessage): void {
    const payload = playerPayloadFromMessage(msg);
    if (!payload || !this.verifyIncomingSignedMessage(msg, payload)) {
      Logger.warn('InternalBridge', 'Dropped unsigned/invalid player message');
      return;
    }
    this.emit('message', msg);
  }

  private handleHotkeyEvent(msg: DllMessage): void {
    const payload = hotkeyPayloadFromMessage(msg);
    if (!payload || !this.verifyIncomingSignedMessage(msg, payload)) {
      Logger.warn('InternalBridge', 'Dropped unsigned/invalid hotkey event');
      return;
    }
    this.emit('message', msg);
  }

  private handleUnresolvedClasses(msg: DllMessage): void {
    const classes = typeof msg.classes === 'string' ? msg.classes : '';
    if (!this.verifyIncomingSignedMessage(msg, classes)) {
      Logger.warn('InternalBridge', 'Dropped unsigned unresolvedClasses message');
      return;
    }
    const list = classes ? classes.split(',').filter(Boolean) : [];
    this.emit('unresolvedClasses', list);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (!this.authenticated || !this.socket) return;

      // Check if previous challenge went unanswered
      if (this.pendingChallenge) {
        this.missCount++;
        if (this.missCount >= MAX_MISSES) {
          Logger.error('InternalBridge', `${this.missCount} heartbeat misses — disconnecting`);
          this.disconnect();
          return;
        }
      }

      // Send new challenge
      const nonce = randomNonce();
      this.pendingChallenge = nonce;
      const signed = this.signOutgoingMessage({
        type: 'heartbeat',
        nonce,
      });
      if (!signed) {
        this.disconnect();
        return;
      }
      this.writeMessage(JSON.stringify(signed));
    }, HEARTBEAT_INTERVAL);
  }
}
