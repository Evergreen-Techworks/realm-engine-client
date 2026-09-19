/**
 * Test Lab packet recorder — pure core.
 *
 * TESTLAB_PRIVATE_ONLY: this file is listed in `client/private-only.json` and
 * must be deletable from customer builds. It imports nothing from `fs`, `os`,
 * `PluginContext`, the proxy, or world state — every external fact (the shot
 * owner's object type, GameData projectile stats, distances, hp) is resolved
 * by the caller (the thin plugin, `plugins/testlab-recorder.ts`) and passed
 * in as plain data. That split is what makes `dispatchPacket` runnable under
 * `vitest` with object literals instead of a live proxy session.
 *
 * Implements the fixed output contract:
 *   .superpowers/sdd/2026-09-19-testlab-core/contract-packets-jsonl.md
 * The reader side of that contract is built separately from this file —
 * field names and kinds here are load-bearing. Do not rename or add fields
 * without updating the contract file first.
 */

/**
 * Survives compilation on purpose: a future release-pipeline step greps the
 * *built* output for this exact string and refuses to ship a build where the
 * Test Lab recorder is still present (see client/private-only.json). Kept
 * alive across bundling by `testlabCoreMarker()`, which the plugin calls once
 * at registration and threads into a real side effect (`ctx.setData`) so it
 * cannot be tree-shaken as dead code.
 */
export const TESTLAB_PRIVATE_ONLY = 'TESTLAB_PRIVATE_ONLY';

/** See {@link TESTLAB_PRIVATE_ONLY}. */
export function testlabCoreMarker(): string {
  return TESTLAB_PRIVATE_ONLY;
}

/**
 * Explicit ALLOW-LIST (contract privacy rule). Nothing outside this set is
 * ever inspected or written by {@link dispatchPacket} — the name check below
 * runs before any field on `data` is read, so HELLO / LOAD / CREATE / TEXT and
 * any packet carrying account/token/email/guid/character-name fields never
 * reach a builder function, regardless of what `data` contains.
 */
const ALLOWED_PACKET_NAMES: ReadonlySet<string> = new Set([
  'MAPINFO',
  'MOVE',
  'ENEMYSHOOT',
  'PLAYERHIT',
  'GROUNDDAMAGE',
  'DEATH',
  'PLAYERSHOOT',
  'ENEMYHIT',
]);

export function isAllowedPacketName(name: string): boolean {
  return ALLOWED_PACKET_NAMES.has(name);
}

// ── Record shapes (contract schema v1) ──────────────────────────────────────

export interface TestlabBuildInfo {
  version: string | null;
  commit: string | null;
}

export interface StartRecord {
  k: 'start';
  t: number;
  v: 1;
  build: TestlabBuildInfo;
}

export interface MapRecord {
  k: 'map';
  t: number;
  name: string | null;
  w: number | null;
  h: number | null;
}

/** `[time, x, y]`, matching the contract's `recs` shape exactly. */
export type MoveRec = [number, number, number];

export interface MoveRecord {
  k: 'move';
  t: number;
  tick: number | null;
  x: number | null;
  y: number | null;
  recs: MoveRec[];
}

export interface ProjDefRecord {
  k: 'projdef';
  t: number;
  otype: number;
  bt: number;
  oname: string | null;
  speed: number | null;
  life: number | null;
  size: number | null;
  // Path properties are included only when non-default (see PATH_PROP_DEFAULTS
  // below) — most projectiles fly straight, so this keeps a projdef line lean.
  amplitude?: number;
  frequency?: number;
  magnitude?: number;
  wavy?: boolean;
  parametric?: boolean;
  boomerang?: boolean;
  acceleration?: number;
  accelerationDelay?: number;
  speedClamp?: number;
}

export interface ShotRecord {
  k: 'shot';
  t: number;
  bid: number | null;
  oid: number | null;
  otype: number | null;
  bt: number | null;
  x: number | null;
  y: number | null;
  a: number | null;
  dmg: number | null;
  n: number;
  ainc: number | null;
}

export interface HitRecord {
  k: 'hit';
  t: number;
  bid: number | null;
  oid: number | null;
  otype: number | null;
  x: number | null;
  y: number | null;
  odist: number | null;
  edist: number | null;
  hp: number | null;
  maxhp: number | null;
}

export interface GroundRecord {
  k: 'ground';
  t: number;
  x: number | null;
  y: number | null;
}

export interface DeathRecord {
  k: 'death';
  t: number;
  killedBy: string | null;
}

export interface PShootRecord {
  k: 'pshoot';
  t: number;
  bid: number | null;
}

export interface EHitRecord {
  k: 'ehit';
  t: number;
  oid: number | null;
  kill: boolean | null;
}

export interface ArmRecord {
  k: 'arm';
  t: number;
  key: string;
  value: unknown;
}

export interface EndRecord {
  k: 'end';
  t: number;
  reason: string | null;
}

export type TestlabRecord =
  | StartRecord
  | MapRecord
  | MoveRecord
  | ProjDefRecord
  | ShotRecord
  | HitRecord
  | GroundRecord
  | DeathRecord
  | PShootRecord
  | EHitRecord
  | ArmRecord
  | EndRecord;

// ── small, defensive scalar coercions (packet.data is Record<string, any>) ──

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

// ── per-record builders ──────────────────────────────────────────────────

export function buildStartRecord(t: number, build: TestlabBuildInfo): StartRecord {
  return { k: 'start', t, v: 1, build };
}

export function buildEndRecord(t: number, reason: string | null): EndRecord {
  return { k: 'end', t, reason };
}

/** `data` is a MAPINFO packet's `.data`. */
export function buildMapRecord(t: number, data: any): MapRecord {
  return { k: 'map', t, name: str(data?.name), w: num(data?.width), h: num(data?.height) };
}

/** `data` is a client→server MOVE packet's `.data`. */
export function buildMoveRecord(t: number, data: any): MoveRecord {
  const rawRecords: any[] = Array.isArray(data?.records) ? data.records : [];
  const recs: MoveRec[] = rawRecords.map((r) => [num(r?.time) ?? 0, num(r?.x) ?? 0, num(r?.y) ?? 0] as MoveRec);
  const last = rawRecords.length > 0 ? rawRecords[rawRecords.length - 1] : null;
  return {
    k: 'move',
    t,
    tick: num(data?.tickId),
    x: last ? num(last.x) : null,
    y: last ? num(last.y) : null,
    recs,
  };
}

/** Pre-resolved GameData projectile facts for one (otype, bt) pair. */
export interface ProjDefInput {
  oname: string | null;
  speed: number;
  life: number;
  size: number;
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

/** Path-property defaults, mirrored from GameDataLoader's own XML parsing defaults. */
const PATH_PROP_DEFAULTS = {
  amplitude: 0,
  frequency: 0,
  magnitude: 3,
  wavy: false,
  parametric: false,
  boomerang: false,
  acceleration: 0,
  accelerationDelay: 0,
  speedClamp: 0,
} as const;

export function buildProjDefRecord(t: number, otype: number, bt: number, def: ProjDefInput): ProjDefRecord {
  const rec: ProjDefRecord = {
    k: 'projdef',
    t,
    otype,
    bt,
    oname: def.oname,
    speed: num(def.speed),
    life: num(def.life),
    size: num(def.size),
  };
  for (const key of Object.keys(PATH_PROP_DEFAULTS) as (keyof typeof PATH_PROP_DEFAULTS)[]) {
    const value = def[key];
    if (value !== PATH_PROP_DEFAULTS[key]) {
      (rec as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return rec;
}

/** `data` is an ENEMYSHOOT packet's `.data`; `otype` is the owner's resolved object type. */
export function buildShotRecord(t: number, data: any, otype: number | null): ShotRecord {
  const numShots = data?.numShots;
  const n = numShots === undefined || numShots === null || Number(numShots) === 255 ? 1 : Number(numShots);
  return {
    k: 'shot',
    t,
    bid: num(data?.bulletId),
    oid: num(data?.ownerId),
    otype,
    bt: num(data?.bulletType),
    x: num(data?.position?.x),
    y: num(data?.position?.y),
    a: num(data?.angle),
    dmg: num(data?.damage),
    n,
    ainc: num(data?.angleInc),
  };
}

export interface HitLookup {
  otype: number | null;
  x: number | null;
  y: number | null;
  odist: number | null;
  edist: number | null;
  hp: number | null;
  maxhp: number | null;
}

const EMPTY_HIT_LOOKUP: HitLookup = {
  otype: null,
  x: null,
  y: null,
  odist: null,
  edist: null,
  hp: null,
  maxhp: null,
};

/** `data` is a client→server PLAYERHIT packet's `.data`. */
export function buildHitRecord(t: number, data: any, lookup: HitLookup): HitRecord {
  return {
    k: 'hit',
    t,
    bid: num(data?.bulletId),
    oid: num(data?.objectId),
    otype: lookup.otype,
    x: lookup.x,
    y: lookup.y,
    odist: lookup.odist,
    edist: lookup.edist,
    hp: lookup.hp,
    maxhp: lookup.maxhp,
  };
}

/** `data` is a client→server GROUNDDAMAGE packet's `.data`. */
export function buildGroundRecord(t: number, data: any): GroundRecord {
  return { k: 'ground', t, x: num(data?.position?.x), y: num(data?.position?.y) };
}

/**
 * `data` is a server→client DEATH packet's `.data`. Deliberately never reads
 * `data.accountId` (or charId / account level / XP) — the contract requires
 * the account id NEVER be recorded, and the simplest way to guarantee that is
 * to never touch the field at all.
 */
export function buildDeathRecord(t: number, data: any): DeathRecord {
  return { k: 'death', t, killedBy: str(data?.killedBy) };
}

/** `data` is a client→server PLAYERSHOOT packet's `.data`. */
export function buildPShootRecord(t: number, data: any): PShootRecord {
  return { k: 'pshoot', t, bid: num(data?.bulletId) };
}

/**
 * `data` is a client→server ENEMYHIT packet's `.data`. `oid` is the enemy
 * that was hit (`targetId`), not the shot's owner (`ownerId`, which for a
 * self-reported ENEMYHIT is just the local player) — the interesting fact for
 * shots-fired-vs-landed is which enemy the hit claim was against.
 */
export function buildEHitRecord(t: number, data: any): EHitRecord {
  return { k: 'ehit', t, oid: num(data?.targetId), kill: bool(data?.kill) };
}

export function buildArmRecord(t: number, key: string, value: unknown): ArmRecord {
  return { k: 'arm', t, key, value: value === undefined ? null : value };
}

/**
 * In-memory only (no fs): tracks which (otype, bt) pairs have already gotten
 * a `projdef` line this file/session, so `dispatchPacket` emits one exactly
 * once per pair, immediately before the first `shot` that uses it.
 */
export class ProjDefTracker {
  private readonly seen = new Set<string>();

  private key(otype: number, bt: number): string {
    return `${otype}:${bt}`;
  }

  hasEmitted(otype: number, bt: number): boolean {
    return this.seen.has(this.key(otype, bt));
  }

  markEmitted(otype: number, bt: number): void {
    this.seen.add(this.key(otype, bt));
  }
}

/** Everything the ENEMYSHOOT / PLAYERHIT branches need that only the plugin can resolve. */
export interface DispatchContext {
  /** ENEMYSHOOT: the shot owner's resolved object type (world state). */
  ownerType?: number | null;
  /** ENEMYSHOOT: resolved GameData projectile facts for (ownerType, bulletType), or null when GameData has no match. */
  projectile?: ProjDefInput | null;
  /** PLAYERHIT: player position/hp + distances (world state). */
  hit?: HitLookup;
}

/**
 * The single pure entry point the plugin calls per packet: allow-list check,
 * then packet-shape -> record-shape mapping. Returns zero, one, or (for
 * ENEMYSHOOT, when a fresh projdef is due) two records, in write order.
 * A disallowed packet name always returns `[]` before any field on `data` is
 * touched — this is what the privacy allow-list test exercises directly.
 */
export function dispatchPacket(
  name: string,
  t: number,
  data: any,
  ctx: DispatchContext,
  tracker: ProjDefTracker,
): TestlabRecord[] {
  if (!isAllowedPacketName(name)) return [];

  switch (name) {
    case 'MAPINFO':
      return [buildMapRecord(t, data)];

    case 'MOVE':
      return [buildMoveRecord(t, data)];

    case 'ENEMYSHOOT': {
      const otype = ctx.ownerType ?? null;
      const bt = num(data?.bulletType);
      const out: TestlabRecord[] = [];
      if (otype != null && bt != null && ctx.projectile && !tracker.hasEmitted(otype, bt)) {
        out.push(buildProjDefRecord(t, otype, bt, ctx.projectile));
        tracker.markEmitted(otype, bt);
      }
      out.push(buildShotRecord(t, data, otype));
      return out;
    }

    case 'PLAYERHIT':
      return [buildHitRecord(t, data, ctx.hit ?? EMPTY_HIT_LOOKUP)];

    case 'GROUNDDAMAGE':
      return [buildGroundRecord(t, data)];

    case 'DEATH':
      return [buildDeathRecord(t, data)];

    case 'PLAYERSHOOT':
      return [buildPShootRecord(t, data)];

    case 'ENEMYHIT':
      return [buildEHitRecord(t, data)];

    default:
      return [];
  }
}
