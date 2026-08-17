import type { PluginContext } from '../src/plugins/PluginContext.js';
import { getRealmengineDataDir } from '../src/util/rotmgAssetExtractor.js';
import { normalizeMapDisplayName } from '../src/util/mapDisplayName.js';
import { StatType } from '../src/constants/StatType.js';
import { AbilityScalingManager } from '../src/damage-sniffer/abilityScalingManager.js';
import {
  processCrucibleJsonStrings,
  updatePlayerCrucibleFromStats,
} from '../src/damage-sniffer/crucibleBonusManager.js';
import {
  buildLocalPlayerProjectileDamage,
  computeUserProjectileHitDamage,
  type TomatoProjectileInput,
} from '../src/damage-sniffer/tomatoUserProjectileHit.js';
import {
  TOMATO_ANIMATION_STAT_WIRE,
  TOMATO_GUARDED_PHASE_OBJECT_TYPES,
  tomatoLineIsGuarded,
} from '../src/damage-sniffer/tomatoBossGuards.js';

/**
 * Damage Sniffer plugin.
 *
 * RealmShark / Tomato-style DPS logger for the web dashboard:
 * - objects.xml → {@link AbilityScalingManager} (extracted from local game; contains full equipment Activate data)
 * - PLAYERSHOOT + SERVERPLAYERSHOOT: TomatoData projectile registry + minionOwnerMap (same rules as X-com/RealmShark tomato TomatoData.java)
 * - playerListIds: UPDATE newObjs where getObjectCategory === 'Player' (Tomato CharacterClass.isPlayerCharacter / players.xml class set ≈ objects.xml Class Player)
 * - DAMAGE attacker: playerList first, else minionOwnerMap → owner in playerList (TomatoData.damage)
 * - Local PLAYERSHOOT: projectiles[bulletId] + map owner|bulletId only (TomatoData.playerShoot — no wrapped index for local)
 * - ENEMYHIT: Tomato Entity.userProjectileHit (defense / proc scaling / ability branches) → adds damage + hits
 * - DAMAGE: Tomato Entity.genericDamageHit (server damageAmount) → adds damage + hits (same double-count model as Tomato DPS)
 * - DAMAGE victim is player: Tomato-style damage taken during each boss fight window (Entity.damageTaken vs boss first/last hit time); see RealmShark TomatoData.damage + userDamage
 * - CRUCIBLERESPONSE + crucible stats 128/155 on NEWTICK for local player
 * - Snapshots attacker equipment (slots 8–11) per hit; boss/miniboss tags
 */

interface EquipAgg {
  hits: number;
  damage: number;
}

interface PlayerTargetState {
  objectId: number;
  name: string;
  classType?: number;
  /** Player skin ID (StatType.Skin = 76). 0 = default skin. */
  skin?: number;
  /** Clothing dye layer 1 (StatType.Texture1 = 32). */
  tex1?: number;
  /** Clothing dye layer 2 (StatType.Texture2 = 33). */
  tex2?: number;
  damage: number;
  hits: number;
  /** Non-summon dealt damage (weapon + ability combined — same packets). */
  weaponDamage: number;
  /** Minion / pet / trap etc. (projectile summonerId or DAMAGE from non-player objectId). */
  summonDamage: number;
  /** Tomato bossPhaseDamage / GuardsHandler — O3 guard, garden reflector, Dammah counter (if tracked). */
  guardedHits: number;
  guardedDamage: number;
  /** Server damage this player took during this boss/miniboss fight window (Tomato dmg.owner.damageTaken(boss)). */
  damageTaken: number;
  /** Count of incoming DAMAGE lines in that window (Tomato damageTaken()[1]). */
  hitsTaken: number;
  // slotIndex 0..3 => itemId => EquipAgg
  equip: [Map<number, EquipAgg>, Map<number, EquipAgg>, Map<number, EquipAgg>, Map<number, EquipAgg>];
  /** Per-slot enchant IDs snapshot (decoded from UNIQUE_DATA_STRING). */
  equipEnchants?: [number[], number[], number[], number[]];
}

interface TargetState {
  targetObjectId: number;
  targetType: number;
  targetName: string;
  targetMaxHp: number;
  boss: boolean;
  miniboss: boolean;
  firstHitAt: number;
  lastHitAt: number;
  killed: boolean;
  players: Map<number, PlayerTargetState>;
}

interface RunState {
  mapName: string;
  startTime: number;
  targets: Map<number, TargetState>;
}

// Payloads for dashboard (JSON-serializable)
export interface PlayerTargetLog {
  objectId: number;
  name: string;
  classType?: number;
  skin?: number;
  tex1?: number;
  tex2?: number;
  damage: number;
  hits: number;
  weaponDamage: number;
  summonDamage: number;
  guardedHits: number;
  guardedDamage: number;
  damageTaken: number;
  hitsTaken: number;
  pct: string;
  equipTop: { wpn: number; abl: number; arm: number; rng: number };
  equipHits: { wpn: number; abl: number; arm: number; rng: number };
  /** Per-slot enchant IDs for top equipment: [weapon, ability, armor, ring]. */
  equipEnchants?: { wpn: number[]; abl: number[]; arm: number[]; rng: number[] };
}

export interface TargetLog {
  targetObjectId: number;
  targetType: number;
  targetName: string;
  targetMaxHp: number;
  boss: boolean;
  miniboss: boolean;
  killed: boolean;
  firstHitAt: number;
  lastHitAt: number;
  durationSec: number;
  players: PlayerTargetLog[];
}

export interface RunLog {
  mapName: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  targets: TargetLog[];
  timestamp: number;
  /** Proxied client objectId — dashboard highlights YOU in player breakdown */
  localPlayerId?: number | null;
}

const DEFAULT_MIN_BOSS_HP = 10000;
const DEFAULT_MIN_MINIBOSS_HP = 3000;
const HISTORY_CAP = 25;

/** Legacy fixed array size for bulletId indexing (Tomato TomatoData). */
const PROJECTILES_LEN = 512;

interface StoredPlayerProjectile {
  damage: number;
  summonerId: number;
  containerType: number;
  bulletType: number;
  armorPiercing: boolean;
  /** Tomato snapshot from owner stats at SERVERPLAYERSHOOT time when scaling applies */
  originScalingStat?: number;
}

function playerProjectileKey(ownerId: number, bulletId: number): string {
  return `${ownerId}:${bulletId >>> 0}`;
}

function slotIndexWrapped(bulletId: number): number {
  return (bulletId % 256) + 256;
}

export function register(ctx: PluginContext) {
  ctx.name = 'Damage Sniffer';
  ctx.category = 'utility';

  const abilityScaling = new AbilityScalingManager();
  abilityScaling.loadEquipXml(`${getRealmengineDataDir()}/objects.xml`);

  /** Tomato map RNG seed surrogate for PLAYERSHOOT rolls */
  let playerShootRng = 0xdeadbeef;
  function nextPlayerShootRng(): number {
    playerShootRng ^= playerShootRng << 13;
    playerShootRng ^= playerShootRng >>> 17;
    playerShootRng ^= playerShootRng << 5;
    return playerShootRng | 0;
  }
  function hashMapNameSeed(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }

  let minBossHp = DEFAULT_MIN_BOSS_HP;
  let minMiniBossHp = DEFAULT_MIN_MINIBOSS_HP;
  let showNotifications = true;

  ctx.registerSetting('minBossHp', {
    label: 'Min Boss HP',
    type: 'number',
    value: minBossHp,
    min: 1000,
    max: 500000,
    step: 1000,
  }, (val: number) => { minBossHp = val; });

  ctx.registerSetting('minMiniBossHp', {
    label: 'Min MiniBoss HP',
    type: 'number',
    value: minMiniBossHp,
    min: 500,
    max: 200000,
    step: 500,
  }, (val: number) => { minMiniBossHp = val; });

  ctx.registerSetting('showNotifications', {
    label: 'In-Game Alerts',
    type: 'boolean',
    value: showNotifications,
  }, (val: boolean) => { showNotifications = val; });

  // ─── State ─────────────────────────────────────────────

  // Legacy: keep a name/class cache for cases where the attacker isn't in worldState (edge cases).
  const playerNames = new Map<number, string>();
  const playerClassTypes = new Map<number, number>();

  let currentRun: RunState = {
    mapName: '',
    startTime: Date.now(),
    targets: new Map(),
  };

  const runHistory: RunLog[] = [];

  // Live payload cache (for rate-limited broadcast)
  let lastLiveBroadcastAt = 0;
  let liveDirty = false;

  /** MITM client objectId — YOU badge + DAMAGE fallback before UPDATE adds us to tomatoPlayerListIds */
  let localPlayerObjectId: number | null = null;

  function touchLocalPlayer(client: { objectId: number }): void {
    const id = client.objectId;
    if (Number.isFinite(id) && id > 0) localPlayerObjectId = id;
  }

  /** TomatoData.playerList — entity ids whose objectType is a player class (see Tomato entityUpdate + CharacterClass) */
  const tomatoPlayerListIds = new Set<number>();

  // ─── TomatoData-style projectile + minion state (cleared on MAPINFO) ───

  const minionOwnerMap = new Map<number, number>();
  const playerProjectiles = new Map<string, StoredPlayerProjectile>();
  const projectilesBySlot: (StoredPlayerProjectile | undefined)[] = new Array(PROJECTILES_LEN);

  /** ENEMYHIT kill flag keyed by effectiveShooterId:targetId:bulletId for DAMAGE merge */
  const pendingKillFromEnemyHit = new Map<string, { kill: boolean; time: number }>();
  const PENDING_KILL_TTL_MS = 10_000;

  function clearProjectileState(): void {
    minionOwnerMap.clear();
    playerProjectiles.clear();
    projectilesBySlot.fill(undefined);
    pendingKillFromEnemyHit.clear();
    tomatoPlayerListIds.clear();
  }

  function rememberPendingKill(shooterId: number, targetId: number, bulletId: number, kill: boolean): void {
    pendingKillFromEnemyHit.set(pendingKillKey(shooterId, targetId, bulletId), {
      kill,
      time: Date.now(),
    });
    const cutoff = Date.now() - PENDING_KILL_TTL_MS;
    for (const [k, v] of pendingKillFromEnemyHit) {
      if (v.time < cutoff) pendingKillFromEnemyHit.delete(k);
    }
  }

  function putProjectileAtSlot(slot: number, proj: StoredPlayerProjectile): void {
    if (slot >= 0 && slot < PROJECTILES_LEN) projectilesBySlot[slot] = proj;
  }

  function registerPlayerProjectile(
    ownerId: number,
    bulletId: number,
    proj: StoredPlayerProjectile,
  ): void {
    playerProjectiles.set(playerProjectileKey(ownerId, bulletId), proj);
    const u = bulletId & 0xffff;
    if (u >= 0 && u < PROJECTILES_LEN) {
      projectilesBySlot[u] = proj;
    }
  }

  /**
   * TomatoData.enemtyHit projectile resolution: map by owner+bulletId, then wrapped slot, then direct index.
   */
  function resolveProjectileForEnemyHit(ownerId: number, bulletId: number): StoredPlayerProjectile | undefined {
    let projectile = playerProjectiles.get(playerProjectileKey(ownerId, bulletId));
    if (projectile) return projectile;

    const wrapped = slotIndexWrapped(bulletId);
    if (wrapped >= 0 && wrapped < PROJECTILES_LEN) {
      projectile = projectilesBySlot[wrapped];
      if (projectile) return projectile;
    }

    const u = bulletId & 0xffff;
    if (u >= 0 && u < PROJECTILES_LEN) {
      projectile = projectilesBySlot[u];
    }
    return projectile;
  }

  /** Tomato enemtyHit: if projectile.summonerId !== 0, attribute hits to summoner (player). */
  function effectiveShooterIdFromEnemyHit(ownerId: number, projectile: StoredPlayerProjectile | undefined): number {
    if (projectile && projectile.summonerId !== 0) return projectile.summonerId;
    return ownerId;
  }

  /**
   * TomatoData.damage attacker resolution: playerList.get(objectId), else minionOwnerMap + playerList.get(owner).
   */
  function resolveDamageAttackerId(objectId: number): number | null {
    if (tomatoPlayerListIds.has(objectId)) return objectId;
    if (localPlayerObjectId != null && objectId === localPlayerObjectId) return objectId;

    const ownerId = minionOwnerMap.get(objectId);
    if (ownerId != null) {
      if (tomatoPlayerListIds.has(ownerId)) return ownerId;
      if (localPlayerObjectId != null && ownerId === localPlayerObjectId) return ownerId;
      return null;
    }

    return null;
  }

  function pendingKillKey(shooterId: number, targetId: number, bulletId: number): string {
    return `${shooterId}:${targetId}:${bulletId}`;
  }

  function getMapNameFromMapInfo(packet: any): string {
    return normalizeMapDisplayName(packet?.data?.displayName, packet?.data?.name);
  }

  /** Split on first comma / pipe / semicolon / tab — name is first segment only. */
  const PLAYER_NAME_METADATA_SPLIT = /[,|;\t]/;

  /**
   * Name stat can include trailing metadata (e.g. {@code CowNameSam,9a00,9a10}).
   * Use only the leading segment (trimmed) for DPS labels.
   */
  function sanitizePlayerNameForSniffer(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const first = raw.trim().split(PLAYER_NAME_METADATA_SPLIT)[0];
    return first.trim();
  }

  function getEntityName(objectId: number): string {
    const ent = ctx.worldState?.getEntity(objectId);
    const v = ent?.stats?.[String(StatType.NameStat)];
    if (typeof v === 'string') {
      const name = sanitizePlayerNameForSniffer(v);
      if (name) return name;
    }
    const cached = playerNames.get(objectId);
    if (cached) return cached;
    return '?';
  }

  function getEntityClassType(objectId: number): number | undefined {
    const ent = ctx.worldState?.getEntity(objectId);
    if (ent?.objectType) return ent.objectType;
    return playerClassTypes.get(objectId);
  }

  function getEquippedItemIds(objectId: number): [number, number, number, number] {
    const ent = ctx.worldState?.getEntity(objectId);
    const stats = ent?.stats;
    if (!stats) return [-1, -1, -1, -1];
    const getItem = (id: number): number => {
      const v = stats[String(id)];
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : -1;
    };
    return [getItem(8), getItem(9), getItem(10), getItem(11)];
  }

  function isMinibossType(objectType: number): boolean {
    const def = ctx.gameData?.getObject(objectType);
    if (!def) return false;
    return !!def.god || (def.maxHp >= minMiniBossHp);
  }

  function getTargetState(targetId: number, targetType: number): TargetState {
    const existing = currentRun.targets.get(targetId);
    if (existing) return existing;

    const def = ctx.gameData?.getObject(targetType);
    const boss = !!ctx.gameData?.isBoss(targetType, minBossHp);
    const miniboss = !boss && isMinibossType(targetType);
    const now = Date.now();

    const st: TargetState = {
      targetObjectId: targetId,
      targetType,
      targetName: def?.id ?? `0x${targetType.toString(16)}`,
      targetMaxHp: def?.maxHp ?? 0,
      boss,
      miniboss,
      firstHitAt: now,
      lastHitAt: now,
      killed: false,
      players: new Map(),
    };
    currentRun.targets.set(targetId, st);
    return st;
  }

  function getPlayerTargetState(target: TargetState, attackerId: number): PlayerTargetState {
    let ps = target.players.get(attackerId);
    if (ps) return ps;
    ps = {
      objectId: attackerId,
      name: getEntityName(attackerId),
      classType: getEntityClassType(attackerId),
      damage: 0,
      hits: 0,
      weaponDamage: 0,
      summonDamage: 0,
      guardedHits: 0,
      guardedDamage: 0,
      damageTaken: 0,
      hitsTaken: 0,
      equip: [new Map(), new Map(), new Map(), new Map()],
    };
    target.players.set(attackerId, ps);
    return ps;
  }

  /** Victim is a player we can attribute (Tomato playerList + local client). */
  function isTrackedPlayerVictim(victimId: number): boolean {
    if (tomatoPlayerListIds.has(victimId)) return true;
    if (localPlayerObjectId != null && victimId === localPlayerObjectId) return true;
    const ot = ctx.worldState?.getEntityType(victimId);
    if (ot !== undefined && ctx.gameData?.getObjectCategory(ot) === 'Player') return true;
    return false;
  }

  /**
   * Tomato Entity.damageTaken(bossEntity): sum incoming DAMAGE to this player while boss fight is active.
   * Uses wall-clock [firstHitAt, lastHitAt] on each TargetState (same role as boss first/last damage time).
   */
  function applyIncomingPlayerDamage(victimId: number, amount: number): void {
    if (amount <= 0 || !isTrackedPlayerVictim(victimId)) return;
    const tsNow = Date.now();
    let any = false;
    for (const t of currentRun.targets.values()) {
      const ps = t.players.get(victimId);
      if (!ps) continue;
      if (tsNow < t.firstHitAt || t.killed) continue;
      ps.damageTaken += amount;
      ps.hitsTaken += 1;
      any = true;
    }
    if (any) {
      liveDirty = true;
      broadcastLiveIfDue();
    }
  }

  /** Tomato Entity.updateDamageTaken — fight window without DPS totals from ENEMYHIT. */
  function touchFightTimingFromHit(targetId: number): void {
    if (!ctx.worldState || !ctx.gameData) return;
    const targetType = ctx.worldState.getEntityType(targetId);
    if (targetType === undefined) return;
    const target = getTargetState(targetId, targetType);
    const now = Date.now();
    if (target.players.size === 0) target.firstHitAt = now;
    target.lastHitAt = now;
  }

  function addEquipSample(ps: PlayerTargetState, equipped: [number, number, number, number], damage: number): void {
    for (let slot = 0; slot < 4; slot++) {
      const itemId = equipped[slot];
      if (itemId == null || itemId === -1) continue;
      const m = ps.equip[slot];
      const agg = m.get(itemId) ?? { hits: 0, damage: 0 };
      agg.hits += 1;
      agg.damage += damage;
      m.set(itemId, agg);
    }
  }

  /** Stat 80 = UNIQUE_DATA_STRING — comma-separated base64 enchant codes per slot. */
  const STAT_UNIQUE_DATA_STRING = 80;

  /**
   * Decode a single base64 enchant code → array of enchant IDs.
   * Format: 1-byte header, 2-byte type (must be 0x0402), then 2-byte LE enchant IDs until 0xFFFD terminator.
   */
  function decodeEnchantIds(code: string): number[] {
    const raw = code.trim();
    if (!raw) return [];
    try {
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=');
      const bytes = Buffer.from(normalized, 'base64');
      if (bytes.length <= 3) return [];
      const ids: number[] = [];
      for (let pos = 3; pos + 1 < bytes.length; pos += 2) {
        const value = bytes.readUInt16LE(pos);
        if (value === 0xfffd) break;
        ids.push(value === 0xfffe ? 0 : value);
      }
      return ids;
    } catch {
      return [];
    }
  }

  /** Snapshot enchant IDs for the 4 equipment slots from UNIQUE_DATA_STRING stat. */
  function snapshotEquipEnchants(objectId: number): [number[], number[], number[], number[]] | undefined {
    const ent = ctx.worldState?.getEntity(objectId);
    const v = ent?.stats?.[String(STAT_UNIQUE_DATA_STRING)];
    if (typeof v !== 'string' || !v) return undefined;
    const parts = v.split(',');
    return [
      decodeEnchantIds(parts[0] || ''),
      decodeEnchantIds(parts[1] || ''),
      decodeEnchantIds(parts[2] || ''),
      decodeEnchantIds(parts[3] || ''),
    ];
  }

  function getNumericStat(objectId: number, statId: number): number | undefined {
    const ent = ctx.worldState?.getEntity(objectId);
    const v = ent?.stats?.[String(statId)];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }

  /** Tomato addPlayerDmg — one logical damage line (ENEMYHIT userProjectileHit or DAMAGE generic). */
  function applyTomatoHit(
    targetId: number,
    attackerId: number,
    damageAmount: number,
    category: 'weapon' | 'summon',
  ): void {
    if (!ctx.worldState || !ctx.gameData) return;
    if (damageAmount <= 0) return;
    const targetType = ctx.worldState.getEntityType(targetId);
    if (targetType === undefined) return;
    const target = getTargetState(targetId, targetType);
    const now = Date.now();
    const isFirstLine = target.players.size === 0;
    const ps = getPlayerTargetState(target, attackerId);
    if (isFirstLine) target.firstHitAt = now;
    target.lastHitAt = now;
    ps.name = getEntityName(attackerId);
    ps.classType = getEntityClassType(attackerId);
    // Snapshot player appearance (skin/tex) — cheap reads, overwrite each hit to stay current
    ps.skin = getNumericStat(attackerId, StatType.Skin) ?? ps.skin;
    ps.tex1 = getNumericStat(attackerId, StatType.Texture1) ?? ps.tex1;
    ps.tex2 = getNumericStat(attackerId, StatType.Texture2) ?? ps.tex2;
    ps.damage += damageAmount;
    ps.hits += 1;
    if (category === 'summon') ps.summonDamage += damageAmount;
    else ps.weaponDamage += damageAmount;

    const anim = getNumericStat(targetId, TOMATO_ANIMATION_STAT_WIRE);
    const hasGuardedPhase =
      ctx.worldState?.hasAnyEntityObjectTypeIn(TOMATO_GUARDED_PHASE_OBJECT_TYPES) ?? false;
    if (
      tomatoLineIsGuarded({
        targetObjectType: targetType,
        animationStat: anim,
        hasGuardedPhaseEntity: hasGuardedPhase,
        dammahCountered: false,
      })
    ) {
      ps.guardedHits += 1;
      ps.guardedDamage += damageAmount;
    }

    addEquipSample(ps, getEquippedItemIds(attackerId), damageAmount);
    // Snapshot enchant IDs (available when stat 80 is present — typically local player + nearby)
    const enchants = snapshotEquipEnchants(attackerId);
    if (enchants) ps.equipEnchants = enchants;
    liveDirty = true;
    broadcastLiveIfDue();
  }

  function pickTopEquip(m: Map<number, EquipAgg>): { id: number; hits: number; damage: number } {
    let bestId = -1;
    let bestDamage = -1;
    let bestHits = -1;
    for (const [id, agg] of m.entries()) {
      if (agg.damage > bestDamage || (agg.damage === bestDamage && agg.hits > bestHits)) {
        bestId = id;
        bestDamage = agg.damage;
        bestHits = agg.hits;
      }
    }
    return { id: bestId, hits: Math.max(0, bestHits), damage: Math.max(0, bestDamage) };
  }

  function serializeRunLive(): {
    mapName: string;
    startTime: number;
    now: number;
    localPlayerId: number | null;
    targets: TargetLog[];
  } {
    const now = Date.now();
    const targets: TargetLog[] = [];
    for (const t of currentRun.targets.values()) {
      const players = [...t.players.values()];
      const total = players.reduce((s, p) => s + p.damage, 0);
      const playerLogs: PlayerTargetLog[] = players
        .sort((a, b) => b.damage - a.damage)
        .map((p) => {
          const pct = total > 0 ? ((p.damage / total) * 100).toFixed(1) : '0.0';
          const w = pickTopEquip(p.equip[0]);
          const a = pickTopEquip(p.equip[1]);
          const ar = pickTopEquip(p.equip[2]);
          const r = pickTopEquip(p.equip[3]);
          const ee = p.equipEnchants;
          return {
            objectId: p.objectId,
            name: p.name,
            classType: p.classType,
            skin: p.skin,
            tex1: p.tex1,
            tex2: p.tex2,
            damage: p.damage,
            hits: p.hits,
            weaponDamage: p.weaponDamage,
            summonDamage: p.summonDamage,
            guardedHits: p.guardedHits,
            guardedDamage: p.guardedDamage,
            damageTaken: p.damageTaken,
            hitsTaken: p.hitsTaken,
            pct,
            equipTop: { wpn: w.id, abl: a.id, arm: ar.id, rng: r.id },
            equipHits: { wpn: w.hits, abl: a.hits, arm: ar.hits, rng: r.hits },
            equipEnchants: ee ? { wpn: ee[0], abl: ee[1], arm: ee[2], rng: ee[3] } : undefined,
          };
        });

      targets.push({
        targetObjectId: t.targetObjectId,
        targetType: t.targetType,
        targetName: t.targetName,
        targetMaxHp: t.targetMaxHp,
        boss: t.boss,
        miniboss: t.miniboss,
        killed: t.killed,
        firstHitAt: t.firstHitAt,
        lastHitAt: t.lastHitAt,
        durationSec: Math.max(0, (t.lastHitAt - t.firstHitAt) / 1000),
        players: playerLogs,
      });
    }
    // Default sort: most recent active target first, then most damage
    targets.sort((a, b) => (b.lastHitAt - a.lastHitAt) || ((b.players[0]?.damage ?? 0) - (a.players[0]?.damage ?? 0)));
    return {
      mapName: currentRun.mapName,
      startTime: currentRun.startTime,
      now,
      localPlayerId: localPlayerObjectId,
      targets,
    };
  }

  function finalizeCurrentRun(): void {
    const endTime = Date.now();
    if (currentRun.targets.size === 0) {
      currentRun = { mapName: currentRun.mapName, startTime: endTime, targets: new Map() };
      return;
    }

    const live = serializeRunLive();
    const run: RunLog = {
      mapName: currentRun.mapName,
      startTime: currentRun.startTime,
      endTime,
      durationSec: Math.max(0, (endTime - currentRun.startTime) / 1000),
      targets: live.targets,
      timestamp: endTime,
      localPlayerId: live.localPlayerId,
    };
    runHistory.push(run);
    if (runHistory.length > HISTORY_CAP) runHistory.splice(0, runHistory.length - HISTORY_CAP);

    ctx.setData('damageHistory', runHistory);
    ctx.broadcastData('damageHistory', runHistory);

    // Reset run
    currentRun = { mapName: currentRun.mapName, startTime: endTime, targets: new Map() };
  }

  function broadcastLiveIfDue(): void {
    if (!liveDirty) return;
    const now = Date.now();
    if (now - lastLiveBroadcastAt < 200) return;
    lastLiveBroadcastAt = now;
    liveDirty = false;
    const payload = serializeRunLive();
    ctx.setData('damageLive', payload);
    ctx.broadcastData('damageLive', payload);
  }

  // ─── Map change boundary ───────────────────────────────

  ctx.hookPacket('MAPINFO', (client, packet) => {
    touchLocalPlayer(client);
    const mapName = getMapNameFromMapInfo(packet);
    // Finalize previous map run
    finalizeCurrentRun();
    currentRun.mapName = mapName;
    currentRun.startTime = Date.now();
    clearProjectileState();
    playerShootRng = (hashMapNameSeed(mapName) ^ Date.now()) | 0;
  });

  // ─── Name/class tracking (fallback cache) ──────────────

  ctx.hookPacket('UPDATE', (_client, packet) => {
    if (!packet.isDefined) return;
    if (packet.data.drops) {
      for (const id of packet.data.drops as number[]) {
        tomatoPlayerListIds.delete(id);
      }
    }
    if (!packet.data.newObjs) return;
    for (const entity of packet.data.newObjs as any[]) {
      const status = entity.status;
      if (!status?.data) continue;
      const objectType = entity.objectType as number;
      if (ctx.gameData?.getObjectCategory(objectType) === 'Player') {
        tomatoPlayerListIds.add(status.objectId);
      }
      if (entity.objectType) {
        playerClassTypes.set(status.objectId, entity.objectType as number);
      }
      for (const stat of status.data as Array<{ id: number; value: unknown }>) {
        if (stat.id === StatType.NameStat && typeof stat.value === 'string') {
          const name = sanitizePlayerNameForSniffer(stat.value);
          if (name) playerNames.set(status.objectId, name);
        }
      }
    }
  });

  ctx.hookPacket('NEWTICK', (client, packet) => {
    touchLocalPlayer(client);
    if (!packet.isDefined || !packet.data.statuses) return;
    for (const status of packet.data.statuses as any[]) {
      if (!status?.data) continue;
      for (const stat of status.data as Array<{ id: number; value: unknown }>) {
        if (stat.id === StatType.NameStat && typeof stat.value === 'string') {
          const name = sanitizePlayerNameForSniffer(stat.value);
          if (name) playerNames.set(status.objectId, name);
        }
      }
      if (status.objectId === client.objectId && status.data) {
        const stats: Record<string, number | string> = {};
        for (const stat of status.data as Array<{ id: number; value: unknown }>) {
          const v = stat.value;
          if (typeof v === 'number' || typeof v === 'string') {
            stats[String(stat.id)] = v;
          }
        }
        updatePlayerCrucibleFromStats(stats);
      }
    }
  });

  ctx.hookPacket('CRUCIBLERESPONSE', (_client, packet) => {
    if (!packet.isDefined) return;
    const jsons = packet.data.crucibleJsons as string[] | undefined;
    if (jsons?.length) {
      processCrucibleJsonStrings(
        String(jsons[0] ?? ''),
        String(jsons[1] ?? ''),
        String(jsons[2] ?? ''),
      );
    }
  });

  // ─── TomatoData.serverPlayerShoot ───────────────────────

  ctx.hookPacket('SERVERPLAYERSHOOT', (_client, packet) => {
    if (!packet.isDefined || !ctx.gameData) return;

    const bulletId = (packet.data.bulletId as number) & 0xffff;
    const ownerId = packet.data.ownerId as number;
    const containerType = packet.data.containerType as number;
    const damage = packet.data.damage as number;
    const superOwnerId = packet.data.superOwnerId as number;
    const bulletTypeRaw = packet.data.bulletType as number | undefined;
    const bulletType = Number.isFinite(bulletTypeRaw as number) ? (bulletTypeRaw as number) : 255;
    const numShotsRaw = packet.data.numShots as number | undefined;
    const summonerId = Number.isFinite(superOwnerId) ? superOwnerId : 0;

    if (summonerId !== 0 && ownerId !== 0) {
      minionOwnerMap.set(ownerId, summonerId);
    }

    const bulletCount =
      Number.isFinite(numShotsRaw as number) && (numShotsRaw as number) > 1 && (numShotsRaw as number) !== 255
        ? (numShotsRaw as number)
        : 1;

    const ap = ctx.gameData.getProjectile(containerType, bulletType)?.armorPiercing ?? false;
    let originScalingStat: number | undefined;
    try {
      const sd = abilityScaling.getScalingData(containerType);
      if (sd) {
        const n = getNumericStat(ownerId, sd.scalingStatId);
        if (n != null) originScalingStat = n;
      }
    } catch {
      /* ignore */
    }
    const stored: StoredPlayerProjectile = {
      damage,
      summonerId,
      containerType,
      bulletType,
      armorPiercing: ap,
      ...(originScalingStat != null ? { originScalingStat } : {}),
    };

    if (bulletCount > 1) {
      for (let j = bulletId; j < bulletId + bulletCount; j++) {
        const arrIndex = slotIndexWrapped(j);
        putProjectileAtSlot(arrIndex, stored);
        registerPlayerProjectile(ownerId, arrIndex, stored);
      }
    } else if (bulletId > 255 && bulletId < PROJECTILES_LEN) {
      registerPlayerProjectile(ownerId, bulletId, stored);
    } else {
      const arrIndex = slotIndexWrapped(bulletId);
      putProjectileAtSlot(arrIndex, stored);
      registerPlayerProjectile(ownerId, arrIndex, stored);
    }
  });

  // ─── TomatoData.playerShoot (local client) ────────────

  ctx.hookPacket('PLAYERSHOOT', (client, packet) => {
    touchLocalPlayer(client);
    if (!packet.isDefined || !ctx.gameData) return;

    const containerType = packet.data.containerType as number;
    const attackIndex = packet.data.attackIndex as number;
    /** Tomato PlayerShootPacket.bulletId (byte) — TomatoData.playerShoot uses direct projectiles[bulletId] + map key, not wrapped slot */
    const bulletId = (packet.data.bulletId as number) & 0xff;

    const built = buildLocalPlayerProjectileDamage(abilityScaling, {
      weaponObjectType: containerType,
      projectileIndex: attackIndex,
      gameData: ctx.gameData,
      objectDef: ctx.gameData.getObject(containerType),
      attackerStats: ctx.worldState?.getEntity(client.objectId)?.stats,
      rngNext: nextPlayerShootRng,
    });
    if (!built) return;

    let originScalingStat: number | undefined;
    try {
      const sd = abilityScaling.getScalingData(containerType);
      if (sd) {
        const n = getNumericStat(client.objectId, sd.scalingStatId);
        if (n != null) originScalingStat = n;
      }
    } catch {
      /* ignore */
    }

    const stored: StoredPlayerProjectile = {
      damage: built.damage,
      summonerId: built.summonerId,
      containerType: built.containerType,
      bulletType: built.bulletType,
      armorPiercing: built.armorPiercing,
      ...(originScalingStat != null ? { originScalingStat } : {}),
    };

    registerPlayerProjectile(client.objectId, bulletId, stored);
  });

  // ─── TomatoData.enemtyHit (all shooters) ────────────────

  ctx.hookPacket('ENEMYHIT', (client, packet) => {
    touchLocalPlayer(client);
    if (!packet.isDefined) return;

    const ownerId = packet.data.ownerId as number;
    const targetId = packet.data.targetId as number;
    const bulletId = (packet.data.bulletId as number) & 0xffff;
    const kill = packet.data.kill as boolean;

    if (targetId === client.objectId) return;
    if (!Number.isFinite(ownerId) || !Number.isFinite(targetId)) return;

    const projectile = resolveProjectileForEnemyHit(ownerId, bulletId);
    const shooterId = effectiveShooterIdFromEnemyHit(ownerId, projectile);
    rememberPendingKill(shooterId, targetId, bulletId, kill);
    touchFightTimingFromHit(targetId);

    if (!projectile || !ctx.worldState || !ctx.gameData) return;

    const tgtDef = getNumericStat(targetId, StatType.Defense) ?? 0;
    const c0 = getNumericStat(targetId, StatType.Effects) ?? 0;
    const c1 = getNumericStat(targetId, StatType.Effects2) ?? 0;

    const tin: TomatoProjectileInput = {
      damage: projectile.damage,
      summonerId: projectile.summonerId,
      containerType: projectile.containerType,
      bulletType: projectile.bulletType,
      armorPiercing: projectile.armorPiercing,
      originScalingStat: projectile.originScalingStat,
    };
    const dmg = computeUserProjectileHitDamage(abilityScaling, {
      projectile: tin,
      attackerId: shooterId,
      clientObjectId: client.objectId,
      targetDefense: tgtDef,
      targetCondition0: c0,
      targetCondition1: c1,
      getAttackerNumericStat: (sid) => getNumericStat(shooterId, sid),
      getAttackerAbilitySlot1: () => getNumericStat(shooterId, StatType.Inventory1),
      getEnchantStatDamageMultiplier: () => 1,
    });
    const summonHit = projectile.summonerId !== 0;
    if (dmg > 0) applyTomatoHit(targetId, shooterId, dmg, summonHit ? 'summon' : 'weapon');
  });

  // ─── TomatoData.damage (server totals) ────────────────

  ctx.hookPacket('DAMAGE', (client, packet) => {
    touchLocalPlayer(client);
    if (!packet.isDefined) return;
    if (!ctx.gameData || !ctx.worldState) return;

    const targetId = packet.data.targetId as number;
    const objectId = packet.data.objectId as number;
    const damageAmount = packet.data.damageAmount as number;
    let kill = packet.data.kill as boolean;
    const bulletIdRaw = packet.data.bulletId as number | undefined;
    const bulletId = Number.isFinite(bulletIdRaw as number) ? ((bulletIdRaw as number) & 0xffff) : undefined;

    if (!Number.isFinite(targetId) || !Number.isFinite(objectId) || !Number.isFinite(damageAmount)) return;

    if (damageAmount > 0) {
      applyIncomingPlayerDamage(targetId, damageAmount);
    }

    if (targetId === client.objectId) return;

    const victimType = ctx.worldState.getEntityType(targetId);
    if (victimType !== undefined && ctx.gameData.getObjectCategory(victimType) === 'Player') {
      return;
    }

    const resolvedAttackerId = resolveDamageAttackerId(objectId);
    if (resolvedAttackerId === null) return;

    if (bulletId !== undefined) {
      const pkKey = pendingKillKey(resolvedAttackerId, targetId, bulletId);
      const pending = pendingKillFromEnemyHit.get(pkKey);
      if (pending) {
        pendingKillFromEnemyHit.delete(pkKey);
        if (pending.kill && !kill) {
          packet.data.kill = true;
          kill = true;
        }
      }
    }

    if (damageAmount <= 0) return;

    const targetType = ctx.worldState.getEntityType(targetId);
    if (targetType === undefined) return;

    const target = getTargetState(targetId, targetType);
    if (kill) target.killed = true;

    const summonHit = objectId !== resolvedAttackerId;
    applyTomatoHit(targetId, resolvedAttackerId, damageAmount, summonHit ? 'summon' : 'weapon');

    if (kill && target.boss && showNotifications) {
      const players = [...target.players.values()].sort((a, b) => b.damage - a.damage);
      const total = players.reduce((s, p) => s + p.damage, 0);
      const top = players.slice(0, 5).map((p, i) => {
        const pct = total > 0 ? ((p.damage / total) * 100).toFixed(1) : '0.0';
        return `#${i + 1} ${p.name}: ${formatDmg(p.damage)} (${pct}%)`;
      });
      ctx.sendNotification(
        client,
        'Damage Sniffer',
        `${target.targetName} — ${(Math.max(0, (target.lastHitAt - target.firstHitAt) / 1000)).toFixed(1)}s | ${top.join(' | ')}`,
      );
    }
  });

  function formatDmg(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // Initialize data for dashboard access (hydration)
  ctx.setData('damageHistory', runHistory);
  ctx.setData('damageLive', serializeRunLive());

  ctx.hookCommand('ds', (client) => {
    ctx.enabled = !ctx.enabled;
    ctx.sendNotification(client, ctx.name, `Damage Sniffer ${ctx.enabled ? 'ON' : 'OFF'}`);
  });

  ctx.log(`Loaded — bossHP>=${minBossHp.toLocaleString()}, minibossHP>=${minMiniBossHp.toLocaleString()}, notifications: ${showNotifications} (/ds to toggle)`);
}
