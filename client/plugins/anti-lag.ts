import type { PluginContext } from '../src/plugins/PluginContext.js';
import type { ClientConnection } from '../src/proxy/ClientConnection.js';
import { StatType } from '../src/constants/StatType.js';

/**
 * S→C anti-lag: (1) size stat 2 in NEWTICK/UPDATE (Multitool Class82);
 * (2) drop SHOWEFFECT (id 11) when effect type is in the blocklist (unreadData[0]
 *     = EffectType; body unparsed in our defs, same as pyrelay ShowEffectPacket).
 */

type PetHideMode = 'off' | 'all' | 'ally_first';

type StatEntry = { id: number; value: number | string; stackCount?: number };
type ObjectStatus = { objectId?: number; data?: StatEntry[] };
type NewObj = { objectType?: number; status?: ObjectStatus };

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function isPetYardMap(mapName: string): boolean {
  return mapName.toLowerCase().includes('pet yard');
}

function computeDisplaySize(
  objectId: number,
  objectType: number,
  serverRaw: number,
  options: {
    selfObjectId: number;
    selfGuild: string;
    mapName: string;
    gamePetTypes: Set<number>;
    defIsPlayer: boolean;
    defIsPet: boolean;
    playerPct: number;
    allyPct: number;
    applyGuildMates: boolean;
    otherPlayerGuild: string | undefined;
    petHide: PetHideMode;
  },
): number {
  if (serverRaw <= 0) return serverRaw;
  if (isPetYardMap(options.mapName)) return serverRaw;

  const {
    selfObjectId, selfGuild, gamePetTypes, playerPct, allyPct, applyGuildMates, otherPlayerGuild,
  } = options;

  const isPlayer = options.defIsPlayer;
  const isPet = options.defIsPet || gamePetTypes.has(objectType);

  if (isPlayer) {
    if (objectId === selfObjectId) {
      if (playerPct === 100) return serverRaw;
      return Math.max(0, Math.floor((playerPct / 100) * serverRaw));
    }
    if (
      !applyGuildMates
      && selfGuild
      && otherPlayerGuild
      && selfGuild.toLowerCase() === otherPlayerGuild.toLowerCase()
    ) {
      return serverRaw;
    }
    if (allyPct === 100) return serverRaw;
    return Math.max(0, Math.floor((allyPct / 100) * serverRaw));
  }

  if (isPet) {
    if (options.petHide === 'all') {
      return 0;
    }
    if (options.petHide === 'ally_first') {
      // Multitool heuristic: "own" pet = objectId === player + 1 (not reliable for all follow patterns).
      const maybeOwn = objectId === selfObjectId + 1;
      if (maybeOwn) {
        if (playerPct === 100) return serverRaw;
        return Math.max(0, Math.floor((playerPct / 100) * serverRaw));
      }
      return 0;
    }
    if (allyPct === 100) return serverRaw;
    return Math.max(0, Math.floor((allyPct / 100) * serverRaw));
  }

  // Other entities (e.g. props): leave size unless you want to treat as ally scale — no-op.
  return serverRaw;
}

function hasSizeWork(
  playerPct: number,
  allyPct: number,
  petHide: PetHideMode,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (petHide !== 'off') return true;
  return playerPct !== 100 || allyPct !== 100;
}

function readPetHide(ctx: PluginContext): PetHideMode {
  const v = String(ctx.getSetting('petHide') ?? 'off');
  if (v === 'all' || v === 'ally_first') return v;
  return 'off';
}

/** `ExaltKitGUI.Proxy.EffectType` / client enum order (byte 0 of SHOWEFFECT). */
const EFFECT_TYPE_NAMES: readonly string[] = [
  'Unknown', 'Heal', 'Teleport', 'Stream', 'Throw', 'Nova', 'Poison', 'Line', 'Burst', 'Flow',
  'Ring', 'Lightning', 'Collapse', 'Coneblast', 'Jitter', 'Flash', 'ThrowProjectile', 'Shocker',
  'Shockee', 'RisingFury', 'NovaNoAoe', 'InspiredEffect', 'HolyBeamEffect', 'CircleTelegraphEffect',
  'ChaosBeamEffect', 'TeleportMonsterEffect', 'MeteorEffect', 'GildedBuff', 'JadeBuff', 'ChaosBuff',
  'ThunderBuff', 'StatusFlash', 'FireOrbBuff',
];

const DEFAULT_BLOCKED_EFFECTS_MT =
  'Stream, Line, Burst, Flow, Ring, Coneblast';

function parseBlockedEffectTypeSet(ctx: PluginContext): Set<number> {
  const raw = String(ctx.getSetting('blockedShowEffects') ?? DEFAULT_BLOCKED_EFFECTS_MT).trim();
  const out = new Set<number>();
  for (const part of raw.split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    if (/^\d+$/.test(t)) {
      const n = Math.trunc(Number(t));
      if (n >= 0 && n < 256) out.add(n);
      continue;
    }
    const idx = EFFECT_TYPE_NAMES.findIndex(
      (n) => n.toLowerCase() === t.toLowerCase(),
    );
    if (idx >= 0) out.add(idx);
  }
  return out;
}

function getShowEffectTypeByte(packet: { unreadData: Buffer; rawBytes: Buffer; bodyLength: number }): number | null {
  if (packet.unreadData && packet.unreadData.length > 0) {
    return packet.unreadData[0];
  }
  if (packet.rawBytes.length > 5) {
    return packet.rawBytes[5];
  }
  return null;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Anti-lag (size & effects)';
  ctx.category = 'visual';

  let gamePetTypes = new Set<number>();

  function rebuildPetSet(): void {
    gamePetTypes = new Set<number>();
    for (const o of ctx.gameData?.getAllObjects() ?? []) {
      if (o.isPet) gamePetTypes.add(o.type);
    }
  }

  ctx.registerSetting('enabled', {
    label: 'Enable size & pet scale',
    type: 'boolean',
    value: false,
  });

  ctx.registerSetting('playerSize', {
    label: 'Your player size (%)',
    type: 'number',
    value: 100,
    min: 25,
    max: 200,
    step: 1,
  });

  ctx.registerSetting('allySize', {
    label: 'Other players / default scale (%)',
    type: 'number',
    value: 100,
    min: 25,
    max: 200,
    step: 1,
  });

  ctx.registerSetting('applyToGuildMates', {
    label: 'Apply ally scale to guildmates (else keep server size for guild)',
    type: 'boolean',
    value: false,
  });

  ctx.registerSetting('petHide', {
    label: 'Pets on ground',
    type: 'select',
    value: 'off',
    options: [
      { label: 'Show (ally % or 100%)', value: 'off' },
      { label: 'Hide all (size 0)', value: 'all' },
      { label: "Hide others' (keep objectId+1 = own, experimental)", value: 'ally_first' },
    ],
  });

  ctx.registerSetting('blockShowEffect', {
    label: 'Block listed SHOWEFFECT types (less particles)',
    type: 'boolean',
    value: false,
  });

  ctx.registerSetting('blockedShowEffects', {
    label: 'Blocked effect types (comma-sep. names or 0-255 ids)',
    type: 'text',
    value: DEFAULT_BLOCKED_EFFECTS_MT,
  });

  rebuildPetSet();

  function guildFromEntityStats(oid: number): string | undefined {
    if (!ctx.worldState) return undefined;
    const e = ctx.worldState.getEntity(oid);
    const g = e?.stats?.[String(StatType.GuildName)];
    if (typeof g === 'string' && g.trim()) return g.trim();
    return undefined;
  }

  function readPct(key: 'playerSize' | 'allySize'): number {
    return Math.max(25, Math.min(200, Math.trunc(Number(ctx.getSetting(key)) || 100)));
  }

  function rewriteSizeForStatus(
    client: ClientConnection,
    status: ObjectStatus,
    objectTypeHint: number | undefined,
  ): boolean {
    if (!ctx.gameData) return false;
    const oid = toInt(status.objectId);
    if (oid <= 0) return false;

    if (!Array.isArray(status.data)) status.data = [];
    const data = status.data;
    const sizeIndex = data.findIndex((s) => toInt(s.id) === StatType.Size);
    if (sizeIndex < 0) return false;

    const st = data[sizeIndex];
    const serverRaw = toInt(st.value);
    if (serverRaw === 0) return false;

    const objectType = objectTypeHint ?? ctx.worldState?.getEntity(oid)?.objectType ?? 0;
    if (!objectType) return false;

    const def = ctx.gameData.getObject(objectType);
    const newSize = computeDisplaySize(oid, objectType, serverRaw, {
      selfObjectId: client.objectId,
      selfGuild: String(client.playerData.guildName || '').trim(),
      mapName: String(client.playerData.mapName || ''),
      gamePetTypes,
      defIsPlayer: def?.isPlayer === true,
      defIsPet: def?.isPet === true,
      playerPct: readPct('playerSize'),
      allyPct: readPct('allySize'),
      applyGuildMates: !!ctx.getSetting<boolean>('applyToGuildMates'),
      otherPlayerGuild: guildFromEntityStats(oid),
      petHide: readPetHide(ctx),
    });

    if (newSize === serverRaw) return false;
    st.value = newSize;
    return true;
  }

  ctx.hookPacket('NEWTICK', (client, packet) => {
    const en = !!ctx.getSetting<boolean>('enabled');
    const ph = readPetHide(ctx);
    if (!hasSizeWork(readPct('playerSize'), readPct('allySize'), ph, en)) return;
    if (!packet.isDefined) return;
    const statuses = packet.data.statuses as ObjectStatus[] | undefined;
    if (!Array.isArray(statuses) || statuses.length === 0) return;

    let changed = false;
    for (const s of statuses) {
      if (rewriteSizeForStatus(client, s, undefined)) changed = true;
    }
    if (changed) packet.modified = true;
  });

  ctx.hookPacket('UPDATE', (client, packet) => {
    const en = !!ctx.getSetting<boolean>('enabled');
    const ph = readPetHide(ctx);
    if (!hasSizeWork(readPct('playerSize'), readPct('allySize'), ph, en)) return;
    if (!packet.isDefined) return;
    const newObjs = packet.data.newObjs as NewObj[] | undefined;
    if (!Array.isArray(newObjs) || newObjs.length === 0) return;

    let changed = false;
    for (const obj of newObjs) {
      const ot = toInt(obj.objectType);
      if (ot <= 0 || !obj.status) continue;
      if (rewriteSizeForStatus(client, obj.status, ot)) changed = true;
    }
    if (changed) packet.modified = true;
  });

  ctx.hookPacket('MAPINFO', () => {
    rebuildPetSet();
  });

  ctx.hookPacket('SHOWEFFECT', (_client, packet) => {
    if (!ctx.getSetting<boolean>('blockShowEffect')) return;
    if (!packet.isDefined) return;
    const b = getShowEffectTypeByte(packet);
    if (b === null) return;
    const block = parseBlockedEffectTypeSet(ctx);
    if (block.size === 0) return;
    if (block.has(b)) {
      packet.send = false;
    }
  });

  ctx.log(
    `Anti-lag: ${gamePetTypes.size} pet type(s), SHOWEFFECT: blocklist uses ${EFFECT_TYPE_NAMES.length} effect ids.`,
  );
}
