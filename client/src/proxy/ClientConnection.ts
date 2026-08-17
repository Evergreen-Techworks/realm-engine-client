import net from 'net';
import { RC4Cipher } from '../crypto/RC4Cipher.js';
import { PacketBuffer } from '../packets/PacketBuffer.js';
import { type Packet } from '../packets/Packet.js';
import { PacketWriter } from '../packets/PacketWriter.js';
import { State } from '../state/State.js';
import { PlayerData } from '../state/PlayerData.js';
import { Logger } from '../util/Logger.js';
import type { Proxy } from './Proxy.js';

const CLIENT_KEY = '5a4d2016bc16dc64883194ffd9';
const SERVER_KEY = 'c91d9eec420160730d825604e0';

/**
 * Manages a single client session — both the client-side and server-side
 * TCP connections with their respective RC4 ciphers.
 * Ported from KRelayBetter's Client.cs.
 */
export class ClientConnection {
  // 4 cipher instances matching KRelayBetter exactly
  private clientReceiveCipher = new RC4Cipher(CLIENT_KEY); // decrypt FROM client
  private clientSendCipher    = new RC4Cipher(SERVER_KEY); // encrypt TO client
  private serverReceiveCipher = new RC4Cipher(SERVER_KEY); // decrypt FROM server
  private serverSendCipher    = new RC4Cipher(CLIENT_KEY); // encrypt TO server

  private clientSocket: net.Socket;
  private serverSocket: net.Socket | null = null;
  private clientBuffer = new PacketBuffer();
  private serverBuffer = new PacketBuffer();
  private closed = false;
  private serverConnecting = false; // true while async TCP connect is in progress
  private pendingServerQueue: Buffer[] = []; // packets buffered during connect

  state!: State;
  playerData = new PlayerData();
  lastUpdate = 0;
  previousTime = 0;
  relativeTime = 0;
  /** Wall-clock ms when the server TCP connection was established. Used for game time (matches pyrelay getTime()). */
  serverConnectedAt = 0;
  lastNewTickId = 0;
  lastServerRealTimeMs = 0;
  lastClientMoveAt = 0;
  lastTeleportSentAt = 0;
  lastTeleportGotoAt = 0;
  pendingTeleportSentAt = 0;
  pendingTeleportTargetObjectId: number | null = null;
  originalTargetIp = ''; // Set by Proxy from DLL temp file
  clientId = '';         // Unique ID assigned by Proxy on connect

  // Accumulated data for each direction
  private clientAccum = Buffer.alloc(0);
  private serverAccum = Buffer.alloc(0);

  // HELLO retry state — resends HELLO if the server doesn't respond within the delay
  private _pendingHello: Packet | null = null;
  private _helloRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _helloRetryCount = 0;
  private _serverResponded = false;
  private _helloIsRetrying = false;
  private static readonly HELLO_RETRY_MS  = 3000;
  private static readonly HELLO_MAX_RETRIES = 3;

  constructor(
    private proxy: Proxy,
    clientSocket: net.Socket,
  ) {
    this.clientSocket = clientSocket;
    this.clientSocket.setNoDelay(true);
    this.clientSocket.on('data', (data) => this.onClientData(data));
    this.clientSocket.on('error', (err) => this.onError('client', err));
    this.clientSocket.on('close', () => this.dispose());
  }

  get time(): number {
    return Date.now() + this.relativeTime;
  }

  /** Game time as ms since server TCP connect — matches pyrelay getTime(). Fallback to relativeTime method. */
  get gameTime(): number {
    if (this.serverConnectedAt > 0) return Date.now() - this.serverConnectedAt;
    return Math.max(0, Date.now() + this.relativeTime);
  }

  get objectId(): number {
    return this.playerData.ownerObjectId;
  }

  get connected(): boolean {
    return !this.closed;
  }

  /** Connect to the real game server. Called by ReconnectHandler after HELLO. */
  connectToServer(helloPacket: Packet): void {
    // Cancel any pending retry timer
    if (this._helloRetryTimer) {
      clearTimeout(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }

    // Fresh connect resets the retry counter; retries preserve it
    if (this._helloIsRetrying) {
      this._helloIsRetrying = false;
    } else {
      this._helloRetryCount = 0;
    }

    // Close existing server socket without triggering dispose (remove listeners first)
    if (this.serverSocket) {
      this.serverSocket.removeAllListeners();
      this.serverSocket.destroy();
      this.serverSocket = null;
    }

    // Reset server-side ciphers for the new connection
    this.serverReceiveCipher = new RC4Cipher(SERVER_KEY);
    this.serverSendCipher = new RC4Cipher(CLIENT_KEY);
    this.serverBuffer = new PacketBuffer();
    this.serverAccum = Buffer.alloc(0);

    this._pendingHello = helloPacket;
    this._serverResponded = false;
    this.serverConnecting = true;
    this.pendingServerQueue = [];

    this.serverSocket = new net.Socket();
    this.serverSocket.setNoDelay(true);

    this.serverSocket.on('data', (data) => this.onServerData(data));
    this.serverSocket.on('error', (err) => this.onError('server', err));
    this.serverSocket.on('close', () => this.dispose());

    const key = helloPacket.data.key;
    Logger.log('Client', `Connecting to ${this.state.conTargetAddress}:${this.state.conTargetPort}...`);
    Logger.debug('reconnect', 'Client', `HELLO key being sent (${Buffer.isBuffer(key) ? key.length : 0} bytes): ${Buffer.isBuffer(key) ? key.toString('hex').slice(0, 80) : typeof key}`);

    this.serverSocket.connect(this.state.conTargetPort, this.state.conTargetAddress, () => {
      this.serverConnectedAt = Date.now();
      Logger.log('Client', `Connected to ${this.state.conTargetAddress}:${this.state.conTargetPort}`);
      this.serverConnecting = false;

      // Send the HELLO — use raw decrypted bytes (forwardRaw re-encrypts them).
      // NEVER use sendToServer here: it calls serialize() which reconstructs the
      // packet from parsed fields. After a game update, stale packet definitions
      // produce corrupt bytes and DECA drops the connection.
      // forwardRaw preserves the original bytes exactly (decrypt → re-encrypt = identity).
      Logger.debug('proxy', 'Client', `[DIAG-connect] about to forward HELLO (modified=${helloPacket.modified}, rawLen=${helloPacket.rawBytes?.length ?? 0})`);
      if (helloPacket.modified) {
        this.sendToServer(helloPacket); // only for reconnect key patching
      } else {
        this.forwardRaw(helloPacket.rawBytes, false);
      }
      Logger.debug('proxy', 'Client', `[DIAG-connect] HELLO forwarded`);

      // Flush any packets that arrived from the client while we were connecting.
      // Without this, those packets are lost and the RC4 cipher desyncs.
      this.flushPendingServerQueue();
      Logger.debug('proxy', 'Client', `[DIAG-connect] flushed pending queue (size=${this.pendingServerQueue.length})`);

      try {
        this.proxy.fireClientConnected(this);
        Logger.debug('proxy', 'Client', `[DIAG-connect] fireClientConnected returned`);
      } catch (err) {
        Logger.error('Client', `[DIAG-connect] fireClientConnected THREW`, err as Error);
      }
      try {
        this._scheduleHelloRetry();
        Logger.debug('proxy', 'Client', `[DIAG-connect] HELLO retry scheduled — waiting for server`);
      } catch (err) {
        Logger.error('Client', `[DIAG-connect] _scheduleHelloRetry THREW`, err as Error);
      }
    });
  }

  /** Schedule a HELLO resend if the server doesn't respond within HELLO_RETRY_MS. */
  private _scheduleHelloRetry(): void {
    this._helloRetryTimer = setTimeout(() => {
      this._helloRetryTimer = null;
      if (this._serverResponded || this.closed || !this._pendingHello) return;

      if (this._helloRetryCount >= ClientConnection.HELLO_MAX_RETRIES) {
        Logger.warn('Client', `HELLO unanswered after ${ClientConnection.HELLO_MAX_RETRIES} retries — giving up`);
        return;
      }

      this._helloRetryCount++;
      this._helloIsRetrying = true;
      Logger.log('Client', `HELLO unanswered — retry ${this._helloRetryCount}/${ClientConnection.HELLO_MAX_RETRIES}`);
      this.connectToServer(this._pendingHello);
    }, ClientConnection.HELLO_RETRY_MS);
  }

  /** Send a packet to the game client. */
  sendToClient(packet: Packet): void {
    this.send(packet, true);
  }

  /** Send a packet to the game server. */
  sendToServer(packet: Packet): void {
    this.send(packet, false);
  }

  sendRawToServer(rawBytes: Buffer): void {
    if (this.closed) return;
    this.forwardRaw(rawBytes, false);
  }


  // ─── Lag-switch API ─────────────────────────────────────────────
  //
  // When lagMode is true, every packet that would have been forwarded is
  // queued instead.  The plaintext (already-decrypted / freshly-serialized)
  // bytes are stored, so flushLagQueue() can re-encrypt them via forwardRaw()
  // in order — keeping both sides' RC4 cipher states in sync.

  /** Set true to queue forwarded packets rather than sending them. */
  public lagMode = false;
  private _lagQueue: Array<{ rawBytes: Buffer; toClient: boolean }> = [];

  /** Forward all queued packets. Returns the count flushed. */
  public flushLagQueue(): number {
    const n = this._lagQueue.length;
    for (const item of this._lagQueue) {
      this.forwardRaw(item.rawBytes, item.toClient);
    }
    this._lagQueue = [];
    return n;
  }

  /** Discard all queued packets without sending them. Returns the count dropped. */
  public dropLagQueue(): number {
    const n = this._lagQueue.length;
    this._lagQueue = [];
    return n;
  }

  public get lagQueueSize(): number { return this._lagQueue.length; }
  public get lagQueueBytes(): number {
    return this._lagQueue.reduce((sum, item) => sum + item.rawBytes.length, 0);
  }

  /** Clean up both connections. */
  dispose(): void {
    if (this.closed) return;
    Logger.debug('proxy', 'Client', `[DIAG-dispose] called — stack: ${(new Error().stack ?? '').split('\n').slice(1, 5).join(' | ').trim()}`);
    this.closed = true;

    if (this._helloRetryTimer) {
      clearTimeout(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }

    this.proxy.fireClientDisconnected(this);

    try { this.clientSocket.destroy(); } catch {}
    try { this.serverSocket?.destroy(); } catch {}
    this.clientBuffer.dispose();
    this.serverBuffer.dispose();
    Logger.log('Client', 'Disconnected.');
  }

  // ─── Internal I/O ─────────────────────────────────────────────

  private send(packet: Packet, toClient: boolean): void {
    try {
      const data = this.proxy.packetFactory.serialize(packet);
      const cipher = toClient ? this.clientSendCipher : this.serverSendCipher;
      const socket = toClient ? this.clientSocket : this.serverSocket;

      if (!socket || socket.destroyed) return;

      cipher.cipher(data);
      socket.write(data);
    } catch (err) {
      Logger.error('Client', `Send error (${toClient ? 'client' : 'server'})`, err as Error);
      this.dispose();
    }
  }

  /** Forward original raw bytes (already decrypted) by re-encrypting for the target direction. */
  private forwardRaw(rawBytes: Buffer, toClient: boolean): void {
    try {
      const cipher = toClient ? this.clientSendCipher : this.serverSendCipher;
      const socket = toClient ? this.clientSocket : this.serverSocket;

      // Buffer packets heading to server while it's still connecting.
      // Without this, packets arriving during the ~50ms async TCP connect window
      // get silently dropped, desyncing the RC4 cipher and corrupting all traffic.
      if (!toClient && this.serverConnecting) {
        const copy = Buffer.from(rawBytes);
        cipher.cipher(copy);
        this.pendingServerQueue.push(copy);
        return;
      }

      if (!socket || socket.destroyed) {
        Logger.warn('Client', `[DIAG-forwardRaw] skipped — socket ${toClient ? 'client' : 'server'} is ${socket ? 'destroyed' : 'null'}`);
        return;
      }

      // Make a copy so we don't corrupt the original rawBytes
      const copy = Buffer.from(rawBytes);
      cipher.cipher(copy);
      socket.write(copy);
    } catch (err) {
      Logger.error('Client', `ForwardRaw error (${toClient ? 'client' : 'server'})`, err as Error);
      this.dispose();
    }
  }

  /** Flush any packets that were buffered during server connect. */
  private flushPendingServerQueue(): void {
    if (this.pendingServerQueue.length === 0) return;
    Logger.log('Client', `Flushing ${this.pendingServerQueue.length} buffered packets to server`);
    for (const encrypted of this.pendingServerQueue) {
      if (this.serverSocket && !this.serverSocket.destroyed) {
        this.serverSocket.write(encrypted);
      }
    }
    this.pendingServerQueue = [];
  }

  private onClientData(data: Buffer): void {
    this.processIncoming(data, true);
  }

  private onServerData(data: Buffer): void {
    // Logger.log('Client', `[DIAG-onServerData] got ${data.length} bytes from server (firstByte=0x${data.length ? data[0].toString(16) : 'n/a'})`);
    // First data from server after HELLO — cancel retry timer
    if (!this._serverResponded) {
      this._serverResponded = true;
      this._helloRetryCount = 0;
      if (this._helloRetryTimer) {
        clearTimeout(this._helloRetryTimer);
        this._helloRetryTimer = null;
      }
    }
    this.processIncoming(data, false);
  }

  /**
   * Process incoming TCP data stream, extracting complete packets.
   * Mirrors KRelayBetter's RemoteRead logic with PacketBuffer.
   */
  private processIncoming(data: Buffer, isClient: boolean): void {
    const cipher = isClient ? this.clientReceiveCipher : this.serverReceiveCipher;

    // Accumulate data
    let accumRef = isClient ? this.clientAccum : this.serverAccum;
    if (accumRef.length === 0) {
      accumRef = Buffer.from(data);
    } else {
      accumRef = Buffer.concat([accumRef, data], accumRef.length + data.length);
    }
    if (isClient) this.clientAccum = accumRef;
    else this.serverAccum = accumRef;

    try {
      while (true) {
        const accum = isClient ? this.clientAccum : this.serverAccum;
        if (accum.length < 4) break; // Need at least 4 bytes for length

        // Read packet length from first 4 bytes (big-endian)
        const packetLength = accum.readInt32BE(0);

        if (packetLength <= 0 || packetLength > 1_048_576) {
          Logger.warn('Client', `Invalid packet length: ${packetLength}, disconnecting`);
          this.dispose();
          return;
        }

        if (accum.length < packetLength) break; // Wait for more data

        // Extract the complete packet
        const rawPacket = Buffer.alloc(packetLength);
        accum.copy(rawPacket, 0, 0, packetLength);


        // Remove from accumulator
        const remaining = accum.subarray(packetLength);
        const nextAccum = Buffer.from(remaining);
        if (isClient) this.clientAccum = nextAccum;
        else this.serverAccum = nextAccum;

        // Decrypt the body (skip 5-byte header)
        cipher.cipher(rawPacket);

        // Parse the packet
        const packet = this.proxy.packetFactory.createFromBytes(rawPacket);

        // Log any server FAILURE packet so rejection reasons are visible.
        if (!isClient && packet.name === 'FAILURE' && packet.isDefined) {
          Logger.warn('Client', `[DIAG-FAILURE] errorId=${packet.data.errorId} errorMessage="${packet.data.errorMessage}"`);
        }

        // Fire hooks
        if (isClient) {
          this.proxy.fireClientPacket(this, packet);
        } else {
          this.proxy.fireServerPacket(this, packet);
        }

        // Forward if not blocked
        if (packet.send) {
          // Resolve to plaintext bytes: use re-serialization only if explicitly modified
          // via data fields. If a hook patched rawBytes directly (raw-byte patching for
          // update resilience), packet.rawBytes differs from rawPacket — use it.
          const plainBytes = packet.modified
            ? this.proxy.packetFactory.serialize(packet)
            : packet.rawBytes !== rawPacket ? packet.rawBytes : rawPacket;

          if (this.lagMode) {
            // Lag is active — queue for later flush
            this._lagQueue.push({ rawBytes: Buffer.from(plainBytes), toClient: !isClient });
          } else {
            // Normal path — re-encrypt and send
            this.forwardRaw(plainBytes, !isClient);
          }
        }
      }
    } catch (err) {
      Logger.error('Client', `Process error (${isClient ? 'client' : 'server'})`, err as Error);
      this.dispose();
    }
  }

  // Note: packet assembly still compacts by materializing remaining bytes so
  // buffers do not retain large backing stores across long sessions.

  private onError(source: string, err: Error): void {
    if (this.closed) return;
    const code = (err as any).code as string | undefined;
    Logger.debug('proxy', 'Client', `[DIAG-onError] source=${source} code=${code ?? 'n/a'} message=${err.message}`);

    // ECONNRESET / EPIPE are normal disconnect signals — just clean up
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      this.dispose();
      return;
    }

    // Server socket failed before HELLO was answered (e.g. ETIMEDOUT, ECONNREFUSED)
    // Retry instead of giving up immediately
    if (source === 'server' && !this._serverResponded && this._pendingHello) {
      if (this._helloRetryCount < ClientConnection.HELLO_MAX_RETRIES) {
        this._helloRetryCount++;
        this._helloIsRetrying = true;
        Logger.warn('Client', `Server error before HELLO response (${code ?? err.message}) — retry ${this._helloRetryCount}/${ClientConnection.HELLO_MAX_RETRIES}`);
        this.connectToServer(this._pendingHello);
        return;
      }
      Logger.warn('Client', `Server unreachable after ${ClientConnection.HELLO_MAX_RETRIES} retries (${code ?? err.message}) — giving up`);
      this.dispose();
      return;
    }

    Logger.error('Client', `${source} socket error`, err);
    this.dispose();
  }
}
