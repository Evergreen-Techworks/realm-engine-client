/**
 * InternalBridge — Named-pipe server accepting the injected DLL.
 *
 * The DLL connects to us (Node.js is the pipe server). The DLL sends `hello`
 * first regardless of which side created the pipe.
 *
 * Messages are plaintext length-prefixed JSON, dispatched purely by `type` —
 * there is no per-message signing/verification and no mutual-auth handshake.
 *
 * Handles:
 *   - Connection setup (validate `hello` protocol/version, then treat as connected)
 *   - Periodic heartbeat (both directions) for liveness
 *   - Command relay (forward dashboard feature toggles to the DLL)
 *   - State/player/entity reception from the DLL
 */

import { createServer, Server, Socket } from 'net';
import { Logger } from '../util/Logger.js';
import { EventEmitter } from 'events';
import { BRIDGE, DllMessageType } from './contract.js';
import { decodeThreatPayload, publishDllThreats } from './DllThreatBus.js';
import { decodeAimPayload, publishDllAim } from './DllAimBus.js';
import { decodeNavigationStatus, publishNavigationStatus } from './DllNavigationBus.js';
import { DiagGate } from '../util/DiagGate.js';
import { LatencyAggregator } from '../util/DiagAggregator.js';
import { RateLimiter } from '../util/DiagRateLimit.js';

const PIPE_PATH = BRIDGE.DEV_PIPE_NAME;

/** RotMG Exalt + DLL use Windows named pipes; Node cannot expose them on Linux/WSL/macOS. */
function isWindowsNamedPipeHost(): boolean {
  return process.platform === 'win32';
}

const HEARTBEAT_INTERVAL = 5000;
const MAX_MISSES = 3;
const IS_PROD = process.env.REALM_ENGINE_PROD === '1';

// item 4b (measurement only): client-side half of the bridge command latency
// probe. This measures setFeature()'s own call -> pipe-write span (JSON
// encode + socket.write), on the Node clock only — it never tries to
// reconcile with the DLL's clock. The DLL side measures its own
// receive->apply delta independently (BridgeLatencyDiag.h) and logs to
// native-trace.log; the two share the [Diag/Bridge] tag but are read
// side-by-side, not joined. See the item 4b report for why: there is no
// existing per-command ack to round-trip against, and adding one would be a
// wire-protocol change this measurement-only task avoids.
const BRIDGE_SLOW_MS = 100;
const bridgeSendLatency = new LatencyAggregator('Diag/Bridge');
const bridgeSlowLineLimiter = new RateLimiter(5, 5000);
let bridgeSendSeq = 0;

export interface DllMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Narrow view of `InternalBridge` for consumers that only need to react to the
 * DLL (re)connecting — e.g. reissuing state that `replayAllFeatureState`
 * deliberately does not replay (see the `scriptNavigationGoal` exclusion in
 * `setFeature`). `authenticated` fires once per successful hello: the first
 * connect and every reconnect after a drop.
 */
export type DllReconnectSource = {
  on(event: 'authenticated', listener: () => void): unknown;
  off(event: 'authenticated', listener: () => void): unknown;
};

export class InternalBridge extends EventEmitter {
  private server: Server | null = null;
  private socket: Socket | null = null;
  private userId: string;
  private connected = false;
  private stopped = false;

  // Heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missCount = 0;
  /** True while a heartbeat is out awaiting a `heartbeatResp`; cleared on receipt. */
  private awaitingHeartbeat = false;

  /** Latest authoritative defense the DLL read from game memory; null when not alive / not sent. */
  private lastDllDefense: number | null = null;

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

  get isConnected(): boolean { return this.connected && this.pipeTransportReady(); }
  get currentUserId(): string { return this.userId; }

  /** Non-null only while the OS pipe connection is alive. */
  private pipeTransportReady(): boolean {
    return this.socket !== null && !this.socket.destroyed;
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
      this.emit('listening');
      Logger.log('InternalBridge', `Pipe server listening on ${PIPE_PATH} — waiting for DLL to connect.`);
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

  /**
   * Send a command to the DLL (e.g. setFeature). Returns whether it actually
   * reached the pipe — false (dropped silently, not an error) when the DLL
   * isn't connected. Callers that need to know "the DLL has this" vs "nobody
   * received this" (e.g. a script's navigation goal) must use this return
   * value instead of assuming a call that didn't throw was delivered.
   */
  send(msg: DllMessage): boolean {
    if (!this.pipeTransportReady() || !this.connected) return false;
    return this.writeMessage(JSON.stringify(msg));
  }

  /**
   * Send a feature toggle. Always updates the last-known state for replay on
   * reconnect. Returns whether the DLL actually received it right now (see `send`).
   */
  setFeature(key: string, value: boolean | number | string): boolean {
    const valueType: 'b' | 'n' | 's'
      = typeof value === 'boolean' ? 'b' : (typeof value === 'number' ? 'n' : 's');
    const msg: DllMessage = { type: DllMessageType.SetFeature, key, valueType, value };
    if (key !== 'internalUnloadDll' && key !== 'scriptNavigationGoal') {
      this.lastSentFeatures.set(key, { ...msg });
    }
    if (!DiagGate.on()) {
      return this.send(msg);
    }
    // item 4b: local-only sequence number for correlating log lines within a
    // session — never sent over the wire (see the comment above the module
    // constants for why this doesn't round-trip against the DLL).
    const seq = ++bridgeSendSeq;
    const t0 = performance.now();
    const delivered = this.send(msg);
    const elapsedMs = performance.now() - t0;
    bridgeSendLatency.record(elapsedMs);
    if (elapsedMs > BRIDGE_SLOW_MS && bridgeSlowLineLimiter.allow()) {
      Logger.log('Diag/Bridge', `key=${key} seq=${seq} send=${elapsedMs.toFixed(1)}ms (>${BRIDGE_SLOW_MS}ms)`);
    }
    return delivered;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** Handle an incoming DLL connection on the pipe server. */
  private acceptConnection(sock: Socket): void {
    this.socket = sock;
    this.connected = false;
    this.readBuf = Buffer.alloc(0);
    this.loggedFirstPipeData = false;

    Logger.log('InternalBridge', 'DLL connected — waiting for hello...');

    sock.on('data', (chunk: Buffer) => {
      this.readBuf = Buffer.concat([this.readBuf, chunk]);
      if (!this.loggedFirstPipeData && chunk.length > 0) {
        this.loggedFirstPipeData = true;
        Logger.debug('proxy', 'InternalBridge', '[DIAG] first pipe data received from DLL');
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
    const wasConnected = this.connected;
    this.connected = false;
    this.missCount = 0;
    this.awaitingHeartbeat = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (wasConnected) this.emit('disconnected');
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
      case DllMessageType.Hello:
        this.handleHello(msg);
        break;
      case DllMessageType.Heartbeat:
        this.handleHeartbeat();
        break;
      case DllMessageType.HeartbeatResp:
        this.handleHeartbeatResp();
        break;
      case DllMessageType.Player:
        this.handlePlayer(msg);
        break;
      case DllMessageType.HotkeyEvent:
        this.handleHotkeyEvent(msg);
        break;
      case DllMessageType.UnresolvedClasses:
        this.handleUnresolvedClasses(msg);
        break;
      case DllMessageType.Threats:
        this.handleThreats(msg);
        break;
      case DllMessageType.Aim:
        this.handleAim(msg);
        break;
      case DllMessageType.NavStatus: {
        const status = decodeNavigationStatus(msg);
        if (this.connected && status) publishNavigationStatus(status);
        break;
      }
      default:
        // Forward any other state/entity message to listeners.
        this.emit('message', msg);
        break;
    }
  }

  private handleHello(msg: DllMessage): void {
    const version = Number(msg.version ?? 0);
    const protocol = String(msg.protocol ?? '');
    if (version !== BRIDGE.PROTOCOL_VERSION || protocol !== BRIDGE.PROTOCOL_TAG) {
      Logger.error('InternalBridge', 'Hello wrong protocol/version');
      this.disconnect();
      return;
    }

    this.connected = true;
    this.missCount = 0;
    this.awaitingHeartbeat = false;
    Logger.log('InternalBridge', 'DLL connected (plaintext bridge).');
    this.emit('authenticated');            // event name kept for DevServer compat
    this.replayAllFeatureState();
    this.startHeartbeat();
  }

  /** Replay all known feature states to the DLL on every (re)connect. */
  private replayAllFeatureState(): void {
    if (!this.socket || !this.connected) return;
    for (const msg of this.lastSentFeatures.values()) {
      this.writeMessage(JSON.stringify(msg));
    }
  }

  private handleHeartbeat(): void {
    this.writeMessage(JSON.stringify({ type: DllMessageType.HeartbeatResp }));
  }

  private handleHeartbeatResp(): void {
    this.missCount = 0;
    this.awaitingHeartbeat = false;
  }

  private handlePlayer(msg: DllMessage): void {
    // Cache the memory-read defense (authoritative ground truth from the game).
    // Cleared when the player isn't alive so the proxy self-check re-arms per load.
    const def = typeof msg.def === 'number' && Number.isFinite(msg.def) ? Math.trunc(msg.def) : null;
    this.lastDllDefense = msg.alive === true ? def : null;
    this.emit('message', msg);
  }

  /** Authoritative defense the DLL read from game memory (null if unavailable / not alive). */
  getDllDefense(): number | null {
    return this.lastDllDefense;
  }

  private handleHotkeyEvent(msg: DllMessage): void {
    this.emit('message', msg);
  }

  private handleThreats(msg: DllMessage): void {
    const payload = typeof msg.threats === 'string' ? msg.threats : '';
    const parsed = decodeThreatPayload(payload);
    publishDllThreats(parsed.threats, parsed.ground, parsed.truncated);
  }

  private handleAim(msg: DllMessage): void {
    const payload = typeof msg.aim === 'string' ? msg.aim : '';
    publishDllAim(decodeAimPayload(payload));
  }

  private handleUnresolvedClasses(msg: DllMessage): void {
    const classes = typeof msg.classes === 'string' ? msg.classes : '';
    const list = classes ? classes.split(',').filter(Boolean) : [];
    this.emit('unresolvedClasses', list);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.awaitingHeartbeat = false;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.socket) return;

      // Check if the previous heartbeat went unanswered.
      if (this.awaitingHeartbeat) {
        this.missCount++;
        if (this.missCount >= MAX_MISSES) {
          Logger.error('InternalBridge', `${this.missCount} heartbeat misses — disconnecting`);
          this.disconnect();
          return;
        }
      }

      // handleHeartbeatResp clears `awaitingHeartbeat` + resets missCount on reply.
      this.awaitingHeartbeat = true;
      this.writeMessage(JSON.stringify({ type: DllMessageType.Heartbeat }));
    }, HEARTBEAT_INTERVAL);
  }
}
