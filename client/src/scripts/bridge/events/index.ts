import { chat, events } from '@realmengine/sdk';
import type {
  CharacterFameThresholdEvent,
  ChatHandler,
  PlayerNearbyEvent,
  PlayerNearbyOptions,
  PlayerNearbyPlayer,
  GuildNearbyEvent,
  GuildNearbyOptions,
  GuildNearbyPlayer,
  GuildNearbyMatchMode,
  PlayerJoinPartyEvent,
  PlayerJoinPartyMatchMode,
} from '@realmengine/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { Packet } from '../../../packets/Packet.js';
import { StatType } from '../../../constants/StatType.js';
import { GAME_PORT } from '../../../constants/GameId.js';
import { normalizeMapDisplayName } from '../../../util/mapDisplayName.js';
import { Logger } from '../../../util/Logger.js';

type AnyHandler = (e: any) => void;

const listeners: Map<string, AnyHandler[]> = new Map();

const lastLevelByClient = new WeakMap<ClientConnection, number>();
const prevInvByClient = new WeakMap<ClientConnection, number[]>();
const lastCharacterFameByClient = new WeakMap<ClientConnection, number>();

type FameWatchHandler = (e: CharacterFameThresholdEvent) => void;
const fameWatches: Array<{ threshold: number; handler: FameWatchHandler }> = [];

const DEFAULT_NEARBY_RADIUS = 12;

type NearbyWatch = {
  names: Set<string>;
  radius: number;
  handler: (e: PlayerNearbyEvent) => void;
  prevByClient: WeakMap<ClientConnection, Set<string>>;
};
const nearbyWatches: NearbyWatch[] = [];

type GuildNearbyWatch = {
  needle: string;
  match: GuildNearbyMatchMode;
  radius: number;
  handler: (e: GuildNearbyEvent) => void;
  prevByClient: WeakMap<ClientConnection, Set<number>>;
};
const guildNearbyWatches: GuildNearbyWatch[] = [];

type JoinPartyWatch = {
  needle: string;
  match: PlayerJoinPartyMatchMode;
  handler: (e: PlayerJoinPartyEvent) => void;
};
const joinPartyWatches: JoinPartyWatch[] = [];

function joinPartyNameMatches(memberName: string, needle: string, match: PlayerJoinPartyMatchMode): boolean {
  const p = memberName.trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  if (match === 'contains') return p.includes(n);
  return p === n;
}

function registerPlayerJoinParty(
  playerName: string,
  matchOrHandler: PlayerJoinPartyMatchMode | ((e: PlayerJoinPartyEvent) => void),
  handler?: (e: PlayerJoinPartyEvent) => void,
): () => void {
  const needle = String(playerName).trim();
  if (!needle) return () => {};

  let match: PlayerJoinPartyMatchMode = 'equals';
  let h: (e: PlayerJoinPartyEvent) => void;

  if (typeof matchOrHandler === 'function') {
    h = matchOrHandler;
  } else {
    match = matchOrHandler;
    if (!handler) return () => {};
    h = handler;
  }

  const entry: JoinPartyWatch = { needle, match, handler: h };
  joinPartyWatches.push(entry);
  return () => {
    const i = joinPartyWatches.indexOf(entry);
    if (i >= 0) joinPartyWatches.splice(i, 1);
  };
}

function dispatchPlayerJoinPartyFromPacket(client: ClientConnection, packet: Packet): void {
  if (!packet.isDefined) return;
  const d = packet.data as { playerId?: number; name?: string; classId?: number };
  const playerIdRaw = Math.trunc(Number(d.playerId));
  if (!Number.isFinite(playerIdRaw) || playerIdRaw < 0 || playerIdRaw > 65535) return;
  const playerName = typeof d.name === 'string' ? d.name : '';
  const selfName = (client.playerData.name || '').trim().toLowerCase();
  if (selfName && playerName.trim().toLowerCase() === selfName) return;
  const playerId = playerIdRaw & 0xffff;
  const classId = Math.trunc(Number(d.classId)) & 0xffff;
  const ev: PlayerJoinPartyEvent = { playerName, playerId, classId };
  for (const w of joinPartyWatches) {
    if (!joinPartyNameMatches(playerName, w.needle, w.match)) continue;
    try {
      w.handler(ev);
    } catch (err) {
      Logger.error('ScriptEvents', 'onPlayerJoinParty handler failed', err as Error);
    }
  }
}

function nameSetFromArg(names: string | readonly string[]): Set<string> {
  const list = typeof names === 'string' ? [names] : [...names];
  const set = new Set<string>();
  for (const n of list) {
    const k = String(n).trim().toLowerCase();
    if (k) set.add(k);
  }
  return set;
}

function registerPlayerNearby(
  names: string | readonly string[],
  handler: (e: PlayerNearbyEvent) => void,
  options?: PlayerNearbyOptions,
): () => void {
  const nameSet = nameSetFromArg(names);
  if (nameSet.size === 0) return () => {};
  const r = Number(options?.radius);
  const radius = Number.isFinite(r) && r > 0 ? r : DEFAULT_NEARBY_RADIUS;
  const entry: NearbyWatch = {
    names: nameSet,
    radius,
    handler,
    prevByClient: new WeakMap(),
  };
  nearbyWatches.push(entry);
  return () => {
    const i = nearbyWatches.indexOf(entry);
    if (i >= 0) nearbyWatches.splice(i, 1);
  };
}

function rowGuildName(row: { rawStats: Record<string, number | string> }): string {
  const v = row.rawStats[String(StatType.GuildName)];
  return String(v ?? '').trim();
}

function guildTagMatches(
  rowGuild: string,
  needle: string,
  match: GuildNearbyMatchMode,
): boolean {
  const g = rowGuild.trim().toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  if (match === 'contains') return g.includes(n);
  return g === n;
}

function registerGuildNearby(
  guildName: string,
  matchOrHandler: GuildNearbyMatchMode | ((e: GuildNearbyEvent) => void),
  handlerOrOptions?: ((e: GuildNearbyEvent) => void) | GuildNearbyOptions,
  maybeOptions?: GuildNearbyOptions,
): () => void {
  const needle = String(guildName).trim();
  if (!needle) return () => {};

  let match: GuildNearbyMatchMode = 'equals';
  let handler: (e: GuildNearbyEvent) => void;
  let options: GuildNearbyOptions | undefined;

  if (typeof matchOrHandler === 'function') {
    handler = matchOrHandler;
    options = handlerOrOptions as GuildNearbyOptions | undefined;
  } else {
    match = matchOrHandler;
    handler = handlerOrOptions as (e: GuildNearbyEvent) => void;
    options = maybeOptions;
  }

  const r = Number(options?.radius);
  const radius = Number.isFinite(r) && r > 0 ? r : DEFAULT_NEARBY_RADIUS;
  const entry: GuildNearbyWatch = {
    needle,
    match,
    radius,
    handler,
    prevByClient: new WeakMap(),
  };
  guildNearbyWatches.push(entry);
  return () => {
    const i = guildNearbyWatches.indexOf(entry);
    if (i >= 0) guildNearbyWatches.splice(i, 1);
  };
}

function checkGuildNearbyWatches(client: ClientConnection, deps: BridgeDeps): void {
  const selfId = client.objectId;
  if (!selfId) return;
  const mx = client.playerData.pos.x;
  const my = client.playerData.pos.y;
  const rows = deps.worldState.getAllPlayersRawStatsForDashboard(deps.gameData);

  for (const w of guildNearbyWatches) {
    const inRange: GuildNearbyPlayer[] = [];
    for (const row of rows) {
      if (row.objectId === selfId) continue;
      const gname = rowGuildName(row);
      if (!guildTagMatches(gname, w.needle, w.match)) continue;
      const d = Math.hypot(row.x - mx, row.y - my);
      if (d <= w.radius) {
        inRange.push({
          name: row.name,
          guildName: gname,
          objectId: row.objectId,
          x: row.x,
          y: row.y,
          distance: d,
        });
      }
    }
    const nowIds = new Set<number>(inRange.map((p) => p.objectId));
    const prev = w.prevByClient.get(client);
    if (prev === undefined) {
      w.prevByClient.set(client, new Set<number>(nowIds));
      continue;
    }
    const entered: GuildNearbyPlayer[] = [];
    for (const p of inRange) {
      if (!prev.has(p.objectId)) entered.push(p);
    }
    w.prevByClient.set(client, new Set<number>(nowIds));
    if (entered.length === 0) continue;
    try {
      w.handler({ entered, inRange, radius: w.radius });
    } catch (err) {
      Logger.error('ScriptEvents', 'onGuildNearby handler failed', err as Error);
    }
  }
}

function checkPlayerNearbyWatches(client: ClientConnection, deps: BridgeDeps): void {
  const selfId = client.objectId;
  if (!selfId) return;
  const mx = client.playerData.pos.x;
  const my = client.playerData.pos.y;
  const rows = deps.worldState.getAllPlayersRawStatsForDashboard(deps.gameData);

  for (const w of nearbyWatches) {
    const inRange: PlayerNearbyPlayer[] = [];
    for (const row of rows) {
      if (row.objectId === selfId) continue;
      const key = row.name.trim().toLowerCase();
      if (!w.names.has(key)) continue;
      const d = Math.hypot(row.x - mx, row.y - my);
      if (d <= w.radius) {
        inRange.push({
          name: row.name,
          objectId: row.objectId,
          x: row.x,
          y: row.y,
          distance: d,
        });
      }
    }
    const nowKeys = new Set<string>(inRange.map((p) => p.name.trim().toLowerCase()));
    const prev = w.prevByClient.get(client);
    if (prev === undefined) {
      w.prevByClient.set(client, new Set<string>(nowKeys));
      continue;
    }
    const entered: PlayerNearbyPlayer[] = [];
    for (const p of inRange) {
      const k = p.name.trim().toLowerCase();
      if (!prev.has(k)) entered.push(p);
    }
    w.prevByClient.set(client, new Set<string>(nowKeys));
    if (entered.length === 0) continue;
    try {
      w.handler({ entered, inRange, radius: w.radius });
    } catch (err) {
      Logger.error('ScriptEvents', 'onPlayerNearby handler failed', err as Error);
    }
  }
}

function register(key: string, handler: AnyHandler): () => void {
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key)!.push(handler);
  return () => {
    const arr = listeners.get(key) ?? [];
    listeners.set(
      key,
      arr.filter((h) => h !== handler),
    );
  };
}

export function fire(key: string, event: any): void {
  for (const h of listeners.get(key) ?? []) {
    try {
      h(event);
    } catch (err) {
      Logger.error('ScriptEvents', `events.${key} handler failed`, err as Error);
    }
  }
}

function statStringFromData(data: unknown, statId: number): string {
  if (!Array.isArray(data)) return '';
  for (const s of data as Array<{ id?: number; value?: unknown }>) {
    if (s && s.id === statId && typeof s.value === 'string') {
      return String(s.value).trim();
    }
  }
  return '';
}

function registerCharacterFameAtLeast(
  threshold: number,
  handler: FameWatchHandler,
): () => void {
  const t = Math.floor(Number(threshold)) || 0;
  const entry = { threshold: t, handler };
  fameWatches.push(entry);
  return () => {
    const i = fameWatches.indexOf(entry);
    if (i >= 0) fameWatches.splice(i, 1);
  };
}

function checkCharacterFameThresholds(client: ClientConnection): void {
  const cur = client.playerData.characterAliveFame;
  const prev = lastCharacterFameByClient.get(client);
  if (prev !== undefined) {
    for (const { threshold, handler } of fameWatches) {
      if (prev < threshold && cur >= threshold) {
        try {
          handler({ fame: cur, threshold });
        } catch (err) {
          Logger.error(
            'ScriptEvents',
            'onCharacterFameAtLeast handler failed',
            err as Error,
          );
        }
      }
    }
  }
  lastCharacterFameByClient.set(client, cur);
}

function checkInventoryPickups(client: ClientConnection, deps: BridgeDeps): void {
  const inv = client.playerData.inventory;
  const prev = prevInvByClient.get(client);
  if (!prev || prev.length !== inv.length) {
    prevInvByClient.set(client, [...inv]);
    return;
  }
  for (let i = 0; i < inv.length; i++) {
    const oldV = prev[i]!;
    const newV = inv[i]!;
    const wasEmpty = !Number.isFinite(oldV) || oldV < 0;
    const hasItem = Number.isFinite(newV) && newV >= 0;
    if (wasEmpty && hasItem) {
      const item = deps.gameData.buildSdkItem(newV);
      fire('itemPickedUp', {
        slotIndex: i,
        objectType: newV,
        itemName: item?.name,
      });
    }
  }
  prevInvByClient.set(client, [...inv]);
}

function onNewTickForScriptEvents(client: ClientConnection, packet: Packet, deps: BridgeDeps): void {
  if (!packet.isDefined || !packet.data.statuses) return;
  let sawSelf = false;
  for (const status of packet.data.statuses as Array<{ objectId?: number }>) {
    if (status.objectId === client.objectId) {
      sawSelf = true;
      break;
    }
  }
  if (!sawSelf) return;

  const prevLvl = lastLevelByClient.get(client);
  const curLvl = client.playerData.level;
  if (prevLvl !== undefined && curLvl > prevLvl) {
    fire('levelUp', { newLevel: curLvl });
  }
  lastLevelByClient.set(client, curLvl);

  checkInventoryPickups(client, deps);
  checkCharacterFameThresholds(client);
}

export function install(deps: BridgeDeps): void {
  events.onPlayerDied = (handler) => register('playerDied', handler);

  events.onEnemySpawned = (handler) => register('enemySpawned', handler);

  events.onEnemySpawnedOfType = (objectType, handler) =>
    events.onEnemySpawned((e) => {
      if (e.objectType === objectType) handler(e);
    });

  events.onMapChanged = (handler) => register('mapChanged', handler);

  events.onConnected = (handler) => register('connected', handler);

  events.onDisconnected = (handler) => register('disconnected', handler);

  events.onLevelUp = (handler) => register('levelUp', handler);

  events.onItemPickedUp = (handler) => register('itemPickedUp', handler);

  events.onPortalOpened = (handler) => register('portalOpened', handler);

  events.onCharacterFameAtLeast = (threshold, handler) =>
    registerCharacterFameAtLeast(threshold, handler);

  events.onPlayerNearby = (
    names: string | readonly string[],
    handler: (e: PlayerNearbyEvent) => void,
    options?: PlayerNearbyOptions,
  ) => registerPlayerNearby(names, handler, options);

  type OnGuildNearbyFn = {
    (guildName: string, handler: (e: GuildNearbyEvent) => void, options?: GuildNearbyOptions): () => void;
    (
      guildName: string,
      match: GuildNearbyMatchMode,
      handler: (e: GuildNearbyEvent) => void,
      options?: GuildNearbyOptions,
    ): () => void;
  };
  events.onGuildNearby = ((
    guildName: string,
    matchOrHandler: GuildNearbyMatchMode | ((e: GuildNearbyEvent) => void),
    handlerOrOptions?: ((e: GuildNearbyEvent) => void) | GuildNearbyOptions,
    maybeOptions?: GuildNearbyOptions,
  ) =>
    registerGuildNearby(guildName, matchOrHandler, handlerOrOptions, maybeOptions)) as OnGuildNearbyFn;

  type OnPlayerJoinPartyFn = {
    (playerName: string, handler: (e: PlayerJoinPartyEvent) => void): () => void;
    (
      playerName: string,
      match: PlayerJoinPartyMatchMode,
      handler: (e: PlayerJoinPartyEvent) => void,
    ): () => void;
  };
  events.onPlayerJoinParty = ((
    playerName: string,
    matchOrHandler: PlayerJoinPartyMatchMode | ((e: PlayerJoinPartyEvent) => void),
    handler?: (e: PlayerJoinPartyEvent) => void,
  ) => registerPlayerJoinParty(playerName, matchOrHandler, handler)) as OnPlayerJoinPartyFn;

  events.onChat = (needle: string, handler: ChatHandler) => {
    const q = String(needle).trim().toLowerCase();
    if (!q) return () => {};
    return chat.onMessage((e) => {
      if (!e.message.toLowerCase().includes(q)) return;
      try {
        handler(e);
      } catch (err) {
        Logger.error('ScriptEvents', 'onChat handler failed', err as Error);
      }
    });
  };

  deps.proxy.hookPacket('DEATH', (client, packet) => {
    if (!packet.isDefined) return;
    const killedBy = String((packet.data as { killedBy?: string }).killedBy ?? '').trim();
    const playerName = (client.playerData.name || '').trim() || 'Unknown';
    fire('playerDied', {
      playerName,
      isLocal: true,
      killedBy: killedBy || undefined,
    });
  });

  deps.proxy.hookPacket('MAPINFO', (client, packet) => {
    if (!packet.isDefined) return;
    const d = packet.data as {
      displayName?: string;
      name?: string;
      width?: number;
      height?: number;
    };
    const mapName = normalizeMapDisplayName(d.displayName ?? '', d.name ?? '');
    const width = Number(d.width) || 0;
    const height = Number(d.height) || 0;
    fire('mapChanged', { mapName, width, height });
  });

  deps.proxy.hookPacket('CREATESUCCESS', (client, packet) => {
    if (!packet.isDefined) return;
    lastLevelByClient.delete(client);
    lastCharacterFameByClient.delete(client);
    prevInvByClient.set(client, [...client.playerData.inventory]);
    const addr = client.state?.conTargetAddress;
    const port = client.state?.conTargetPort;
    fire('connected', {
      serverAddress: addr ? `${addr}:${port ?? GAME_PORT}` : undefined,
    });
  });

  deps.proxy.on('clientDisconnected', (client: ClientConnection) => {
    lastLevelByClient.delete(client);
    lastCharacterFameByClient.delete(client);
    prevInvByClient.delete(client);
    fire('disconnected', {
      serverAddress: client.state?.conTargetAddress
        ? `${client.state.conTargetAddress}:${client.state.conTargetPort ?? GAME_PORT}`
        : undefined,
    });
  });

  deps.proxy.hookPacket('UPDATE', (client, packet) => {
    if (!packet.isDefined || !packet.data.newObjs) return;
    let selfInvTouch = false;
    for (const entity of packet.data.newObjs as Array<{
      objectType?: number;
      status?: { objectId?: number; position?: { x: number; y: number }; data?: unknown };
    }>) {
      const status = entity.status;
      if (!status) continue;
      if (status.objectId === client.objectId) selfInvTouch = true;

      const objectType = Number(entity.objectType);
      if (!Number.isFinite(objectType) || objectType <= 0) continue;
      const cat = deps.gameData.getObjectCategory(objectType);
      const pos = status.position ?? { x: 0, y: 0 };

      if (cat === 'Enemy') {
        const nameFromStat = statStringFromData(status.data, StatType.NameStat);
        const def = deps.gameData.getObject(objectType);
        const name =
          nameFromStat ||
          def?.displayId ||
          def?.id ||
          `0x${objectType.toString(16)}`;
        fire('enemySpawned', {
          objectType,
          objectId: status.objectId!,
          name,
          position: { x: pos.x, y: pos.y },
        });
      }

      if (cat === 'Portal') {
        const def = deps.gameData.getObject(objectType);
        const portalName =
          def?.displayId || def?.id || `Portal 0x${objectType.toString(16)}`;
        fire('portalOpened', {
          portalName,
          objectId: status.objectId!,
          position: { x: pos.x, y: pos.y },
        });
      }
    }
    if (selfInvTouch) {
      checkInventoryPickups(client, deps);
      checkCharacterFameThresholds(client);
    }
  });

  deps.proxy.hookPacket('NEWTICK', (client, packet) => {
    onNewTickForScriptEvents(client, packet, deps);
    checkPlayerNearbyWatches(client, deps);
    checkGuildNearbyWatches(client, deps);
  });

  deps.proxy.hookPacket('PARTYMEMBERADDED', (client, packet) => {
    dispatchPlayerJoinPartyFromPacket(client, packet);
  });
}
