import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import {
  PacketIO,
  DEFAULT_PACKET_REGISTRY,
  HelloPacket,
  PongPacket,
  type Packet,
  MapInfoPacket,
  ReconnectPacket,
  FailurePacket,
  NewTickPacket,
  UpdatePacket,
  MovePacket,
  LoadPacket,
  CreatePacket,
  CreateSuccessPacket,
  ChangeAllyShootPacket,
  UpdateAckPacket,
  GotoAckPacket,
  ShootAckPacket,
  UsePortalPacket,
  MoveRecord,
  WorldPosData,
  GotoPacket,
  type ObjectData,
  type ObjectStatusData,
  type StatData,
  TradeRequestedPacket,
  TradeStartPacket,
  TradeChangedPacket,
  TradeAcceptedPacket,
  TradeDonePacket,
  VaultContentPacket,
  InvResultPacket,
  EscapePacket,
  RequestTradePacket,
  ChangeTradePacket,
  AcceptTradePacket,
  CancelTradePacket,
  InvSwapPacket,
  SlotObjectData,
} from '@re-headless/protocol';
import { Logger, LogLevel } from '../services/logger.js';
import type { LibraryManager } from './library-manager.js';
import { WIZARD_CLASS_ID, isPlayerObjectType } from './rotmg-class-ids.js';
import { StatType } from './rotmg-stat-types.js';

const NEXUS_VAULT_PORTAL_TYPE = 1824;

const MOVE_MINSPEED = 0.004;
const MAX_MOVE_SPEED = 0.0096;
const VAULT_PORTAL_USE_MAX_DIST = 0.25;
const VAULT_PORTAL_USE_DWELL_MS = 200;
const FRAME_INTERVAL_MS = 100;
const NEARBY_OBJECT_RADIUS_TILES = 20;
const NEARBY_OBJECT_MAX_SHOWN = 200;

export type NearbyObjectEntry = {
  objectId: number;
  objectType: number;
  distance: number;
};

type TrackedEntity = { objectType: number; x: number; y: number };

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cloneWorldPos(p: { x: number; y: number }): WorldPosData {
  const w = new WorldPosData();
  w.x = p.x;
  w.y = p.y;
  return w;
}

export type ClientConfig = {
  alias: string;
  host: string;
  port?: number;
  buildVersion: string;
  accessToken: string;
  clientToken: string;
  gameId: number;
  keyTime: number;
  key: Buffer;
  charId?: number;
  needsNewChar?: boolean;
  libraryManager?: LibraryManager;
  autoEnterVault?: boolean;
  serverLabel?: string;
  onDisconnected?: (client: Client) => void;
  /**
   * Options used when `needsNewChar` is true and a CREATE packet must be sent.
   * Matches pyrelay CreatePacket fields exactly.
   */
  createChar?: {
    classType?: number;
    skinType?: number;
    isChallenger?: boolean;
    isSeasonal?: boolean;
    isBonus?: boolean;
  };
};

export type InventoryStripJson = {
  hasBackpack: boolean;
  /** Wire stat 130: 0 / 8 / 16 — see `legacyHasBackpack75` parity in mergePlayerStats. */
  backpackTier: number;
  hasBackpackExtender: boolean;
  equipped: [number, number, number, number];
  mainStorage8: number[];
  main12: number[];
  backpack16: number[];
  quickSlots3: [number, number, number];
};

// ── Typed event map ───────────────────────────────────────────────────────────

export interface ClientEvents {
  mapChanged: [mapName: string];
  tradeRequested: [partnerName: string];
  tradeStart: [packet: TradeStartPacket];
  tradeChanged: [offer: boolean[]];
  tradeAccepted: [clientOffer: boolean[], partnerOffer: boolean[]];
  tradeDone: [code: number, description: string];
  vaultContent: [packet: VaultContentPacket];
  invResult: [packet: InvResultPacket];
  inventoryUpdated: [];
  disconnected: [];
}

export class Client extends EventEmitter {
  readonly alias: string;
  readonly serverLabel: string | null;

  private _host: string;
  private _port: number;
  private _gameId: number;
  private _keyTime: number;
  private _key: Buffer;
  private isReconnecting = false;

  get host(): string { return this._host; }
  get port(): number { return this._port; }

  private socket: Socket | undefined;
  private io: PacketIO | undefined;
  private connectedTimeMs = 0;
  private lastFrameTime = 0;
  private _pos: WorldPosData | undefined;
  private _objectId = -1;
  private _playerClassType = -1;
  /** charId used in the LOAD packet; set from cfg.charId at connect time. */
  private _activeCharId = -1;

  private vaultPortal: ObjectData | undefined;
  private enterVaultWanted = false;
  private vaultPortalUseDwellStartMs: number | null = null;
  private _walkTarget: { x: number; y: number } | undefined;

  private moveRecords: MoveRecord[] = [];
  private frameTimer: ReturnType<typeof setInterval> | undefined;
  private mapInfoDisplayName = '';
  private mapInfoName = '';
  private invMain: number[] = Array(12).fill(-1);
  private invBackpack: number[] = Array(16).fill(-1);
  private invQuick: number[] = Array(3).fill(-1);
  private hasBackpackFlag = false;
  private backpackTier = 0;
  private legacyHasBackpack75 = false;
  private nameFromStats = '';
  private playerSpeed = 25;
  private lastServerFailure: string | null = null;
  private lastSocketMessage: string | null = null;
  private didNotifyDisconnect = false;
  private entityById = new Map<number, TrackedEntity>();

  // ── Vault state ───────────────────────────────────────────────────────────
  private _vaultChestObjectId = -1;
  private _vaultContents: number[] = [];

  // Toggle to log every non-routine incoming packet (set true while a trade is in progress)
  tradeDebugLogging = false;

  get vaultChestObjectId(): number { return this._vaultChestObjectId; }
  get vaultContents(): number[] { return [...this._vaultContents]; }

  getEntityPosition(objectId: number): { x: number; y: number } | undefined {
    const e = this.entityById.get(objectId);
    return e ? { x: e.x, y: e.y } : undefined;
  }

  setWalkTarget(pos: { x: number; y: number } | undefined): void {
    this._walkTarget = pos ? { x: pos.x, y: pos.y } : undefined;
  }

  // ── Public accessors ──────────────────────────────────────────────────────
  get playerObjectId(): number { return this._objectId; }
  get position(): WorldPosData | undefined { return this._pos; }
  /** ObjectType/classType of the character currently loaded (from UPDATE newObjs). -1 until received. */
  get playerClassType(): number { return this._playerClassType; }
  /** charId sent in the most recent LOAD packet. */
  get activeCharId(): number { return this._activeCharId; }

  constructor(readonly cfg: ClientConfig) {
    super();
    this.alias = cfg.alias;
    this._host = cfg.host;
    this._port = cfg.port ?? 2050;
    this._gameId = cfg.gameId;
    this._keyTime = cfg.keyTime;
    this._key = cfg.key;
    const raw = cfg.serverLabel?.trim();
    this.serverLabel = raw && raw.length > 0 ? raw : null;
    this.cfg.libraryManager?.attachClient(this);
  }

  get time(): number {
    return Date.now() - this.connectedTimeMs;
  }

  get characterName(): string | null {
    const t = this.nameFromStats.trim();
    return t.length > 0 ? t : null;
  }

  get lastDisconnectSummary(): string {
    const parts: string[] = [];
    if (this.lastServerFailure) parts.push(this.lastServerFailure);
    if (this.lastSocketMessage) parts.push(this.lastSocketMessage);
    let s = parts.join(' · ');
    if (this.lastSocketMessage?.includes('ECONNRESET') || this.lastSocketMessage?.includes('EPIPE')) {
      s += ' — The game server closed the connection.';
    }
    return s || 'Disconnected';
  }

  get currentMapLabel(): string | null {
    const n = this.mapInfoName.trim();
    if (n) return n;
    const d = this.mapInfoDisplayName.trim();
    if (d) return d;
    if (this._objectId >= 0) return 'In realm (no MAPINFO string yet)';
    return null;
  }

  get nearbyObjectEntries(): NearbyObjectEntry[] {
    if (this._objectId < 0 || this._pos == null) return [];
    const px = this._pos.x;
    const py = this._pos.y;
    const out: NearbyObjectEntry[] = [];
    for (const [id, e] of this.entityById) {
      if (id === this._objectId) continue;
      const d = dist2({ x: px, y: py }, { x: e.x, y: e.y });
      if (d > NEARBY_OBJECT_RADIUS_TILES) continue;
      out.push({ objectId: id, objectType: e.objectType, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, NEARBY_OBJECT_MAX_SHOWN);
  }

  get nearbyObjectRadiusTiles(): number { return NEARBY_OBJECT_RADIUS_TILES; }

  get inventoryStrip(): InventoryStripJson {
    return {
      hasBackpack: this.hasBackpackFlag,
      backpackTier: this.backpackTier,
      hasBackpackExtender: this.backpackTier >= 16,
      equipped: [this.invMain[0]!, this.invMain[1]!, this.invMain[2]!, this.invMain[3]!],
      mainStorage8: this.invMain.slice(4, 12),
      main12: [...this.invMain],
      backpack16: [...this.invBackpack],
      quickSlots3: [this.invQuick[0]!, this.invQuick[1]!, this.invQuick[2]!]
    };
  }

  enterVault(): void {
    this.enterVaultWanted = true;
    this.vaultPortalUseDwellStartMs = null;
    Logger.log(this.alias, 'Enter vault: walk to portal 1824', LogLevel.Info);
  }

  cancelAutoVaultEntry(): void {
    this.cfg.autoEnterVault = false;
    this.enterVaultWanted = false;
    this.vaultPortalUseDwellStartMs = null;
    this.vaultPortal = undefined;
  }

  // ── Send helpers ──────────────────────────────────────────────────────────

  sendEscape(): void {
    this.send(new EscapePacket());
    Logger.log(this.alias, 'ESCAPE → nexus', LogLevel.Info);
  }

  sendRequestTrade(playerName: string): void {
    const pkt = new RequestTradePacket();
    pkt.name = playerName;
    this.send(pkt);
    Logger.log(this.alias, `REQUESTTRADE → ${playerName}`, LogLevel.Info);
  }

  sendChangeTrade(offer: boolean[]): void {
    const pkt = new ChangeTradePacket();
    pkt.offer = offer;
    this.send(pkt);
    const trueIdx = offer.map((v, i) => v ? i : null).filter(v => v !== null);
    Logger.log(this.alias, `CHANGETRADE offer=[${trueIdx.join(',')}] len=${offer.length} bits=${offer.map(b => b ? '1' : '0').join('')}`, LogLevel.Info);
  }

  sendAcceptTrade(clientOffer: boolean[], partnerOffer: boolean[]): void {
    const pkt = new AcceptTradePacket();
    pkt.clientOffer = clientOffer;
    pkt.partnerOffer = partnerOffer;
    this.send(pkt);
    const cTrue = clientOffer.map((v, i) => v ? i : null).filter(v => v !== null);
    const pTrue = partnerOffer.map((v, i) => v ? i : null).filter(v => v !== null);
    Logger.log(
      this.alias,
      `ACCEPTTRADE clientOffer=[${cTrue.join(',')}] (len=${clientOffer.length} bits=${clientOffer.map(b => b ? '1' : '0').join('')}) partnerOffer=[${pTrue.join(',')}] (len=${partnerOffer.length} bits=${partnerOffer.map(b => b ? '1' : '0').join('')})`,
      LogLevel.Info,
    );
  }

  sendCancelTrade(): void {
    this.send(new CancelTradePacket());
    Logger.log(this.alias, 'CANCELTRADE', LogLevel.Info);
  }

  /**
   * Send INVSWAP. slot1 = source, slot2 = destination.
   * objectId = entity owning the slot (player objectId or vault chest objectId).
   * slotId = slot index. objectType = item type currently in that slot (-1 if empty).
   */
  sendInvSwap(
    slot1: { objectId: number; slotId: number; objectType: number },
    slot2: { objectId: number; slotId: number; objectType: number },
  ): void {
    if (!this._pos) return;
    const pkt = new InvSwapPacket();
    pkt.time = this.time;
    pkt.playerPos = cloneWorldPos(this._pos);
    pkt.slotObject1 = Object.assign(new SlotObjectData(), slot1);
    pkt.slotObject2 = Object.assign(new SlotObjectData(), slot2);
    this.send(pkt);
    Logger.log(
      this.alias,
      `INVSWAP [oid=${slot1.objectId} s=${slot1.slotId} t=${slot1.objectType}] ↔ [oid=${slot2.objectId} s=${slot2.slotId} t=${slot2.objectType}]`,
      LogLevel.Info
    );
  }

  // ── Core connect/disconnect ───────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.socket) this.disconnect();
    this.entityById.clear();
    this.didNotifyDisconnect = false;
    this.lastServerFailure = null;
    this.lastSocketMessage = null;
    this.mapInfoDisplayName = '';
    this.mapInfoName = '';
    this.nameFromStats = '';
    this.playerSpeed = 25;
    this.vaultPortalUseDwellStartMs = null;
    this.vaultPortal = undefined;
    this.enterVaultWanted = false;
    this._walkTarget = undefined;
    this._objectId = -1;
    this._playerClassType = -1;
    this._activeCharId = this.cfg.charId ?? -1;
    this._pos = undefined;
    this._vaultChestObjectId = -1;
    this._vaultContents = [];
    this.resetInventoryStrip();
    this.connectedTimeMs = Date.now();
    this.lastFrameTime = this.time;

    Logger.log(this.alias, `Connecting to ${this._host}:${this._port}`, LogLevel.Info);
    const socket = new Socket();
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(this._port, this._host, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });

    socket.on('close', (hadError) => {
      if (this.socket !== socket) return;
      this.lastSocketMessage = this.lastSocketMessage ?? (hadError ? 'socket closed (with error flag)' : 'server closed (TCP FIN)');
      Logger.log(this.alias, `Socket close hadError=${hadError}`, LogLevel.Info);
      this.disconnect();
    });

    const io = new PacketIO({ socket, registry: DEFAULT_PACKET_REGISTRY });
    this.io = io;
    io.on('packet', (p: Packet) => this.onPacket(p));
    io.on('packetSent', ({ type, id, payload }) => {
      Logger.log(
        this.alias,
        `OUT ${String(type)} id=${id} payloadBytes=${payload.length} hex=${payload.toString('hex')}`,
        LogLevel.Debug
      );
    });
    io.on('packetRaw', ({ type, id, payload }) => {
      if (type === 'FAILURE') {
        Logger.log(this.alias, `FAILURE raw id=${id} bytes=${payload.length} hex=${payload.toString('hex').slice(0, 120)}`, LogLevel.Error);
      }
      // Log every trade-related packet so we can see if anything beyond what we
      // already handle is arriving (e.g. CANCELTRADE, an unmapped variant, etc.)
      if (typeof type === 'string' && type.startsWith('TRADE')) {
        Logger.log(this.alias, `RAW IN ${type} id=${id} bytes=${payload.length} hex=${payload.toString('hex').slice(0, 200)}`, LogLevel.Info);
      }
      // Trade-window debugging: log any unknown packet (UNKNOWN_*) so we don't miss server messages
      if (typeof type === 'string' && type.startsWith('UNKNOWN_')) {
        Logger.log(this.alias, `RAW IN ${type} id=${id} bytes=${payload.length} hex=${payload.toString('hex').slice(0, 200)}`, LogLevel.Info);
      }
      // Trade debug mode: log everything except high-frequency game-loop packets so we
      // can see if the server sends anything we're not parsing during a trade.
      if (this.tradeDebugLogging && typeof type === 'string') {
        const skip = type === 'UPDATE' || type === 'NEWTICK' || type === 'GOTO'
          || type === 'ENEMYSHOOT' || type === 'SERVERPLAYERSHOOT' || type === 'PING'
          || type === 'NOTIFICATION' || type === 'TEXT';
        if (!skip && !type.startsWith('TRADE') && !type.startsWith('UNKNOWN_')) {
          Logger.log(this.alias, `RAW IN [tradeDbg] ${type} id=${id} bytes=${payload.length} hex=${payload.toString('hex').slice(0, 200)}`, LogLevel.Info);
        }
      }
    });
    io.on('socketError', (err) => {
      if (this.io !== io) return;
      const e = err as Error & { code?: string };
      this.lastSocketMessage = e.code ? `${e.code}: ${e.message}` : String(e);
      Logger.log(this.alias, `Socket error: ${this.lastSocketMessage}`, LogLevel.Error);
      this.disconnect();
    });

    this.sendHello();
  }

  disconnect(): void {
    if (!this.io && !this.socket) return;
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = undefined;
    }
    if (this.io) this.io.detach();
    this.io = undefined;
    if (this.socket) {
      try { this.socket.end(); } catch { /* ignore */ }
      try { this.socket.destroy(); } catch { /* ignore */ }
    }
    this.socket = undefined;
    this.mapInfoDisplayName = '';
    this.mapInfoName = '';
    this.nameFromStats = '';
    this.playerSpeed = 25;
    this._vaultChestObjectId = -1;
    this._vaultContents = [];
    this.resetInventoryStrip();
    this.finishDisconnectNotify();
  }

  private finishDisconnectNotify(): void {
    if (this.didNotifyDisconnect) return;
    if (this.isReconnecting) return;
    this.didNotifyDisconnect = true;
    this.cfg.onDisconnected?.(this);
    this.emit('disconnected');
  }

  private resetInventoryStrip(): void {
    this.invMain = Array(12).fill(-1) as number[];
    this.invBackpack = Array(16).fill(-1) as number[];
    this.invQuick = Array(3).fill(-1) as number[];
    this.hasBackpackFlag = false;
    this.backpackTier = 0;
    this.legacyHasBackpack75 = false;
  }

  private mergePlayerStats(stats: StatData[]): void {
    for (const s of stats) {
      if (s.statTypeNum === StatType.Name && s.stringStatValue !== undefined) {
        const n = s.stringStatValue.trim();
        if (n) this.nameFromStats = n;
      }
    }

    let tier = this.backpackTier;
    let legacyBp = this.legacyHasBackpack75;
    for (const s of stats) {
      if (s.stringStatValue !== undefined) continue;
      if (s.statTypeNum === StatType.HasBackpack) {
        legacyBp = s.statValue !== 0;
      }
      if (s.statTypeNum === StatType.BackpackTier) {
        tier = s.statValue;
      }
    }
    this.backpackTier = tier;
    this.legacyHasBackpack75 = legacyBp;
    const hasBp = tier !== 0 || legacyBp;
    this.hasBackpackFlag = hasBp;
    if (!hasBp) this.invBackpack.fill(-1);

    let inventoryChanged = false;
    for (const s of stats) {
      if (s.stringStatValue !== undefined) continue;
      const t = s.statTypeNum;
      const v = s.statValue;
      if (t === StatType.Speed) {
        this.playerSpeed = Math.max(0, v);
      } else if (t >= StatType.Inventory0 && t <= StatType.Inventory11) {
        this.invMain[t - StatType.Inventory0] = v;
        inventoryChanged = true;
      } else if (hasBp && t >= StatType.Backpack0 && t <= StatType.Backpack15) {
        this.invBackpack[t - StatType.Backpack0] = v;
        inventoryChanged = true;
      } else if (t === StatType.QuickSlot0) {
        this.invQuick[0] = v;
      } else if (t === StatType.QuickSlot1) {
        this.invQuick[1] = v;
      } else if (t === StatType.QuickSlot2) {
        this.invQuick[2] = v;
      }
    }
    if (inventoryChanged) this.emit('inventoryUpdated');
  }

  send(packet: Packet): void {
    if (!this.io) return;
    this.io.send(packet);
  }

  private getStepDistance(timeElapsed: number): number {
    const spd = this.playerSpeed;
    const perMs = MOVE_MINSPEED + (spd / 75) * (MAX_MOVE_SPEED - MOVE_MINSPEED);
    return perMs * timeElapsed;
  }

  private ensureFrameLoop(): void {
    if (this.frameTimer) return;
    this.lastFrameTime = this.time;
    this.frameTimer = setInterval(() => this.onFrameTick(), FRAME_INTERVAL_MS);
  }

  private onFrameTick(): void {
    if (!this.io || this._pos == null) return;
    const t = this.time;
    const diff = Math.min(FRAME_INTERVAL_MS, t - this.lastFrameTime);
    this.lastFrameTime = t;

    if (this.enterVaultWanted && this.vaultPortal) {
      const target = this.vaultPortal.status.pos;
      const d = dist2(this._pos, target);
      if (d < VAULT_PORTAL_USE_MAX_DIST) {
        if (this.vaultPortalUseDwellStartMs == null) {
          this.vaultPortalUseDwellStartMs = t;
          Logger.log(this.alias, `Vault: dist ${d.toFixed(4)} < ${VAULT_PORTAL_USE_MAX_DIST}; waiting ${VAULT_PORTAL_USE_DWELL_MS}ms`, LogLevel.Info);
        }
        const dwelled = t - this.vaultPortalUseDwellStartMs;
        if (dwelled >= VAULT_PORTAL_USE_DWELL_MS) {
          const pkt = new UsePortalPacket();
          pkt.objectId = this.vaultPortal.status.objectId;
          this.send(pkt);
          Logger.log(this.alias, `USEPORTAL objectId=${pkt.objectId} dist=${d.toFixed(4)}`, LogLevel.Info);
          this.enterVaultWanted = false;
          this.vaultPortalUseDwellStartMs = null;
        }
      } else {
        this.vaultPortalUseDwellStartMs = null;
        const step = this.getStepDistance(Math.max(1, diff));
        const walk = Math.min(step, d);
        if (walk > 1e-6) {
          const ang = Math.atan2(target.y - this._pos.y, target.x - this._pos.x);
          this._pos.x += Math.cos(ang) * walk;
          this._pos.y += Math.sin(ang) * walk;
        }
      }
    } else if (this._walkTarget) {
      const target = this._walkTarget;
      const d = dist2(this._pos, target);
      if (d > 1e-4) {
        const step = this.getStepDistance(Math.max(1, diff));
        const walk = Math.min(step, d);
        const ang = Math.atan2(target.y - this._pos.y, target.x - this._pos.x);
        this._pos.x += Math.cos(ang) * walk;
        this._pos.y += Math.sin(ang) * walk;
      }
    }

    const rec = new MoveRecord();
    rec.time = t;
    rec.pos = cloneWorldPos(this._pos);
    this.moveRecords.push(rec);
  }

  private autoEnterVaultDefault(): boolean {
    return this.cfg.autoEnterVault !== false;
  }

  private clearEntityTracking(): void {
    this.entityById.clear();
  }

  private ingestNewObjectEntitiesFromUpdate(objs: ObjectData[]): void {
    for (const obj of objs) {
      const id = obj.status.objectId;
      this.entityById.set(id, {
        objectType: obj.objectType,
        x: obj.status.pos.x,
        y: obj.status.pos.y
      });
    }
  }

  private applyNewTickEntityPositions(status: ObjectStatusData[]): void {
    for (const st of status) {
      const e = this.entityById.get(st.objectId);
      if (e) {
        e.x = st.pos.x;
        e.y = st.pos.y;
      }
    }
  }

  private sendHello(): void {
    const pkt = new HelloPacket();
    pkt.buildVersion = this.cfg.buildVersion;
    pkt.gameId = this._gameId;
    pkt.accessToken = this.cfg.accessToken;
    pkt.keyTime = this._keyTime;
    pkt.key = this._key;
    pkt.userPlatform = 'rotmg';
    pkt.playPlatform = 'rotmg';
    pkt.platformToken = '';
    pkt.userToken = this.cfg.clientToken;
    this.send(pkt);
  }

  private async doReconnect(r: ReconnectPacket): Promise<void> {
    const newHost = r.host && r.host.length > 0 ? r.host : this._host;
    const newPort = r.port > 0 ? r.port : this._port;
    this._host = newHost;
    this._port = newPort;
    this._gameId = r.gameId;
    this._keyTime = r.keyTime;
    this._key = r.key;
    Logger.log(this.alias, `RECONNECT → ${newHost}:${newPort} gameId=${r.gameId} keyLen=${r.key.length}`, LogLevel.Info);
    this.isReconnecting = true;
    try {
      await this.connect();
    } finally {
      this.isReconnecting = false;
    }
  }

  private assignPlayerAndPortalFromUpdate(up: UpdatePacket): void {
    for (const obj of up.newObjs) {
      if (obj.objectType === NEXUS_VAULT_PORTAL_TYPE) {
        this.vaultPortal = obj;
        Logger.log(this.alias, `Vault portal objectId=${obj.status.objectId} at ${obj.status.pos.x.toFixed(2)},${obj.status.pos.y.toFixed(2)}`, LogLevel.Info);
        if (this.autoEnterVaultDefault() && this._objectId >= 0) {
          this.enterVaultWanted = true;
          Logger.log(this.alias, 'autoEnterVault: walk to portal', LogLevel.Info);
        }
      }
    }

    if (this._objectId >= 0) {
      for (const obj of up.newObjs) {
        if (!isPlayerObjectType(obj.objectType)) continue;
        if (obj.status.objectId === this._objectId) {
          this._pos = cloneWorldPos(obj.status.pos);
          this.mergePlayerStats(obj.status.stats);
          break;
        }
      }
    } else {
      let best: ObjectData | undefined;
      let bestD = 1e9;
      for (const obj of up.newObjs) {
        if (!isPlayerObjectType(obj.objectType)) continue;
        const d2 = dist2(obj.status.pos, up.pos);
        if (d2 < bestD) { bestD = d2; best = obj; }
      }
      if (best) {
        this._objectId = best.status.objectId;
        this._playerClassType = best.objectType;
        this._activeCharId = this.cfg.charId ?? -1;
        this._pos = cloneWorldPos(best.status.pos);
        this.mergePlayerStats(best.status.stats);
        Logger.log(this.alias, `Player objectId=${this._objectId} classType=${best.objectType} (d=${bestD.toFixed(2)})`, LogLevel.Info);
        if (this.vaultPortal && this.autoEnterVaultDefault()) {
          this.enterVaultWanted = true;
        }
      }
    }
  }

  // ── Packet dispatch ───────────────────────────────────────────────────────

  private onPacket(packet: Packet): void {
    this.cfg.libraryManager?.dispatchPacket(this, packet);

    switch (packet.type) {
      case 'PING': {
        const pong = new PongPacket();
        // @ts-expect-error: PingPacket is in registry but PacketIO emits Packet
        pong.serial = packet.serial;
        pong.time = this.time;
        this.send(pong);
        return;
      }
      case 'FAILURE': {
        const f = packet as FailurePacket;
        this.lastServerFailure = `Server FAILURE ${f.errorId}: ${f.errorDescription || '(no description)'}`;
        Logger.log(this.alias, `Failure ${f.errorId}: ${f.errorDescription}`, LogLevel.Error);
        return;
      }
      case 'UPDATE': {
        const up = packet as UpdatePacket;
        this.send(new UpdateAckPacket());
        if (!this._pos) this._pos = cloneWorldPos(up.pos);
        this.assignPlayerAndPortalFromUpdate(up);
        this.ingestNewObjectEntitiesFromUpdate(up.newObjs);
        if (this._pos && this._objectId >= 0) this.ensureFrameLoop();
        return;
      }
      case 'GOTO': {
        const g = packet as GotoPacket;
        const ack = new GotoAckPacket();
        ack.time = Math.trunc(this.lastFrameTime || this.time);
        ack.reset = false;
        this.send(ack);
        if (g.objectId === this._objectId) this._pos = cloneWorldPos(g.position);
        return;
      }
      case 'SERVERPLAYERSHOOT':
      case 'ENEMYSHOOT': {
        const ack = new ShootAckPacket();
        ack.time = this.lastFrameTime || this.time;
        ack.ack = 0;
        this.send(ack);
        return;
      }
      case 'RECONNECT': {
        const r = packet as ReconnectPacket;
        Logger.log(this.alias, `RECONNECT: name=${r.name || '(none)'} host=${r.host || '(same)'} port=${r.port} gameId=${r.gameId} keyLen=${r.key.length}`, LogLevel.Info);
        void this.doReconnect(r);
        return;
      }
      case 'MAPINFO': {
        const mi = packet as MapInfoPacket;
        this.mapInfoName = mi.name ?? '';
        this.mapInfoDisplayName = mi.displayName ?? '';
        Logger.log(this.alias, `MapInfo: name=${mi.name} displayName=${mi.displayName?.slice(0, 60) ?? ''}`, LogLevel.Info);
        this.resetInventoryStrip();
        this.vaultPortal = undefined;
        this.enterVaultWanted = false;
        this.vaultPortalUseDwellStartMs = null;
        this._vaultChestObjectId = -1;
        this._vaultContents = [];
        this.clearEntityTracking();
        this.emit('mapChanged', mi.name ?? '');

        if (this.cfg.needsNewChar) {
          const cc = this.cfg.createChar ?? {};
          const create = new CreatePacket();
          create.classType = cc.classType ?? WIZARD_CLASS_ID;
          create.skinType = cc.skinType ?? 0;
          create.isChallenger = cc.isChallenger ?? false;
          create.isSeasonal = cc.isSeasonal ?? false;
          create.isBonus = cc.isBonus ?? false;
          Logger.log(
            this.alias,
            `Sending CREATE classType=${create.classType} isSeasonal=${create.isSeasonal} isBonus=${create.isBonus}`,
            LogLevel.Debug
          );
          this.send(create);
          return;
        }
        if (this.cfg.charId !== undefined) {
          const load = new LoadPacket();
          load.charId = Number(this.cfg.charId);
          this.send(load);
        }
        return;
      }
      case 'CREATE_SUCCESS': {
        const cs = packet as CreateSuccessPacket;
        this._objectId = cs.objectId;
        this.lastFrameTime = this.time;
        const ally = new ChangeAllyShootPacket();
        ally.toggle = 1;
        this.send(ally);
        this.ensureFrameLoop();
        return;
      }
      case 'NEWTICK': {
        const nt = packet as NewTickPacket;
        let tickStats: StatData[] | undefined;
        for (const st of nt.status) {
          if (st.objectId === this._objectId) { tickStats = st.stats; break; }
        }
        const mv = new MovePacket();
        mv.tickId = nt.tickId;
        mv.time = Number(nt.serverRealTimeMS);
        if (this.moveRecords.length > 0) {
          mv.records = this.moveRecords;
        } else {
          const p = this._pos ? cloneWorldPos(this._pos) : new WorldPosData();
          const rec = new MoveRecord();
          rec.time = this.lastFrameTime || this.time;
          rec.pos = p;
          mv.records = [rec];
        }
        this.moveRecords = [];
        this.send(mv);
        this.applyNewTickEntityPositions(nt.status);
        if (tickStats) this.mergePlayerStats(tickStats);
        return;
      }

      // ── Trade packets ──────────────────────────────────────────────────
      case 'TRADEREQUESTED': {
        const p = packet as TradeRequestedPacket;
        Logger.log(this.alias, `TRADEREQUESTED from ${p.name}`, LogLevel.Info);
        this.emit('tradeRequested', p.name);
        return;
      }
      case 'TRADESTART': {
        const p = packet as TradeStartPacket;
        const fmtItems = (items: typeof p.clientItems) =>
          items.map((it, i) => `${i}:{id=${it.item},slotType=${it.slotType},tradeable=${it.tradeable},included=${it.included}}`).join(' | ');
        Logger.log(this.alias, `TRADESTART partner=${p.partnerName} ourSlots=${p.clientItems.length} theirSlots=${p.partnerItems.length}`, LogLevel.Info);
        Logger.log(this.alias, `TRADESTART our items: ${fmtItems(p.clientItems)}`, LogLevel.Info);
        Logger.log(this.alias, `TRADESTART their items: ${fmtItems(p.partnerItems)}`, LogLevel.Info);
        this.emit('tradeStart', p);
        return;
      }
      case 'TRADECHANGED': {
        const p = packet as TradeChangedPacket;
        const trueIdx = p.offer.map((v, i) => v ? i : null).filter(v => v !== null);
        Logger.log(this.alias, `TRADECHANGED offer=[${trueIdx.join(',')}] len=${p.offer.length} bits=${p.offer.map(b => b ? '1' : '0').join('')}`, LogLevel.Info);
        this.emit('tradeChanged', p.offer);
        return;
      }
      case 'TRADEACCEPTED': {
        const p = packet as TradeAcceptedPacket;
        const cTrue = p.clientOffer.map((v, i) => v ? i : null).filter(v => v !== null);
        const pTrue = p.partnerOffer.map((v, i) => v ? i : null).filter(v => v !== null);
        Logger.log(
          this.alias,
          `TRADEACCEPTED (partner accepted) clientOffer=[${cTrue.join(',')}] (len=${p.clientOffer.length}) partnerOffer=[${pTrue.join(',')}] (len=${p.partnerOffer.length})`,
          LogLevel.Info,
        );
        this.emit('tradeAccepted', p.clientOffer, p.partnerOffer);
        return;
      }
      case 'TRADEDONE': {
        const p = packet as TradeDonePacket;
        Logger.log(this.alias, `TRADEDONE code=${p.code} desc=${p.description}`, LogLevel.Info);
        this.emit('tradeDone', p.code, p.description);
        return;
      }

      // ── Vault packets ──────────────────────────────────────────────────
      case 'VAULT_UPDATE': {
        const p = packet as VaultContentPacket;
        this._vaultChestObjectId = p.vaultChestObjectId;
        this._vaultContents = [...p.vaultContents];
        Logger.log(this.alias, `VAULTCONTENT chestOid=${p.vaultChestObjectId} slots=${p.vaultContents.length} contents=[${p.vaultContents.join(',')}]`, LogLevel.Info);
        this.emit('vaultContent', p);
        return;
      }
      case 'INVRESULT': {
        const p = packet as InvResultPacket;
        Logger.log(this.alias, `INVRESULT from=[oid=${p.fromSlot.objectId} s=${p.fromSlot.slotId} t=${p.fromSlot.objectType}] to=[oid=${p.toSlot.objectId} s=${p.toSlot.slotId} t=${p.toSlot.objectType}]`, LogLevel.Info);
        // Patch vault contents if the chest was involved
        const fromOid = p.fromSlot.objectId;
        const toOid = p.toSlot.objectId;
        // INVRESULT objectType = new content of that slot after the swap
        if (fromOid === this._vaultChestObjectId) {
          const s = p.fromSlot.slotId;
          if (s >= 0 && s < this._vaultContents.length) this._vaultContents[s] = p.fromSlot.objectType;
        }
        if (toOid === this._vaultChestObjectId) {
          const s = p.toSlot.slotId;
          while (this._vaultContents.length <= s) this._vaultContents.push(-1);
          this._vaultContents[s] = p.toSlot.objectType;
        }
        this.emit('invResult', p);
        return;
      }

      case 'TEXT': {
        const t = packet as unknown as {
          name?: string; objectId?: number; numStars?: number;
          recipient?: string; text?: string; cleanText?: string;
        };
        Logger.log(
          this.alias,
          `TEXT name="${t.name ?? ''}" objectId=${t.objectId ?? -1} stars=${t.numStars ?? 0} recipient="${t.recipient ?? ''}" text="${t.text ?? ''}" cleanText="${t.cleanText ?? ''}"`,
          LogLevel.Info,
        );
        return;
      }
      case 'NOTIFICATION': {
        const n = packet as unknown as {
          typeValue?: number; textByte?: number; raw?: Buffer; decodedText?: string;
        };
        const rawHex = n.raw ? n.raw.toString('hex').slice(0, 200) : '';
        Logger.log(
          this.alias,
          `NOTIFICATION typeValue=${n.typeValue ?? -1} textByte=${n.textByte ?? -1} decodedText="${n.decodedText ?? ''}" rawLen=${n.raw?.length ?? 0} rawHex=${rawHex}`,
          LogLevel.Info,
        );
        return;
      }
      case 'GLOBAL_NOTIFICATION': {
        const raw = (packet as unknown as { raw?: Buffer }).raw;
        const hex = raw ? raw.toString('hex').slice(0, 200) : '';
        const asText = raw ? raw.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '.') : '';
        Logger.log(
          this.alias,
          `GLOBAL_NOTIFICATION rawLen=${raw?.length ?? 0} rawHex=${hex} rawAsText="${asText.slice(0, 200)}"`,
          LogLevel.Info,
        );
        return;
      }

      default:
        return;
    }
  }

  // ── EventEmitter typed overloads ──────────────────────────────────────────

  emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}
