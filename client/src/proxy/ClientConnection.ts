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

/** `name=value` for each parsed field, or the raw body when the packet did not parse. */
function describeFields(packet: Packet, rawPacket: Buffer): string {
  if (!packet.isDefined) {
    return `UNPARSEABLE len=${rawPacket.length - 5} hex=${rawPacket.subarray(5, 69).toString('hex')}`;
  }
  const fields = Object.entries(packet.data).map(([name, value]) => `${name}=${value}`).join(' ');
  return packet.unreadData.length > 0
    ? `${fields} unread=${packet.unreadData.toString('hex')}`
    : fields;
}

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
  /**
   * Epoch ms until the SERVER will accept another TELEPORT. Set when a sent
   * TELEPORT is answered by a NOTIFICATION (refusal) instead of a GOTO
   * (success), or when it is answered by nothing at all. Read by the script
   * bridge so callers stop sending packets the server has already rejected.
   */
  teleportBlockedUntil = 0;
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
  private static readonly HELLO_RETRY_MS  = 3000;
  private static readonly HELLO_MAX_RETRIES = 3;

  // Silent-end retry state. A full server can end the connection before it sends
  // a single packet: a reset, a clean close, or a FAILURE that Windows discards
  // because the reset arrives first. The game hears nothing and hangs on the
  // loading screen, so the proxy keeps the game's socket open, retries the same
  // HELLO, and finally tells the game the server is full in the game's own words.
  private _serverPacketReceived = false;
  private _silentRetryCount = 0;
  private _silentRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _closeAfterFailureTimer: ReturnType<typeof setTimeout> | null = null;
  static readonly SILENT_RETRY_MS = 5000;
  static readonly SILENT_MAX_RETRIES = 3;
  /** How long the game gets to close its side after the synthesized FAILURE. */
  private static readonly CLOSE_AFTER_FAILURE_MS = 5000;
  /**
   * The server's own full-server rejection (errorId 0). The game answers it by
   * retrying the same server about every 5 s, which is what it should do here.
   */
  static readonly FULL_SERVER_ERROR_ID = 0;
  static readonly FULL_SERVER_MESSAGE = 'Can not add player due to connection amount limits';

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
    // A HELLO from the game starts fresh; the proxy's own retries keep their counts.
    this._helloRetryCount = 0;
    this._silentRetryCount = 0;
    this.openServerConnection(helloPacket);
  }

  /** Open a server connection and send `helloPacket` on it. Retries call this directly. */
  private openServerConnection(helloPacket: Packet): void {
    // Cancel any pending retry timer
    if (this._helloRetryTimer) {
      clearTimeout(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }
    if (this._silentRetryTimer) {
      clearTimeout(this._silentRetryTimer);
      this._silentRetryTimer = null;
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
    this._serverPacketReceived = false;
    this.serverConnecting = true;
    this.pendingServerQueue = [];

    const socket = new net.Socket();
    this.serverSocket = socket;
    socket.setNoDelay(true);

    socket.on('data', (data) => this.onServerData(data));
    socket.on('error', (err) => {
      if (this.onServerEnded(socket, (err as NodeJS.ErrnoException).code ?? err.message)) return;
      this.onError('server', err);
    });
    socket.on('close', () => {
      if (this.onServerEnded(socket, 'close')) return;
      this.dispose();
    });

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
      Logger.log('Client', `HELLO unanswered — retry ${this._helloRetryCount}/${ClientConnection.HELLO_MAX_RETRIES}`);
      this.openServerConnection(this._pendingHello);
    }, ClientConnection.HELLO_RETRY_MS);
  }

  /**
   * The server socket errored or closed. Returns true when this call handled it:
   * the server ended the connection before sending one complete packet, so the
   * game has heard nothing from it and the same HELLO can be sent again. Returns
   * false for everything else (the server had answered, the game already left, no
   * HELLO), which keeps the normal disconnect path.
   */
  private onServerEnded(socket: net.Socket, reason: string): boolean {
    if (this.closed) return false;
    // A socket this connection has already let go of: its events mean nothing now.
    if (socket !== this.serverSocket) return true;
    if (this._serverPacketReceived || !this._pendingHello) return false;

    const target = `${this.state.conTargetAddress}:${this.state.conTargetPort}`;
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.destroy();
    this.serverSocket = null;
    this.serverConnecting = false;
    this.pendingServerQueue = [];
    // The HELLO timer watches a socket that no longer exists; the retry below replaces it.
    if (this._helloRetryTimer) {
      clearTimeout(this._helloRetryTimer);
      this._helloRetryTimer = null;
    }
    Logger.debug('proxy', 'Client', `[DIAG-silent-end] ${target} ended before its first packet (${reason})`);

    if (this._silentRetryCount >= ClientConnection.SILENT_MAX_RETRIES) {
      this.sendFullServerFailure(target);
      return true;
    }

    this._silentRetryCount++;
    const attempt = this._silentRetryCount;
    const max = ClientConnection.SILENT_MAX_RETRIES;
    Logger.warn('Client', `server ${target} ended the connection before answering (attempt ${attempt}/${max})`);
    this._silentRetryTimer = setTimeout(() => {
      this._silentRetryTimer = null;
      if (this.closed || !this._pendingHello) return;
      Logger.log('Client', `Retrying ${target} with the game's HELLO (attempt ${attempt}/${max})`);
      this.openServerConnection(this._pendingHello);
    }, ClientConnection.SILENT_RETRY_MS);
    return true;
  }

  /**
   * Every retry ended silently: give the game the server's own full-server FAILURE
   * so its built-in retry takes over, then close the game's socket gracefully. A
   * reset here could make Windows discard the FAILURE before the game reads it.
   */
  private sendFullServerFailure(target: string): void {
    this._pendingHello = null;
    const packet = this.proxy.packetFactory.createByName('FAILURE');
    packet.data.errorId = ClientConnection.FULL_SERVER_ERROR_ID;
    packet.data.errorMessage = ClientConnection.FULL_SERVER_MESSAGE;
    const bytes = this.proxy.packetFactory.serialize(packet);
    if (bytes.length > 5) {
      this.forwardRaw(bytes, true);
      Logger.warn('Client', `server ${target} ended the connection before answering again; sent the game a synthesized full-server FAILURE (errorId ${ClientConnection.FULL_SERVER_ERROR_ID}, "${ClientConnection.FULL_SERVER_MESSAGE}") after ${ClientConnection.SILENT_MAX_RETRIES} silent attempts`);
    } else {
      Logger.error('Client', `server ${target} ended the connection before answering again, and the full-server FAILURE could not be built; closing the game connection`);
    }
    // The client socket's 'close' listener disposes once the game closes its side.
    this.clientSocket.end();
    this._closeAfterFailureTimer = setTimeout(() => {
      this._closeAfterFailureTimer = null;
      this.dispose();
    }, ClientConnection.CLOSE_AFTER_FAILURE_MS);
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
    if (this._silentRetryTimer) {
      clearTimeout(this._silentRetryTimer);
      this._silentRetryTimer = null;
    }
    if (this._closeAfterFailureTimer) {
      clearTimeout(this._closeAfterFailureTimer);
      this._closeAfterFailureTimer = null;
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

        // From here on the server has answered: ending the connection is a normal
        // disconnect, never a silent end to retry.
        if (!isClient) this._serverPacketReceived = true;

        // Decrypt the body (skip 5-byte header)
        cipher.cipher(rawPacket);

        // Parse the packet with the layout of the direction it travelled: some ids
        // carry a different packet each way (215 and 217 on game 86ad651b).
        const packet = this.proxy.packetFactory.createFromBytes(rawPacket, isClient ? 'client' : 'server');

        // Log any server FAILURE packet so rejection reasons are visible.
        //
        // The isDefined gate used to sit on this branch, which meant a FAILURE we
        // could not parse logged NOTHING — and an unparseable FAILURE is exactly
        // the interesting case, because it is what a stale packet definition
        // produces. Observed symptom: repeated kicks logging errorMessage="" with
        // errorId=0, i.e. the server was telling us why and we discarded it. Dump
        // the raw body when parsing fails so the reason is recoverable.
        if (!isClient && packet.name === 'FAILURE') {
          if (packet.isDefined) {
            Logger.warn('Client', `[DIAG-FAILURE] errorId=${packet.data.errorId} errorMessage="${packet.data.errorMessage}"`);
          } else {
            const body = rawPacket.subarray(5);
            const hex = body.subarray(0, 64).toString('hex');
            const ascii = body.subarray(0, 64).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
            Logger.warn('Client', `[DIAG-FAILURE] UNPARSEABLE len=${body.length} hex=${hex} ascii="${ascii}"`);
          }
        }

        // The game's server queue (QUEUE_INFORMATION, defined as QUEUEMESSAGE).
        if (!isClient && packet.name === 'QUEUEMESSAGE') {
          Logger.log('Client', `QUEUE_INFORMATION ${describeFields(packet, rawPacket)}`);
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

    // A server error before the server's first packet (ETIMEDOUT, ECONNREFUSED,
    // a reset...) never reaches here: onServerEnded retries it.

    Logger.error('Client', `${source} socket error`, err);
    this.dispose();
  }
}
