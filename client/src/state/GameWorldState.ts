import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { ObjectCategory } from '../game-data/GameDataLoader.js';
import { StatType } from '../constants/StatType.js';

export interface TrackedEntity {
  objectId: number;
  objectType: number;
  pos: { x: number; y: number };
  lastUpdate: number;
  /** Latest Status StatData values keyed by stat id (as string). */
  stats?: Record<string, number | string>;
}

export interface PortalGroupForDashboard {
  objectType: number;
  name: string;
  entities: { objectId: number; x: number; y: number }[];
}

export interface CategoryGroupForDashboard {
  objectType: number;
  name: string;
  entities: { objectId: number; x: number; y: number; hp?: number; maxHp?: number }[];
}

export interface ObjectsForDashboardPayload {
  portals: PortalGroupForDashboard[];
  beacons: PortalGroupForDashboard[];
  categories: { category: string; groups: CategoryGroupForDashboard[] }[];
}

export interface TileGroupForDashboard {
  tileType: number;
  name: string;
  tiles: { x: number; y: number }[];
}

export interface TilesForDashboardPayload {
  center: { x: number; y: number };
  radius: number;
  groups: TileGroupForDashboard[];
}

export interface NearbyPlayerSummaryForDashboard {
  objectId: number;
  objectType: number;
  className: string;
  name: string;
  x: number;
  y: number;
  dist: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  level: number;
  fame: number;
  eq: number[]; // 4 equipped item type ids
  hpPct: number;
}

/** Every tracked player-like entity (including you) with wire StatData as string-keyed id → value. */
export interface PlayerRawStatsRowForDashboard {
  objectId: number;
  objectType: number;
  className: string;
  name: string;
  x: number;
  y: number;
  rawStats: Record<string, number | string>;
}

export interface NearestEnemyFilter {
  hpMin?: number;
  hpMax?: number;
  hpUnder?: number;
  hpOver?: number;
  /** Skip enemies whose MAX HP is below this. Filters trash mobs by tier. */
  maxHpMin?: number;
  /** Skip enemies whose MAX HP is above this. */
  maxHpMax?: number;
  /** Skip breakable scenery: blocks a square and has no projectiles of its own. */
  excludeScenery?: boolean;
  maxDistance?: number;
  /** Skip entities whose last update is older than this many ms (drops ghosts
   * that despawned or left view without a removedObjs). */
  maxStaleMs?: number;
}

/**
 * Tracks all entities (enemies, players, objects) in the current map.
 * Updated from UPDATE (newObjs/drops) and NEWTICK (position changes).
 * Used by auto-nexus (look up enemy type for projectile definitions)
 * and future plugins.
 */
export class GameWorldState {
  private entities = new Map<number, TrackedEntity>();
  // Packed tile map: key = (x << 16) | y → tile type
  private tileMap = new Map<number, number>();
  private lastMapIdentity = '';

  private buildMapIdentity(client: ClientConnection): string {
    const gameId = Number(client.state?.gameId ?? -2);
    const mapName = String(client.playerData?.mapName ?? '').trim().toLowerCase();
    return `${Number.isFinite(gameId) ? gameId : -2}|${mapName}`;
  }

  private ensureMapIdentity(client: ClientConnection): void {
    const nextIdentity = this.buildMapIdentity(client);
    if (!nextIdentity || nextIdentity === '-2|') return;
    if (this.lastMapIdentity && this.lastMapIdentity !== nextIdentity) {
      this.clear();
    }
    this.lastMapIdentity = nextIdentity;
  }

  private buildEnemyCandidate(
    gameData: GameDataLoader,
    entity: TrackedEntity,
    origin: { x: number; y: number },
  ): { objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; hpPct: number } | null {
    if (gameData.getObjectCategory(entity.objectType) !== 'Enemy') return null;

    const x = Number(entity.pos?.x);
    const y = Number(entity.pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const stats = entity.stats || {};
    const hpRaw = stats[String(StatType.HP)];
    const maxHpRaw = stats[String(StatType.MaxHP)];
    const hp = Number.isFinite(Number(hpRaw)) ? Number(hpRaw) : 0;
    const defMaxHp = gameData.getObject(entity.objectType)?.maxHp ?? 0;
    let maxHp = Number.isFinite(Number(maxHpRaw)) && Number(maxHpRaw) > 0
      ? Number(maxHpRaw)
      : defMaxHp;
    if (!Number.isFinite(maxHp) || maxHp <= 0) maxHp = Math.max(1, hp);

    const dist = Math.hypot(x - origin.x, y - origin.y);
    return {
      objectId: entity.objectId,
      objectType: entity.objectType,
      x,
      y,
      dist,
      hp,
      maxHp,
      hpPct: hp / Math.max(1, maxHp),
    };
  }

  /**
   * Walls, breakable trees and crates carry the `<Enemy>` tag and a health bar,
   * so category alone cannot tell them from a mob. What separates them is that
   * they block a square and never shoot.
   */
  private isScenery(gameData: GameDataLoader, objectType: number): boolean {
    const def = gameData.getObject(objectType);
    if (!def) return false;
    return def.occupySquare && def.projectiles.size === 0;
  }

  private passesEnemyFilter(
    gameData: GameDataLoader,
    candidate: { hp: number; maxHp: number; dist: number; objectType: number },
    filter?: NearestEnemyFilter,
  ): boolean {
    if (!filter) return true;
    if (filter.hpMin != null && candidate.hp < filter.hpMin) return false;
    if (filter.hpMax != null && candidate.hp > filter.hpMax) return false;
    if (filter.hpUnder != null && candidate.hp >= filter.hpUnder) return false;
    if (filter.hpOver != null && candidate.hp <= filter.hpOver) return false;
    if (filter.maxHpMin != null && candidate.maxHp < filter.maxHpMin) return false;
    if (filter.maxHpMax != null && candidate.maxHp > filter.maxHpMax) return false;
    if (filter.excludeScenery && this.isScenery(gameData, candidate.objectType)) return false;
    if (filter.maxDistance != null && candidate.dist > filter.maxDistance) return false;
    return true;
  }

  private isLikelyPlayerEntity(gameData: GameDataLoader, e: TrackedEntity): boolean {
    if (gameData.getObjectCategory(e.objectType) === 'Player') return true;
    const stats = e.stats || {};
    const name = stats[String(StatType.NameStat)];
    const level = Number(stats[String(StatType.Level)]);
    const eq0 = Number(stats[String(StatType.Inventory0)]);
    const eq1 = Number(stats[String(StatType.Inventory1)]);
    const eq2 = Number(stats[String(StatType.Inventory2)]);
    const eq3 = Number(stats[String(StatType.Inventory3)]);
    const hasName = typeof name === 'string' && name.trim().length > 0;
    const hasLevel = Number.isFinite(level) && level > 0;
    const hasAnyEq =
      (Number.isFinite(eq0) && eq0 !== -1) ||
      (Number.isFinite(eq1) && eq1 !== -1) ||
      (Number.isFinite(eq2) && eq2 !== -1) ||
      (Number.isFinite(eq3) && eq3 !== -1);
    return hasName && (hasLevel || hasAnyEq);
  }

  private applyStatus(entity: TrackedEntity, status: any): void {
    if (status.position) {
      entity.pos = { ...status.position };
    }
    if (status.data && Array.isArray(status.data)) {
      if (!entity.stats) entity.stats = {};
      for (const s of status.data) {
        if (s && s.id != null) {
          entity.stats[String(s.id)] = s.value as any;
        }
      }
    }
    entity.lastUpdate = Date.now();
  }

  attach(proxy: Proxy): void {
    proxy.hookPacket('UPDATE', (c, p) => this.onUpdate(c, p));
    proxy.hookPacket('NEWTICK', (c, p) => this.onNewTick(c, p));
    proxy.hookPacket('MAPINFO', (c) => {
      this.clear();
      this.lastMapIdentity = this.buildMapIdentity(c);
    });
  }

  private onUpdate(_client: ClientConnection, packet: Packet): void {
    this.ensureMapIdentity(_client);
    if (!packet.isDefined) return;

    // Track tile types from the UPDATE packet's tile array
    if (packet.data.tiles) {
      for (const tile of packet.data.tiles as Array<{ x: number; y: number; type: number }>) {
        const key = (tile.x << 16) | tile.y;
        this.tileMap.set(key, tile.type);
      }
    }

    if (packet.data.newObjs) {
      for (const entity of packet.data.newObjs) {
        const objectType = entity.objectType;
        const status = entity.status;
        if (!status) continue;

        const tracked: TrackedEntity = {
          objectId: status.objectId,
          objectType,
          pos: status.position ? { ...status.position } : { x: 0, y: 0 },
          lastUpdate: Date.now(),
          stats: undefined,
        };
        this.applyStatus(tracked, status);
        this.entities.set(status.objectId, tracked);
      }
    }

    if (packet.data.drops) {
      for (const id of packet.data.drops) {
        this.entities.delete(id);
      }
    }
  }

  private onNewTick(_client: ClientConnection, packet: Packet): void {
    this.ensureMapIdentity(_client);
    if (!packet.isDefined || !packet.data.statuses) return;

    for (const status of packet.data.statuses) {
      const entity = this.entities.get(status.objectId);
      if (!entity) continue;
      this.applyStatus(entity, status);
    }
  }

  clear(): void {
    this.entities.clear();
    this.tileMap.clear();
  }

  /** Every tile cell known from UPDATE packets (same order as internal map). */
  forEachKnownTile(visitor: (x: number, y: number, tileType: number) => void): void {
    for (const [packed, tileType] of this.tileMap.entries()) {
      const x = packed >> 16;
      const y = packed & 0xffff;
      visitor(x, y, tileType);
    }
  }

  forEachKnownTileInBounds(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    visitor: (x: number, y: number, tileType: number) => void,
  ): void {
    for (const [packed, tileType] of this.tileMap.entries()) {
      const x = packed >> 16;
      const y = packed & 0xffff;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      visitor(x, y, tileType);
    }
  }

  /**
   * Packed tile keys `(tileX << 16) | (tileY & 0xffff)` for each entity cell
   * (floored world position), matching `getTileAt` / UPDATE tile map keys.
   */
  getOccupiedTileKeys(): Set<number> {
    const s = new Set<number>();
    for (const e of this.entities.values()) {
      const x = Math.floor(e.pos.x);
      const y = Math.floor(e.pos.y);
      s.add((x << 16) | (y & 0xffff));
    }
    return s;
  }

  getEntity(objectId: number): TrackedEntity | undefined {
    return this.entities.get(objectId);
  }

  getEntityType(objectId: number): number | undefined {
    return this.entities.get(objectId)?.objectType;
  }

  /**
   * Resolve RotMG quest-target `objectType` for the live `QUESTOBJECTID` instance.
   * Uses tracked entity lookup first; if that id is missing but game data is loaded, and
   * exactly one distinct `<Quest>` object type appears among visible entities, returns that
   * type (typically only one quest marker is active nearby).
   */
  resolveQuestTargetObjectType(
    questObjectId: number,
    gameData?: GameDataLoader,
  ): number | undefined {
    if (!Number.isFinite(questObjectId) || questObjectId <= 0) return undefined;
    const direct = this.getEntityType(questObjectId);
    if (direct != null && direct > 0) return direct;
    if (!gameData) return undefined;
    const questTypes = new Set<number>();
    for (const e of this.entities.values()) {
      const def = gameData.getObject(e.objectType);
      if (def?.quest) questTypes.add(e.objectType);
    }
    if (questTypes.size !== 1) return undefined;
    return questTypes.values().next().value as number;
  }

  /** Tomato TomatoData.hasGuardedPhaseEntity (Forgotten King / walled garden). */
  hasAnyEntityObjectTypeIn(types: ReadonlySet<number>): boolean {
    for (const e of this.entities.values()) {
      if (types.has(e.objectType)) return true;
    }
    return false;
  }

  getNearestEntityByType(
    objectType: number,
    origin: { x: number; y: number },
    excludeObjectId?: number,
    maxDistance?: number,
  ): { objectId: number; x: number; y: number; dist: number } | null {
    let best: { objectId: number; x: number; y: number; dist: number } | null = null;
    for (const e of this.entities.values()) {
      if (e.objectType !== objectType) continue;
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (maxDistance != null && dist > maxDistance) continue;
      if (!best || dist < best.dist) {
        best = { objectId: e.objectId, x: e.pos.x, y: e.pos.y, dist };
      }
    }
    return best;
  }

  getEntitiesByTypeSorted(
    objectType: number,
    origin: { x: number; y: number },
    excludeObjectId?: number,
    maxDistance?: number,
  ): Array<{ objectId: number; x: number; y: number; dist: number }> {
    const matches: Array<{ objectId: number; x: number; y: number; dist: number }> = [];
    for (const e of this.entities.values()) {
      if (e.objectType !== objectType) continue;
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (maxDistance != null && dist > maxDistance) continue;
      matches.push({ objectId: e.objectId, x: e.pos.x, y: e.pos.y, dist });
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches;
  }

  /** Single-pass scan for entities whose objectType is in `typeSet`.
   *  Auto-loot calls this once per tick instead of N times for N bag types. */
  getEntitiesInTypeSet(
    typeSet: ReadonlySet<number>,
    origin: { x: number; y: number },
    excludeObjectId?: number,
    maxDistance?: number,
  ): TrackedEntity[] {
    const matches: Array<{ entity: TrackedEntity; dist: number }> = [];
    for (const e of this.entities.values()) {
      if (!typeSet.has(e.objectType)) continue;
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (maxDistance != null && dist > maxDistance) continue;
      matches.push({ entity: e, dist });
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches.map((m) => m.entity);
  }

  getFirstEntityByType(
    objectType: number,
    excludeObjectId?: number,
  ): { objectId: number; x: number; y: number } | null {
    for (const e of this.entities.values()) {
      if (e.objectType !== objectType) continue;
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      return { objectId: e.objectId, x: e.pos.x, y: e.pos.y };
    }
    return null;
  }

  getNearestPortal(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    options?: { objectType?: number; maxDistance?: number },
    excludeObjectId?: number,
  ): { objectId: number; objectType: number; x: number; y: number; dist: number } | null {
    let best: { objectId: number; objectType: number; x: number; y: number; dist: number } | null = null;
    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      if (gameData.getObjectCategory(e.objectType) !== 'Portal') continue;
      if (options?.objectType != null && e.objectType !== options.objectType) continue;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (options?.maxDistance != null && dist > options.maxDistance) continue;
      if (!best || dist < best.dist) {
        best = { objectId: e.objectId, objectType: e.objectType, x: e.pos.x, y: e.pos.y, dist };
      }
    }
    return best;
  }

  getPortalsSorted(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    options?: { objectType?: number; maxDistance?: number },
    excludeObjectId?: number,
  ): Array<{ objectId: number; objectType: number; x: number; y: number; dist: number }> {
    const matches: Array<{ objectId: number; objectType: number; x: number; y: number; dist: number }> = [];
    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      if (gameData.getObjectCategory(e.objectType) !== 'Portal') continue;
      if (options?.objectType != null && e.objectType !== options.objectType) continue;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (options?.maxDistance != null && dist > options.maxDistance) continue;
      matches.push({ objectId: e.objectId, objectType: e.objectType, x: e.pos.x, y: e.pos.y, dist });
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches;
  }

  getNearestEnemy(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    filter?: NearestEnemyFilter,
    excludeObjectId?: number,
  ): { objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number } | null {
    let best: { objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number } | null = null;

    const nowMs = Date.now();
    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      if (filter?.maxStaleMs != null && nowMs - e.lastUpdate > filter.maxStaleMs) continue;
      const candidate = this.buildEnemyCandidate(gameData, e, origin);
      if (!candidate) continue;

      if (!this.passesEnemyFilter(gameData, candidate, filter)) continue;
      if (!best || candidate.dist < best.dist) {
        best = {
          objectId: candidate.objectId,
          objectType: candidate.objectType,
          x: candidate.x,
          y: candidate.y,
          dist: candidate.dist,
          hp: candidate.hp,
          maxHp: candidate.maxHp,
        };
      }
    }

    return best;
  }

  getEnemyBySelector(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    selector: 'nearest' | 'lowesthp' | 'lowesthppct',
    filter?: NearestEnemyFilter,
    excludeObjectId?: number,
  ): { objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; hpPct: number } | null {
    let best: { objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; hpPct: number } | null = null;

    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      const candidate = this.buildEnemyCandidate(gameData, e, origin);
      if (!candidate) continue;

      if (!this.passesEnemyFilter(gameData, candidate, filter)) continue;
      if (!best) {
        best = candidate;
        continue;
      }
      if (selector === 'lowesthp') {
        if (candidate.hp < best.hp || (candidate.hp === best.hp && candidate.dist < best.dist)) best = candidate;
        continue;
      }
      if (selector === 'lowesthppct') {
        if (candidate.hpPct < best.hpPct || (candidate.hpPct === best.hpPct && candidate.dist < best.dist)) best = candidate;
        continue;
      }
      if (candidate.dist < best.dist) best = candidate;
    }

    return best;
  }

  getEnemiesMatching(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    filter?: NearestEnemyFilter,
    excludeObjectId?: number,
  ): Array<{ objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; hpPct: number }> {
    const matches: Array<{ objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; hpPct: number }> = [];
    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;
      const candidate = this.buildEnemyCandidate(gameData, e, origin);
      if (!candidate) continue;
      if (!this.passesEnemyFilter(gameData, candidate, filter)) continue;
      matches.push(candidate);
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches;
  }

  getBossEventTargetsSorted(
    gameData: GameDataLoader,
    origin: { x: number; y: number },
    options?: { objectType?: number; maxDistance?: number },
    excludeObjectId?: number,
  ): Array<{ objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; name: string }> {
    const matches: Array<{ objectId: number; objectType: number; x: number; y: number; dist: number; hp: number; maxHp: number; name: string }> = [];
    for (const e of this.entities.values()) {
      if (excludeObjectId != null && e.objectId === excludeObjectId) continue;

      const def = gameData.getObject(e.objectType);
      if (!def) continue;
      if (options?.objectType != null) {
        if (e.objectType !== options.objectType) continue;
      } else {
        const stats = e.stats || {};
        const hpRaw = stats[String(StatType.HP)];
        const maxHpRaw = stats[String(StatType.MaxHP)];
        const hp = Number.isFinite(Number(hpRaw)) ? Number(hpRaw) : 0;
        const maxHp = Number.isFinite(Number(maxHpRaw)) ? Number(maxHpRaw) : 0;
        const isBossLike = gameData.isBoss(e.objectType, 5000) || (!!def.quest && Math.max(hp, maxHp) >= 2000);
        if (!isBossLike) continue;
      }

      const stats = e.stats || {};
      const hpRaw = stats[String(StatType.HP)];
      const maxHpRaw = stats[String(StatType.MaxHP)];
      const hp = Number.isFinite(Number(hpRaw)) ? Number(hpRaw) : 0;
      const maxHp = Number.isFinite(Number(maxHpRaw)) ? Number(maxHpRaw) : 0;
      const dist = Math.hypot(e.pos.x - origin.x, e.pos.y - origin.y);
      if (options?.maxDistance != null && dist > options.maxDistance) continue;
      matches.push({
        objectId: e.objectId,
        objectType: e.objectType,
        x: e.pos.x,
        y: e.pos.y,
        dist,
        hp,
        maxHp,
        name: def.id ?? `0x${e.objectType.toString(16)}`,
      });
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches;
  }

  /** Returns the tile type at tile coordinates (floor of world position), or undefined if unknown. */
  getTileAt(tileX: number, tileY: number): number | undefined {
    return this.tileMap.get((tileX << 16) | tileY);
  }

  getNearbyTilesForDashboard(
    gameData: GameDataLoader,
    center: { x: number; y: number },
    radius = 12,
  ): TilesForDashboardPayload {
    const r = Math.max(1, Math.min(30, Math.trunc(radius)));
    const collectGroups = (origin: { x: number; y: number }): TileGroupForDashboard[] => {
      const cx = Math.floor(origin.x);
      const cy = Math.floor(origin.y);
      const groupsByType = new Map<number, { x: number; y: number }[]>();

      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          const tileType = this.getTileAt(x, y);
          if (tileType == null) continue;
          let bucket = groupsByType.get(tileType);
          if (!bucket) {
            bucket = [];
            groupsByType.set(tileType, bucket);
          }
          bucket.push({ x, y });
        }
      }

      const groups: TileGroupForDashboard[] = [];
      for (const [tileType, tiles] of groupsByType.entries()) {
        groups.push({
          tileType,
          name: gameData.getTileName(tileType),
          tiles,
        });
      }
      groups.sort((a, b) => a.tileType - b.tileType);
      return groups;
    };

    let resolvedCenter = { x: center.x, y: center.y };
    let groups = collectGroups(resolvedCenter);
    if (!groups.length && this.tileMap.size > 0) {
      let nearest: { x: number; y: number; dist: number } | null = null;
      for (const packed of this.tileMap.keys()) {
        const x = packed >> 16;
        const y = packed & 0xffff;
        const dist = Math.hypot(x - center.x, y - center.y);
        if (!nearest || dist < nearest.dist) {
          nearest = { x, y, dist };
        }
      }
      if (nearest) {
        resolvedCenter = { x: nearest.x, y: nearest.y };
        groups = collectGroups(resolvedCenter);
      }
    }

    return {
      center: resolvedCenter,
      radius: r,
      groups,
    };
  }

  getEntitiesInRadius(
    pos: { x: number; y: number },
    radius: number,
  ): TrackedEntity[] {
    const r2 = radius * radius;
    const result: TrackedEntity[] = [];
    for (const entity of this.entities.values()) {
      const dx = entity.pos.x - pos.x;
      const dy = entity.pos.y - pos.y;
      if (dx * dx + dy * dy <= r2) {
        result.push(entity);
      }
    }
    return result;
  }

  get entityCount(): number {
    return this.entities.size;
  }

  /**
   * Returns objects for dashboard in RotmgPlayer-style order: Portals first,
   * then Beacons, then categories (Visual Only, Pets, Projectiles, Containers, Enemies, Other). Names from game data.
   */
  getObjectsForDashboard(gameData: GameDataLoader): ObjectsForDashboardPayload {
    const byType = new Map<number, TrackedEntity[]>();
    for (const entity of this.entities.values()) {
      const cat = gameData.getObjectCategory(entity.objectType);
      if (cat === 'Player') continue;
      let list = byType.get(entity.objectType);
      if (!list) {
        list = [];
        byType.set(entity.objectType, list);
      }
      list.push(entity);
    }

    const portals: PortalGroupForDashboard[] = [];
    const beacons: PortalGroupForDashboard[] = [];
    const byCategory = new Map<ObjectCategory, Map<number, TrackedEntity[]>>();
    for (const [objectType, entities] of byType.entries()) {
      const cat = gameData.getObjectCategory(objectType);
      if (cat === 'Portal') {
        const def = gameData.getObject(objectType);
        const name = def?.id ?? `0x${objectType.toString(16)}`;
        portals.push({
          objectType,
          name,
          entities: entities.map((e) => ({ objectId: e.objectId, x: e.pos.x, y: e.pos.y })),
        });
      } else if (cat === 'Beacon') {
        const def = gameData.getObject(objectType);
        const name = def?.id ?? `0x${objectType.toString(16)}`;
        beacons.push({
          objectType,
          name,
          entities: entities.map((e) => ({ objectId: e.objectId, x: e.pos.x, y: e.pos.y })),
        });
      } else {
        let typeMap = byCategory.get(cat);
        if (!typeMap) {
          typeMap = new Map();
          byCategory.set(cat, typeMap);
        }
        typeMap.set(objectType, entities);
      }
    }

    const categoryOrder: ObjectCategory[] = ['VisualOnly', 'Pet', 'Projectile', 'Container', 'Enemy', 'Other'];
    const categoryLabels: Record<ObjectCategory, string> = {
      Portal: 'Portals',
      Beacon: 'Beacons',
      VisualOnly: 'Visual Only',
      Pet: 'Pets',
      Player: 'Players',
      Projectile: 'Projectiles',
      Container: 'Containers',
      Enemy: 'Enemies',
      Other: 'Other',
    };
    const categories: { category: string; groups: CategoryGroupForDashboard[] }[] = [];
    for (const cat of categoryOrder) {
      const typeMap = byCategory.get(cat);
      if (!typeMap || typeMap.size === 0) continue;
      const groups: CategoryGroupForDashboard[] = [];
      const includeHp = cat === 'Enemy';
      for (const [objectType, entities] of typeMap.entries()) {
        const def = gameData.getObject(objectType);
        const name = def?.id ?? `0x${objectType.toString(16)}`;
        // Max HP from game data (like RotmgPlayer/damage-sniffer); current HP from Status stat id 1 (HPSTAT)
        const defMaxHp = def?.maxHp ?? 0;
        groups.push({
          objectType,
          name,
          entities: entities.map((e) => {
            const out: { objectId: number; x: number; y: number; hp?: number; maxHp?: number } = {
              objectId: e.objectId,
              x: e.pos.x,
              y: e.pos.y,
            };
            if (includeHp) {
              out.maxHp = defMaxHp;
              if (e.stats) {
                const hpVal = e.stats[String(StatType.HP)];
                if (hpVal != null && hpVal !== '') out.hp = Number(hpVal);
                const maxHpStat = e.stats[String(StatType.MaxHP)];
                if (maxHpStat != null && maxHpStat !== '' && Number(maxHpStat) > 0)
                  out.maxHp = Number(maxHpStat);
              }
            }
            return out;
          }),
        });
      }
      groups.sort((a, b) => a.objectType - b.objectType);
      categories.push({ category: categoryLabels[cat], groups });
    }
    portals.sort((a, b) => a.objectType - b.objectType);
    beacons.sort((a, b) => a.objectType - b.objectType);
    return { portals, beacons, categories };
  }

  /**
   * Returns nearby players (excluding you) with RotmgPlayer-style fields:
   * name, distance, HP, MP, level, fame, equipped.
   */
  getNearbyPlayersForDashboard(
    gameData: GameDataLoader,
    myPos: { x: number; y: number } | null,
    myObjectId: number | null,
  ): NearbyPlayerSummaryForDashboard[] {
    const mx = myPos?.x ?? 0;
    const my = myPos?.y ?? 0;

    const result: NearbyPlayerSummaryForDashboard[] = [];
    for (const e of this.entities.values()) {
      if (myObjectId != null && e.objectId === myObjectId) continue;
      if (!this.isLikelyPlayerEntity(gameData, e)) continue;

      const stats = e.stats || {};
      const getNum = (id: number, def = 0): number => {
        const v = stats[String(id)];
        if (v == null || v === '') return def;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : def;
      };
      const getStr = (id: number, def = ''): string => {
        const v = stats[String(id)];
        if (v == null) return def;
        return String(v);
      };

      const x = e.pos?.x ?? 0;
      const y = e.pos?.y ?? 0;
      const dist = Math.hypot(x - mx, y - my);

      const hp = getNum(1, 0);
      const maxHp = getNum(0, 0);
      const mp = getNum(4, 0);
      const maxMp = getNum(3, 0);
      const hpPct = hp / Math.max(1, maxHp);

      const level = getNum(7, 0);
      const fame = getNum(39, 0);
      const name = (getStr(31, '') || '').trim() || '?';
      const className = gameData.getObject(e.objectType)?.id ?? `0x${e.objectType.toString(16)}`;

      const eq = [getNum(8, -1), getNum(9, -1), getNum(10, -1), getNum(11, -1)];

      result.push({
        objectId: e.objectId,
        objectType: e.objectType,
        className,
        name,
        x,
        y,
        dist,
        hp,
        maxHp,
        mp,
        maxMp,
        level,
        fame,
        eq,
        hpPct,
      });
    }

    result.sort((a, b) => a.dist - b.dist);
    return result;
  }

  /**
   * All player-like entities currently tracked (including local), each with the latest
   * `stats` map from Status packets (same keys as on the wire: stat id as string).
   */
  getAllPlayersRawStatsForDashboard(gameData: GameDataLoader): PlayerRawStatsRowForDashboard[] {
    const rows: PlayerRawStatsRowForDashboard[] = [];
    for (const e of this.entities.values()) {
      if (!this.isLikelyPlayerEntity(gameData, e)) continue;
      const stats = e.stats || {};
      const getStr = (id: number, def = ''): string => {
        const v = stats[String(id)];
        if (v == null) return def;
        return String(v);
      };
      const name = (getStr(StatType.NameStat, '') || '').trim() || '?';
      const className = gameData.getObject(e.objectType)?.id ?? `0x${e.objectType.toString(16)}`;
      const x = e.pos?.x ?? 0;
      const y = e.pos?.y ?? 0;
      const rawStats: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(stats)) {
        rawStats[k] = v as number | string;
      }
      rows.push({
        objectId: e.objectId,
        objectType: e.objectType,
        className,
        name,
        x,
        y,
        rawStats,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.objectId - b.objectId);
    return rows;
  }

  /** Returns full debug data for a player objectId (or null if missing). */
  getNearbyPlayerDebugForDashboard(
    gameData: GameDataLoader,
    myPos: { x: number; y: number } | null,
    objectId: number,
  ): any | null {
    const e = this.entities.get(objectId);
    if (!e) return null;
    if (!this.isLikelyPlayerEntity(gameData, e)) return null;

    const stats = e.stats || {};
    const getNum = (id: number, def = 0): number => {
      const v = stats[String(id)];
      if (v == null || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : def;
    };
    const getStr = (id: number, def = ''): string => {
      const v = stats[String(id)];
      if (v == null) return def;
      return String(v);
    };

    const mx = myPos?.x ?? 0;
    const my = myPos?.y ?? 0;
    const x = e.pos?.x ?? 0;
    const y = e.pos?.y ?? 0;
    const dist = Math.hypot(x - mx, y - my);

    const className = gameData.getObject(e.objectType)?.id ?? `0x${e.objectType.toString(16)}`;
    const name = (getStr(31, '') || '').trim() || '?';

    // Common fields (many are optional depending on server packet content)
    const debug = {
      identity: {
        name,
        className,
        objectId: e.objectId,
        objectType: e.objectType,
        objectTypeHex: `0x${e.objectType.toString(16)}`,
        accountId: getStr(38, ''),
        guildName: getStr(62, ''),
        guildRank: getNum(63, 0),
        skin: getNum(76, 0),
        hasBackpack: getNum(130, 0) !== 0 || getNum(75, 0) !== 0,
        backpackTier: getNum(130, 0),
        hasBackpackExtender: getNum(130, 0) >= 16,
      },
      position: {
        x,
        y,
        dist,
      },
      vitals: {
        hp: getNum(1, 0),
        maxHp: getNum(0, 0),
        mp: getNum(4, 0),
        maxMp: getNum(3, 0),
      },
      stats: {
        atk: getNum(20, 0),
        def: getNum(21, 0),
        spd: getNum(22, 0),
        dex: getNum(28, 0),
        vit: getNum(26, 0),
        wis: getNum(27, 0),
      },
      boosts: {
        hpBonus: getNum(46, 0),
        mpBonus: getNum(47, 0),
        atkBonus: getNum(48, 0),
        defBonus: getNum(49, 0),
        spdBonus: getNum(50, 0),
        vitBonus: getNum(51, 0),
        wisBonus: getNum(52, 0),
        dexBonus: getNum(53, 0),
      },
      misc: {
        level: getNum(7, 0),
        fame: getNum(39, 0),
        stars: getNum(30, 0),
        credits: getNum(34, 0),
        sinkLevel: 0,
      },
      inventory: {
        equipped: [getNum(8, -1), getNum(9, -1), getNum(10, -1), getNum(11, -1)],
        inventory: Array.from({ length: 12 }).map((_, i) => getNum(8 + i, -1)),
        backpack: Array.from({ length: 16 }).map((_, i) => getNum(131 + i, -1)),
        quickSlots: [getNum(116, -1), getNum(117, -1), getNum(118, -1)],
        healthStackCount: getNum(73, 0),
        magicStackCount: getNum(74, 0),
      },
      effects: {
        effects1: getNum(29, 0),
        effects2: getNum(95, 0),
      },
      rawStats: stats,
    };

    return debug;
  }
}
