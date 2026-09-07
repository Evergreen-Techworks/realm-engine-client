import { readFileSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import type { Item } from '@realmengine/sdk';
import { Logger } from '../util/Logger.js';

export interface ProjectileDef {
  id: number;
  damage: number;
  speed: number;
  lifetimeMs: number;
  /** Collision radius in tiles (scaled from XML <Size>, base 0.15 at size 100). */
  hitRadius: number;
  armorPiercing: boolean;
  multiHit: boolean;
  passesCover: boolean;
  maxHealthDamage: number;
  conditionEffects: { effect: string; durationSec: number }[];
  // Movement pattern properties (from game client Projectile.as)
  amplitude: number;
  frequency: number;
  magnitude: number;
  wavy: boolean;
  parametric: boolean;
  boomerang: boolean;
  acceleration: number;
  accelerationDelay: number;
  speedClamp: number;
}

export type ObjectCategory =
  | 'Portal'
  | 'Beacon'
  | 'VisualOnly'
  | 'Pet'
  | 'Player'
  | 'Projectile'
  | 'Container'
  | 'Enemy'
  | 'Other';

export interface ObjectDef {
  biome?: string;
  group?: string;
  type: number;
  id: string;
  displayId: string;
  objectClass: string;
  minimapIcon?: string;
  minimapColor?: number;
  isEventBoss?: boolean;
  textureFile: string;
  textureIndex: number;
  projectiles: Map<number, ProjectileDef>;
  maxHp: number;
  defense: number;
  quest: boolean;
  god: boolean;
  // Weapon/equipment properties
  rateOfFire: number;
  numProjectiles: number;
  arcGap: number;
  slotType: number;
  burstCount: number;   // >0 if weapon has <BurstCount> (burst weapon)
  occupySquare: boolean; // true if object has <OccupySquare> (blocks pathfinding)
  protectFromGroundDamage: boolean;
  isEnemy: boolean;     // true if object has <Enemy> tag
  isPet: boolean;
  isPlayer: boolean;
  isContainer: boolean;
  /** Raw `<Tier>` text from objects.xml (numeric tier, UT, ST, …). */
  tierStr: string;
  /** `<DungeonName>` from portal objects — the dungeon this portal leads to. */
  dungeonName: string;
  bagType: number;
  soulbound: boolean;
  feedPower: number;
  quickslotAllowed: boolean;
  /**
   * For `<Class>Player</Class>` + `<Player />` objects: `max` from the eight class stat
   * tags in objects.xml (8/8 caps). Omitted for non-class objects.
   */
  playerStatMaxes?: PlayerClassStatMaxes;
}

/**
 * The eight per-class `max` attributes from objects.xml (Game Wiki "Players" category).
 * HpRegen / MpRegen are VIT / WIS class caps.
 */
export interface PlayerClassStatMaxes {
  maxHitPoints: number;
  maxMagicPoints: number;
  attack: number;
  defense: number;
  speed: number;
  dexterity: number;
  hpRegen: number;
  mpRegen: number;
}

/** Read the `max` attribute from a fast-xml-parser stat node, or 0. */
function readXmlStatMaxField(node: unknown): number {
  if (node == null) return 0;
  if (typeof node === 'string' || typeof node === 'number') return 0;
  if (Array.isArray(node)) return readXmlStatMaxField(node[0]);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const m = o['@_max'];
    if (m != null && m !== '') {
      const n = Number(m);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  return 0;
}

function parsePlayerClassStatMaxes(
  obj: Record<string, unknown>,
): PlayerClassStatMaxes {
  return {
    maxHitPoints: readXmlStatMaxField(obj.MaxHitPoints),
    maxMagicPoints: readXmlStatMaxField(obj.MaxMagicPoints),
    attack: readXmlStatMaxField(obj.Attack),
    defense: readXmlStatMaxField(obj.Defense),
    speed: readXmlStatMaxField(obj.Speed),
    dexterity: readXmlStatMaxField(obj.Dexterity),
    hpRegen: readXmlStatMaxField(obj.HpRegen),
    mpRegen: readXmlStatMaxField(obj.MpRegen),
  };
}

function readFirstTextureFile(
  textureNode: unknown,
): string {
  if (textureNode == null) return '';
  if (Array.isArray(textureNode)) {
    for (const item of textureNode) {
      const file = readFirstTextureFile(item);
      if (file) return file;
    }
    return '';
  }
  if (typeof textureNode !== 'object') return '';
  const file = (textureNode as Record<string, unknown>).File;
  return typeof file === 'string' ? file.trim() : '';
}

function readFirstTextureIndex(
  textureNode: unknown,
): number {
  if (textureNode == null) return -1;
  if (Array.isArray(textureNode)) {
    for (const item of textureNode) {
      const index = readFirstTextureIndex(item);
      if (index >= 0) return index;
    }
    return -1;
  }
  if (typeof textureNode !== 'object') return -1;
  const index = Number((textureNode as Record<string, unknown>).Index);
  return Number.isFinite(index) ? index : -1;
}

/** RotMG `SlotType` → SDK `Item.slotType` (same buckets as plugins/auto-loot). */
const WEAPON_SLOT_TYPES = new Set<number>([1, 2, 3, 8, 17, 24]);
const ABILITY_SLOT_TYPES = new Set<number>([4, 5, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30]);
const ARMOR_SLOT_TYPES = new Set<number>([6, 7, 14]);
const RING_SLOT_TYPES = new Set<number>([9]);

function rotmgSlotTypeToSdkItemSlotType(slotType: number): Item['slotType'] {
  if (!Number.isFinite(slotType) || slotType < 0) return 'consumable';
  if (WEAPON_SLOT_TYPES.has(slotType)) return 'weapon';
  if (ABILITY_SLOT_TYPES.has(slotType)) return 'ability';
  if (ARMOR_SLOT_TYPES.has(slotType)) return 'armor';
  if (RING_SLOT_TYPES.has(slotType)) return 'ring';
  return 'consumable';
}

export interface TilePushVector {
  dx: number;
  dy: number;
}

/** Slim object row for the dev dashboard Game Wiki (no projectiles on the wire). */
export interface GameWikiObjectSummary {
  type: number;
  typeHex: string;
  id: string;
  displayId: string;
  objectClass: string;
  category: ObjectCategory;
  maxHp: number;
  defense: number;
  quest: boolean;
  god: boolean;
  rateOfFire: number;
  numProjectiles: number;
  arcGap: number;
  slotType: number;
  burstCount: number;
  occupySquare: boolean;
  isEnemy: boolean;
  isPet: boolean;
  isPlayer: boolean;
  isContainer: boolean;
  /** `<DungeonName>` from portal objects — the dungeon this portal leads to. */
  dungeonName: string;
  /** Parsed 8/8 class caps (Player category in Game Wiki) when present. */
  playerStatMaxes?: PlayerClassStatMaxes;
}

/** Heavy fields for Game Wiki detail pane (keyed by object type as decimal string). */
export interface GameWikiObjectDetail {
  projectiles: ProjectileDef[];
}

/** One ground type row for Game Wiki (from tiles.xml-derived state). */
export interface GameWikiTileRow {
  type: number;
  typeHex: string;
  id: string;
  noWalk: boolean;
  sink: boolean;
  speed: number;
  slideAmount?: number;
  damagePerTick?: number;
  hasDamageAttrs: boolean;
  hasConditionEffect: boolean;
  hasPush: boolean;
  pushDx?: number;
  pushDy?: number;
  /** Primary bucket for filtering (first match in wiki-style priority). */
  tileBucket: string;
}

/**
 * Parses objects.xml to extract enemy/projectile definitions.
 * Used by auto-nexus (armor piercing lookup) and future plugins needing game data.
 */
export class GameDataLoader {
  private objects = new Map<number, ObjectDef>();
  private tileSpeedMap = new Map<number, number>();
  private tileNameMap = new Map<number, string>();
  private tileTypeByNameMap = new Map<string, number>();
  private tilePushTypes = new Set<number>();
  private objectRawXmlMap = new Map<number, string>();
  private tileRawXmlMap = new Map<number, string>();

  load(xmlPath: string): void {
    const xml = readFileSync(xmlPath, 'utf8');
    // load() is also used after the dashboard game updater refreshes XML.
    // Remove definitions deleted by a new build instead of retaining stale rows.
    this.objects.clear();
    this.objectRawXmlMap.clear();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) =>
        name === 'Object' || name === 'Projectile' || name === 'ConditionEffect',
    });

    const parsed = parser.parse(xml);
    const objects = parsed.Objects?.Object ?? [];

    for (const obj of objects) {
      const typeStr = obj['@_type'] as string;
      if (!typeStr) continue;
      const type = parseInt(typeStr, 16);
      const id = (obj['@_id'] as string) ?? '';
      const displayId = String(obj.DisplayId ?? '').trim();
      const objectClass = obj.Class ?? '';

      const def: ObjectDef = {
        type,
        id,
        displayId,
        objectClass,
        minimapIcon: String(obj.MinimapIcon?.['@_piece'] ?? ''),
        minimapColor: obj.Color === undefined ? undefined : Number(obj.Color),
        isEventBoss: String(obj.MinimapIcon?.['@_piece'] ?? '') === 'Boss'
          // Untinted Boss icons use the default marker; MV shrine uses an off-white tint.
          && (obj.Color === undefined || [0x8f04a8, 0x1b006d, 0xffffff, 0xd6d6bf].includes(Number(obj.Color))),
        biome: String(obj.Terrain ?? obj.RealmScore?.Biome ?? '').trim(),
        group: String(obj.Group ?? '').trim(),
        textureFile: readFirstTextureFile(obj.Texture),
        textureIndex: readFirstTextureIndex(obj.Texture),
        projectiles: new Map(),
        maxHp: Number(obj.MaxHitPoints ?? 0),
        defense: Number(obj.Defense ?? 0),
        quest: obj.Quest !== undefined,
        god: obj.God !== undefined,
        rateOfFire: Number(obj.RateOfFire ?? 1),
        numProjectiles: Number(obj.NumProjectiles ?? 1),
        arcGap: Number(obj.ArcGap ?? 0),
        slotType: Number(obj.SlotType ?? -1),
        burstCount: Number(obj.BurstCount ?? 0),
        occupySquare: obj.OccupySquare !== undefined,
        protectFromGroundDamage: obj.ProtectFromGroundDamage !== undefined,
        isEnemy: obj.Enemy !== undefined,
        isPet: obj.Pet !== undefined,
        isPlayer: obj.Player !== undefined,
        isContainer: obj.Container !== undefined,
        tierStr: String(obj.Tier ?? '').trim(),
        bagType: (() => {
          const v = Number(obj.BagType);
          return Number.isFinite(v) ? v : 0;
        })(),
        soulbound: obj.Soulbound !== undefined,
        feedPower: Number(obj.FeedPower ?? 0),
        quickslotAllowed: obj.QuickslotAllowed !== undefined,
        dungeonName: String(obj.DungeonName ?? '').trim(),
      };

      if (obj.Projectile) {
        const projs = Array.isArray(obj.Projectile)
          ? obj.Projectile
          : [obj.Projectile];

        for (const proj of projs) {
          const projId = Number(proj['@_id'] ?? 0);
          const rawSize = Number(proj.Size ?? 100);
          const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 100;
          const hitRadius = 0.15 * (size / 100);

          const conditionEffects: { effect: string; durationSec: number }[] = [];
          if (proj.ConditionEffect) {
            const effects = Array.isArray(proj.ConditionEffect)
              ? proj.ConditionEffect
              : [proj.ConditionEffect];
            for (const ce of effects) {
              const effectName =
                typeof ce === 'string' ? ce : (ce['#text'] ?? '');
              const duration =
                typeof ce === 'object' ? Number(ce['@_duration'] ?? 0) : 0;
              if (effectName) {
                conditionEffects.push({ effect: effectName, durationSec: duration });
              }
            }
          }

          def.projectiles.set(projId, {
            id: projId,
            damage: Number(proj.Damage ?? 0),
            speed: Number(proj.Speed ?? 0),
            lifetimeMs: Number(proj.LifetimeMS ?? 0),
            hitRadius,
            armorPiercing: proj.ArmorPiercing !== undefined,
            multiHit: proj.MultiHit !== undefined,
            passesCover: proj.PassesCover !== undefined,
            maxHealthDamage: Number(proj.MaxHealthDamage ?? 0),
            conditionEffects,
            amplitude: Number(proj.Amplitude ?? 0),
            frequency: Number(proj.Frequency ?? 0),
            magnitude: Number(proj.Magnitude ?? 3),
            wavy: proj.Wavy !== undefined,
            parametric: proj.Parametric !== undefined,
            boomerang: proj.Boomerang !== undefined,
            acceleration: Number(proj.Acceleration ?? 0),
            accelerationDelay: Number(proj.AccelerationDelay ?? 0),
            speedClamp: Number(proj.SpeedClamp ?? 0),
          });
        }
      }

      if (def.isPlayer) {
        def.playerStatMaxes = parsePlayerClassStatMaxes(
          obj as Record<string, unknown>,
        );
      }

      this.objects.set(type, def);
    }

    const projCount = [...this.objects.values()].reduce(
      (n, o) => n + o.projectiles.size,
      0,
    );
    const playerWithCaps = [...this.objects.values()].filter(
      (o) => o.isPlayer && o.playerStatMaxes,
    ).length;
    Logger.log(
      'GameData',
      `Loaded ${this.objects.size} objects, ${projCount} projectile definitions, ${playerWithCaps} player class(es) with stat maxes`,
    );

    // Extract raw XML snippet per Object for wiki display
    this.objectRawXmlMap.clear();
    const objRe = /<Object\b[^>]*>([\s\S]*?)<\/Object>/g;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(xml)) !== null) {
      const typeAttr = om[0].match(/\btype="([^"]+)"/);
      if (typeAttr) {
        const t = parseInt(typeAttr[1], 16);
        if (Number.isFinite(t)) this.objectRawXmlMap.set(t, om[0]);
      }
    }
  }

  getObject(type: number): ObjectDef | undefined {
    return this.objects.get(type);
  }

  /**
   * Eight class stat `max` values from objects.xml (HP, MP, ATK, DEF, SPD, DEX, VIT, WIS)
   * for a player class `type` (e.g. `PlayerData.classType`). Undefined if not a class object.
   */
  getPlayerClassStatMaxes(type: number): PlayerClassStatMaxes | undefined {
    return this.objects.get(type)?.playerStatMaxes;
  }

  /** Decimal object types for every entry in the Game Wiki "Players" filter (has `playerStatMaxes`). */
  getAllPlayerClassObjectTypes(): number[] {
    const out: number[] = [];
    for (const o of this.objects.values()) {
      if (o.isPlayer && o.playerStatMaxes) out.push(o.type);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  getRawObjectXml(type: number): string | undefined {
    return this.objectRawXmlMap.get(type);
  }

  getRawTileXml(type: number): string | undefined {
    return this.tileRawXmlMap.get(type);
  }

  /**
   * Build an SDK `Item` from objects.xml (for scripts: equipped gear, etc.).
   * Returns null for empty / invalid type ids; unknown types not in xml fall back to a minimal item.
   */
  buildSdkItem(objectType: number): Item | null {
    if (!Number.isFinite(objectType) || objectType <= 0) return null;
    const def = this.objects.get(objectType);
    if (!def) {
      return {
        id: objectType,
        name: `0x${objectType.toString(16)}`,
        tier: '',
        slotType: 'consumable',
        feedPower: 0,
        bagType: 0,
        soulbound: false,
        tradeable: true,
      };
    }
    const soulbound = def.soulbound;
    return {
      id: objectType,
      name: def.displayId || def.id || `0x${objectType.toString(16)}`,
      tier: def.tierStr,
      slotType: rotmgSlotTypeToSdkItemSlotType(def.slotType),
      feedPower: def.feedPower,
      bagType: def.bagType,
      soulbound,
      tradeable: !soulbound,
    };
  }

  getAllObjects(): ObjectDef[] {
    return [...this.objects.values()];
  }

  /** Category for dashboard object tree (Portals, Beacons, then Visual Only, Pets, Projectiles, Containers, Enemies, Other). */
  getObjectCategory(type: number): ObjectCategory {
    const def = this.objects.get(type);
    if (!def) return 'Other';
    const c = def.objectClass;
    if (c === 'Portal' || c === 'ArenaPortal' || c === 'GuildHallPortal' || c.includes('Portal')) return 'Portal';
    if (def.id && def.id.toLowerCase().includes('beacon')) return 'Beacon';
    if (def.isPet || c === 'Pet') return 'Pet';
    if (def.isPlayer || c === 'Player') return 'Player';
    if (c === 'Projectile') return 'Projectile';
    if (def.isContainer || c === 'Container') return 'Container';
    if (def.isEnemy || c === 'Enemy') return 'Enemy';
    // "Visual Only" = known objects that are not entities/containers and do not block movement.
    // This is intentionally conservative: it keeps blockers (OccupySquare) and unknowns in "Other".
    if (!def.occupySquare && (c === 'GameObject' || c === 'Decoration' || c === 'Decoy')) return 'VisualOnly';
    return 'Other';
  }

  getProjectile(
    objectType: number,
    projectileId: number,
  ): ProjectileDef | undefined {
    return this.objects.get(objectType)?.projectiles.get(projectileId);
  }

  /** Returns every beacon object type defined in objects.xml, with display name. */
  getBeaconTypes(): { objectType: number; name: string }[] {
    const out: { objectType: number; name: string }[] = [];
    for (const obj of this.objects.values()) {
      if (this.getObjectCategory(obj.type) !== 'Beacon') continue;
      out.push({ objectType: obj.type, name: obj.id || `0x${obj.type.toString(16)}` });
    }
    out.sort((a, b) => a.name.localeCompare(b.name) || (a.objectType - b.objectType));
    return out;
  }

  /** Check if an object type is a boss (Quest tag + HP threshold). */
  isBoss(objectType: number, minHp = 10000): boolean {
    const obj = this.objects.get(objectType);
    if (!obj) return false;
    return obj.quest && obj.maxHp >= minHp;
  }

  /** Returns the set of object types that have <OccupySquare> (block pathfinding). */
  getOccupySquareTypes(): Set<number> {
    const result = new Set<number>();
    for (const obj of this.objects.values()) {
      if (obj.occupySquare) result.add(obj.type);
    }
    return result;
  }

  /** Returns the set of object types that are enemies (have <Enemy> tag). */
  getEnemyTypes(): Set<number> {
    const result = new Set<number>();
    for (const obj of this.objects.values()) {
      if (obj.isEnemy) result.add(obj.type);
    }
    return result;
  }

  private tileDamageMap = new Map<number, number>();
  private tileMinDamageSet = new Set<number>();
  private tileSlideAmountMap = new Map<number, number>();
  private tilePushVectorMap = new Map<number, TilePushVector>();
  /** Tile defines `<MinDamage>` and/or `<MaxDamage>` in tiles.xml (any value). */
  private tileHasDamageAttrs = new Set<number>();
  /** Tile defines `<ConditionEffect>` in tiles.xml. */
  private tileHasConditionEffect = new Set<number>();
  /** Ground types with `<NoWalk />` or space (from tiles.xml). */
  private noWalkTileTypes = new Set<number>();
  /** Ground types with `<Sink />`. */
  private sinkTileTypes = new Set<number>();

  /**
   * Parse tiles.xml and return tile walkability sets plus speed multipliers.
   * noWalkTiles:  tiles with <NoWalk /> — completely impassable
   * sinkTiles:    tiles with <Sink />   — hazardous, also treated as impassable
   * tileSpeedMap: tile type → speed multiplier (default 1.0 if no <Speed> tag)
   *               Values <1.0 = slower (quicksand, water floor), >1.0 = faster (pathways)
   * tileDamageMap: tile type → damage per tick (from MinDamage/MaxDamage, 0 if not damaging)
   */
  loadTiles(tilesXmlPath: string): {
    noWalkTiles:  Set<number>;
    sinkTiles:    Set<number>;
    tileSpeedMap: Map<number, number>;
    tileDamageMap: Map<number, number>;
    tileSlideAmountMap: Map<number, number>;
    tilePushTypes: Set<number>;
    tilePushVectorMap: Map<number, TilePushVector>;
  } {
    const noWalkTiles  = new Set<number>();
    const sinkTiles    = new Set<number>();
    this.tileSpeedMap = new Map<number, number>();
    this.tileNameMap = new Map<number, string>();
    this.tileTypeByNameMap = new Map<string, number>();
    this.tilePushTypes = new Set<number>();
    this.tileDamageMap = new Map<number, number>();
    this.tileMinDamageSet = new Set<number>();
    this.tileSlideAmountMap = new Map<number, number>();
    this.tilePushVectorMap = new Map<number, TilePushVector>();
    this.tileHasDamageAttrs = new Set<number>();
    this.tileHasConditionEffect = new Set<number>();

    try {
      const xml = readFileSync(tilesXmlPath, 'utf8');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name) => name === 'Ground',
      });

      const parsed = parser.parse(xml);
      const grounds: any[] = parsed.GroundTypes?.Ground ?? [];

      for (const ground of grounds) {
        const typeStr = ground['@_type'] as string | undefined;
        if (!typeStr) continue;
        const type = parseInt(typeStr, 16);
        if (isNaN(type)) continue;
        const id = String(ground['@_id'] ?? '').trim();

        if (id) {
          this.tileNameMap.set(type, id);
          this.tileTypeByNameMap.set(id.toLowerCase(), type);
        }
        if (ground.Push !== undefined) {
          this.tilePushTypes.add(type);
          const pushVector = this.extractPushVectorFromGround(ground, id);
          if (pushVector) this.tilePushVectorMap.set(type, pushVector);
        }

        if (ground.NoWalk !== undefined) noWalkTiles.add(type);
        if (ground.Sink   !== undefined) sinkTiles.add(type);
        if (type === 254 || id.toLowerCase() === 'space') noWalkTiles.add(type);

        const speed = Number(ground.Speed ?? 0);
        if (speed > 0 && speed !== 1.0) this.tileSpeedMap.set(type, speed);

        const slideAmount = Number(ground.SlideAmount ?? 0);
        if (slideAmount > 0) this.tileSlideAmountMap.set(type, slideAmount);

        // Tile damage: use MaxDamage (tiles have fixed damage, min==max in practice)
        const maxDmg = Number(ground.MaxDamage ?? ground.MinDamage ?? 0);
        if (maxDmg > 0) this.tileDamageMap.set(type, maxDmg);

        const minDmg = Number(ground.MinDamage ?? 0);
        if (minDmg > 0) this.tileMinDamageSet.add(type);

        if (ground.MinDamage !== undefined || ground.MaxDamage !== undefined) {
          this.tileHasDamageAttrs.add(type);
        }
        if (ground.ConditionEffect !== undefined) {
          this.tileHasConditionEffect.add(type);
        }
      }
      // Extract raw XML snippet per Ground for wiki display
      this.tileRawXmlMap.clear();
      const groundRe = /<Ground\b[^>]*>([\s\S]*?)<\/Ground>/g;
      let gm: RegExpExecArray | null;
      while ((gm = groundRe.exec(xml)) !== null) {
        const typeAttr = gm[0].match(/\btype="([^"]+)"/);
        if (typeAttr) {
          const t = parseInt(typeAttr[1], 16);
          if (Number.isFinite(t)) this.tileRawXmlMap.set(t, gm[0]);
        }
      }
    } catch (err) {
      Logger.warn('GameData', `Failed to load tiles: ${(err as Error).message}`);
    }

    this.noWalkTileTypes = noWalkTiles;
    this.sinkTileTypes = sinkTiles;

    Logger.log(
      'GameData',
      `Tiles loaded - noWalk: ${noWalkTiles.size}, sink: ${sinkTiles.size}, speed variants: ${this.tileSpeedMap.size}, sliding: ${this.tileSlideAmountMap.size}, push: ${this.tilePushTypes.size}, push-vectors: ${this.tilePushVectorMap.size}, damaging: ${this.tileDamageMap.size}, damageAttrs: ${this.tileHasDamageAttrs.size}, conditionTiles: ${this.tileHasConditionEffect.size}`,
    );
    return {
      noWalkTiles,
      sinkTiles,
      tileSpeedMap: this.tileSpeedMap,
      tileDamageMap: this.tileDamageMap,
      tileSlideAmountMap: this.tileSlideAmountMap,
      tilePushTypes: this.tilePushTypes,
      tilePushVectorMap: this.tilePushVectorMap,
    };
  }

  /** True when tiles.xml marks the type as NoWalk or space (impassable). */
  tileIsNoWalk(tileType: number): boolean {
    return this.noWalkTileTypes.has(tileType);
  }

  /** True when tiles.xml marks the type as Sink (hazardous / impassable for pathing). */
  tileIsSink(tileType: number): boolean {
    return this.sinkTileTypes.has(tileType);
  }

  /** NoWalk, Sink, or otherwise blocking walk (matches pathfinding blocking tiles). */
  tileIsBlockingWalk(tileType: number): boolean {
    return this.noWalkTileTypes.has(tileType) || this.sinkTileTypes.has(tileType);
  }

  /** Returns the movement speed multiplier for a tile type (1.0 if tile has no speed modifier). */
  getTileSpeed(tileType: number): number {
    return this.tileSpeedMap.get(tileType) ?? 1.0;
  }

  /** Returns the display/id name for a tile type, or a hex fallback if unknown. */
  getTileName(tileType: number): string {
    return this.tileNameMap.get(tileType) ?? `0x${tileType.toString(16)}`;
  }

  /** Resolve a ground type by its XML id/name, case-insensitive. */
  getTileTypeByName(name: string): number | undefined {
    return this.tileTypeByNameMap.get(String(name).trim().toLowerCase());
  }

  /** Returns the damage per tick for a tile type, or undefined if not damaging. */
  getTileDamage(tileType: number): number | undefined {
    return this.tileDamageMap.get(tileType);
  }

  /** True when tiles.xml defines `<MinDamage>` with a value > 0 — matches Multitool Class97 `MinDamage > 0` check. */
  getTileHasMinDamage(tileType: number): boolean {
    return this.tileMinDamageSet.has(tileType);
  }

  /** Returns the slide amount for a tile type, or undefined if the tile does not slide the player. */
  getTileSlideAmount(tileType: number): number | undefined {
    return this.tileSlideAmountMap.get(tileType);
  }

  /** Returns the push vector for a tile type, or undefined if the tile does not push the player. */
  getTilePushVector(tileType: number): TilePushVector | undefined {
    return this.tilePushVectorMap.get(tileType);
  }

  /** Returns true when the tile has a literal <Push /> tag in tiles.xml. */
  getTileHasPush(tileType: number): boolean {
    return this.tilePushTypes.has(tileType);
  }

  /** True when tiles.xml defines `<MinDamage>` and/or `<MaxDamage>` (including benign values). */
  getTileHasDamageAttrs(tileType: number): boolean {
    return this.tileHasDamageAttrs.has(tileType);
  }

  /** True when tiles.xml defines `<ConditionEffect>` on this ground type. */
  getTileHasConditionEffect(tileType: number): boolean {
    return this.tileHasConditionEffect.has(tileType);
  }

  private extractPushVectorFromGround(ground: any, id: string): TilePushVector | null {
    const animateEntries = [
      ground?.Animate,
      ground?.TopAnimate,
      ground?.Animate1,
      ground?.Animate2,
    ];
    for (const entry of animateEntries) {
      const parsed = this.extractPushVectorFromAnimate(entry);
      if (parsed) return parsed;
    }
    return this.inferPushVectorFromTileName(id);
  }

  private extractPushVectorFromAnimate(animate: any): TilePushVector | null {
    if (!animate) return null;
    if (Array.isArray(animate)) {
      for (const item of animate) {
        const parsed = this.extractPushVectorFromAnimate(item);
        if (parsed) return parsed;
      }
      return null;
    }
    if (typeof animate !== 'object') return null;

    const dx = Number(animate['@_dx'] ?? animate.dx);
    const dy = Number(animate['@_dy'] ?? animate.dy);

    if (Number.isFinite(dx) && dx > 0) return { dx: -1, dy: 0 };
    if (Number.isFinite(dx) && dx < 0) return { dx: 1, dy: 0 };
    if (Number.isFinite(dy) && dy > 0) return { dx: 0, dy: -1 };
    if (Number.isFinite(dy) && dy < 0) return { dx: 0, dy: 1 };
    return null;
  }

  private inferPushVectorFromTileName(id: string): TilePushVector | null {
    if (!id) return null;
    const normalized = id
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim();
    if (!normalized) return null;
    const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
    const has = (...aliases: string[]) => aliases.some((alias) => tokens.has(alias));
    if (!has('push', 'pusher', 'pull', 'puller')) return null;
    if (has('right', 'rt', 'east', 'e')) return { dx: 1, dy: 0 };
    if (has('left', 'lf', 'west', 'w')) return { dx: -1, dy: 0 };
    if (has('down', 'dn', 'south', 's')) return { dx: 0, dy: 1 };
    if (has('up', 'north', 'n')) return { dx: 0, dy: -1 };
    return null;
  }

  get objectCount(): number {
    return this.objects.size;
  }

  /**
   * Build catalog payloads for the dev dashboard Game Wiki tab.
   * Summaries are small; details map only includes entries with at least one projectile.
   */
  getGameWikiCatalog(): {
    objectSummaries: GameWikiObjectSummary[];
    objectDetails: Record<string, GameWikiObjectDetail>;
    tiles: GameWikiTileRow[];
  } {
    const objectSummaries: GameWikiObjectSummary[] = [];
    const objectDetails: Record<string, GameWikiObjectDetail> = {};

    for (const o of this.objects.values()) {
      const category = this.getObjectCategory(o.type);
      const dungeonName = this.getGameWikiDungeonName(o);
      objectSummaries.push({
        type: o.type,
        typeHex: `0x${o.type.toString(16)}`,
        id: o.id,
        displayId: o.displayId,
        objectClass: o.objectClass,
        category,
        maxHp: o.maxHp,
        defense: o.defense,
        quest: o.quest,
        god: o.god,
        rateOfFire: o.rateOfFire,
        numProjectiles: o.numProjectiles,
        arcGap: o.arcGap,
        slotType: o.slotType,
        burstCount: o.burstCount,
        occupySquare: o.occupySquare,
        isEnemy: o.isEnemy,
        isPet: o.isPet,
        isPlayer: o.isPlayer,
        isContainer: o.isContainer,
        dungeonName,
        ...(o.playerStatMaxes ? { playerStatMaxes: o.playerStatMaxes } : {}),
      });
      if (o.projectiles.size > 0) {
        objectDetails[String(o.type)] = { projectiles: [...o.projectiles.values()] };
      }
    }
    objectSummaries.sort((a, b) => a.type - b.type);

    const tileTypes = new Set<number>();
    for (const t of this.tileNameMap.keys()) tileTypes.add(t);
    for (const t of this.tileSpeedMap.keys()) tileTypes.add(t);
    for (const t of this.tileDamageMap.keys()) tileTypes.add(t);
    for (const t of this.tileSlideAmountMap.keys()) tileTypes.add(t);
    for (const t of this.tilePushTypes) tileTypes.add(t);
    for (const t of this.tileHasDamageAttrs) tileTypes.add(t);
    for (const t of this.tileHasConditionEffect) tileTypes.add(t);
    for (const t of this.noWalkTileTypes) tileTypes.add(t);
    for (const t of this.sinkTileTypes) tileTypes.add(t);

    const tiles: GameWikiTileRow[] = [];
    for (const type of tileTypes) {
      const speed = this.getTileSpeed(type);
      const slide = this.getTileSlideAmount(type);
      const dmg = this.getTileDamage(type);
      const pushVec = this.getTilePushVector(type);
      let tileBucket = 'Other';
      if (this.noWalkTileTypes.has(type)) tileBucket = 'NoWalk';
      else if (this.sinkTileTypes.has(type)) tileBucket = 'Sink';
      else if (speed !== 1.0) tileBucket = 'Speed';
      else if (dmg !== undefined && dmg > 0) tileBucket = 'Damaging';
      else if (this.tileHasDamageAttrs.has(type)) tileBucket = 'DamageAttrs';
      else if (this.tileHasConditionEffect.has(type)) tileBucket = 'Condition';
      else if (this.tilePushTypes.has(type)) tileBucket = 'Push';
      else if (slide !== undefined && slide > 0) tileBucket = 'Slide';

      const row: GameWikiTileRow = {
        type,
        typeHex: `0x${type.toString(16)}`,
        id: this.getTileName(type),
        noWalk: this.tileIsNoWalk(type),
        sink: this.tileIsSink(type),
        speed,
        hasDamageAttrs: this.tileHasDamageAttrs.has(type),
        hasConditionEffect: this.tileHasConditionEffect.has(type),
        hasPush: this.tilePushTypes.has(type),
        tileBucket,
      };
      if (slide !== undefined && slide > 0) row.slideAmount = slide;
      if (dmg !== undefined && dmg > 0) row.damagePerTick = dmg;
      if (pushVec) {
        row.pushDx = pushVec.dx;
        row.pushDy = pushVec.dy;
      }
      tiles.push(row);
    }
    tiles.sort((a, b) => a.type - b.type);

    return { objectSummaries, objectDetails, tiles };
  }

  private getGameWikiDungeonName(def: ObjectDef): string {
    if (def.dungeonName) return def.dungeonName;
    // spriteWorldObjects8x8 mixes true dungeon content with shared equipment art.
    // For Game Wiki dungeon grouping, keep the inferred tag limited to in-dungeon content.
    if (
      def.textureFile === 'spriteWorldObjects8x8'
      && def.objectClass !== 'Equipment'
      && !def.objectClass.includes('Portal')
    ) {
      return 'Sprite World';
    }
    return '';
  }
}
