/**
 * Test Lab Recorder — TESTLAB_PRIVATE_ONLY.
 *
 * Private-build-only packet recorder: writes ground-truth dodge data (hits,
 * exposure, deaths, ground damage, shots fired vs landed) to a JSONL file for
 * the Test Lab's offline extractor. Recording only — no gameplay behaviour
 * change, nothing here blocks or rewrites a packet, and nothing on the packet
 * path may throw.
 *
 * This file, its pure core (`src/testlab/recorderCore.ts`) and its writer
 * (`src/testlab/recorderWriter.ts`) — plus their tests — are listed in
 * `client/private-only.json` and must be removable from customer builds by
 * deleting exactly those paths. See that file's header comment for the
 * removability proof.
 *
 * Thin by design: this file only (a) hooks packets, (b) resolves the facts
 * only live proxy state can provide (owner object type, distances, hp from
 * world state; projectile path stats from GameData), and (c) hands the result
 * to the pure `dispatchPacket` mapper and the buffered writer. Everything
 * about *what* a record looks like lives in recorderCore.ts, which is why
 * that module — not this one — carries the "one test per record kind" tests.
 */
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import type { PluginContext, ClientConnection, Packet } from './api.js';
import { readBuildInfoFile } from '../src/util/buildInfo.js';
import { loggerDirectory } from '../src/util/Logger.js';
import {
  dispatchPacket,
  ProjDefTracker,
  buildStartRecord,
  buildEndRecord,
  buildArmRecord,
  testlabCoreMarker,
  TESTLAB_PRIVATE_ONLY,
  type ProjDefInput,
  type DispatchContext,
} from '../src/testlab/recorderCore.js';
import { BufferedJsonlWriter, packetsFilePath, writerPrivateOnlyMarker } from '../src/testlab/recorderWriter.js';

export { TESTLAB_PRIVATE_ONLY };

// Same ROOT resolution as src/index.ts (REALM_ENGINE_ROOT in packaged builds,
// computed from this file's own location in dev) — used only to find
// data/build-info.json for the `start` record's build stamp.
const ROOT = process.env.REALM_ENGINE_ROOT
  ? resolve(process.env.REALM_ENGINE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cross-module-instance bus for the exported `mark()` below.
 *
 * PluginManager dynamically imports this file with a fresh `?t=<timestamp>`
 * query string on every load (see PluginManager.loadPlugin), which gives it
 * its own module registry entry distinct from any *other* dynamic import of
 * this same file path (e.g. a future switch-interleaver task importing
 * `mark` directly) — so module-scoped `let` state would not be shared
 * between the instance PluginManager is actively hooking packets through and
 * the instance a caller of `mark()` holds. A globalThis-keyed slot is the
 * same fix DllAimBus.ts / DllThreatBus.ts use for the identical problem.
 */
const BUS_SLOT_KEY = '__realmengine_testlabRecorderBus_v1';
interface RecorderBusSlot {
  writer: BufferedJsonlWriter | null;
  enabled: boolean;
  /** Absolute path of the writer's own file, for a caller (the unattended
   *  runner) that needs to report "did a recording happen" without importing
   *  this module directly. Null until a writer exists. */
  filePath: string | null;
}
function getBusSlot(): RecorderBusSlot {
  const g = globalThis as unknown as Record<string, unknown>;
  let slot = g[BUS_SLOT_KEY] as RecorderBusSlot | undefined;
  if (!slot) {
    slot = { writer: null, enabled: false, filePath: null };
    g[BUS_SLOT_KEY] = slot;
  }
  return slot;
}

/**
 * Appends an `arm` record (`{k:'arm', t, key, value}`). No-op when the
 * recorder is disabled or not yet registered. Called by a later task (the
 * switch interleaver) to stamp which A/B condition was active at a given
 * wall-clock time — never throws.
 */
export function mark(key: string, value: unknown): void {
  try {
    const slot = getBusSlot();
    if (!slot.enabled || !slot.writer) return;
    slot.writer.writeLine(buildArmRecord(Date.now(), key, value));
  } catch {
    // Never let a caller of mark() see an exception from the recorder.
  }
}

export function register(ctx: PluginContext) {
  ctx.name = 'Test Lab Recorder';
  ctx.category = 'utility';
  ctx.enabled = false; // default DISABLED — enabled only via the normal plugin toggle.

  // Filename is fixed once, at plugin registration (~= client start), and the
  // writer is never recreated across enable/disable toggles within this
  // process — "one file per client start", not one per toggle.
  //
  // The base directory comes from Logger.loggerDirectory(), NOT this file's
  // own tmpdir() call — see recorderWriter.ts's header comment for why an
  // independent tmpdir() call here previously wrote to a different directory
  // than the client log in the packaged app.
  const startedAt = new Date();
  const filePath = packetsFilePath(startedAt, loggerDirectory());
  const writer = new BufferedJsonlWriter(filePath);
  const tracker = new ProjDefTracker();
  let wroteStart = false;

  const slot = getBusSlot();
  slot.writer = writer;
  slot.enabled = ctx.enabled;
  slot.filePath = filePath;

  // Ties all three private-only files' markers to one real, non-dead call
  // site so none of them can be tree-shaken out of a bundled build.
  ctx.setData('testlabPrivateOnlyMarkers', [TESTLAB_PRIVATE_ONLY, testlabCoreMarker(), writerPrivateOnlyMarker()]);

  // Exceptions caught here are lookups/mapping failures outside the writer
  // itself (the writer swallows and counts its own I/O/serialize failures
  // via writer.errorCount) — counted the same way so nothing on the packet
  // path can ever throw into the proxy.
  let contextErrorCount = 0;

  function ensureStarted(): void {
    if (wroteStart) return;
    wroteStart = true;
    const info = readBuildInfoFile(ROOT);
    writer.writeLine(
      buildStartRecord(Date.now(), {
        version: process.env.REALM_ENGINE_VERSION || null,
        commit: info ? (info.dirty ? `${info.commit}-dirty` : info.commit) : null,
      }),
    );
  }

  ctx.hookAllPackets((client: ClientConnection, packet: Packet) => {
    try {
      const t = Date.now();
      const dctx = resolveDispatchContext(ctx, client, packet);
      const records = dispatchPacket(packet.name, t, packet.data, dctx, tracker);
      if (records.length === 0) return;
      ensureStarted();
      for (const rec of records) writer.writeLine(rec);
    } catch {
      contextErrorCount++;
      ctx.setData('testlabContextErrorCount', contextErrorCount);
    }
  });

  ctx.onEnabledChange((enabled) => {
    slot.enabled = enabled;
    if (!enabled) {
      try {
        writer.writeLine(buildEndRecord(Date.now(), 'disabled'));
      } catch {
        /* never let a settings toggle throw */
      }
      writer.flushSync();
    }
  });

  ctx.registerCleanup(() => {
    try {
      writer.writeLine(buildEndRecord(Date.now(), 'shutdown'));
    } catch {
      /* best effort only — "when possible" per the contract */
    }
    writer.close();
    slot.writer = null;
    slot.enabled = false;
    slot.filePath = null;
  });
}

/**
 * The only place this plugin reaches into live proxy state. Cheap for every
 * packet kind except PLAYERHIT, whose nearest-living-enemy scan is the one
 * O(entities) lookup the recorder ever does — everything else is O(1).
 * Packet kinds that need no lookups (MAPINFO/MOVE/GROUNDDAMAGE/DEATH/
 * PLAYERSHOOT/ENEMYHIT) fall straight through to `{}`.
 */
function resolveDispatchContext(ctx: PluginContext, client: ClientConnection, packet: Packet): DispatchContext {
  if (packet.name === 'ENEMYSHOOT') {
    const worldState = ctx.getWorldState(client);
    const ownerId = Number(packet.data?.ownerId);
    const ownerType = worldState && Number.isFinite(ownerId) ? worldState.getEntityType(ownerId) ?? null : null;
    let projectile: ProjDefInput | null = null;
    if (ownerType != null && ctx.gameData) {
      const bt = Number(packet.data?.bulletType);
      const def = ctx.gameData.getProjectile(ownerType, bt);
      if (def) {
        projectile = {
          oname: ctx.gameData.getObject(ownerType)?.id ?? null,
          speed: def.speed,
          life: def.lifetimeMs,
          size: def.hitRadius,
          amplitude: def.amplitude,
          frequency: def.frequency,
          magnitude: def.magnitude,
          wavy: def.wavy,
          parametric: def.parametric,
          boomerang: def.boomerang,
          acceleration: def.acceleration,
          accelerationDelay: def.accelerationDelay,
          speedClamp: def.speedClamp,
        };
      }
    }
    return { ownerType, projectile };
  }

  if (packet.name === 'PLAYERHIT') {
    const worldState = ctx.getWorldState(client);
    const oid = Number(packet.data?.objectId);
    const ownerEntity = worldState && Number.isFinite(oid) ? worldState.getEntity(oid) ?? null : null;
    const px = client.playerData?.pos?.x ?? null;
    const py = client.playerData?.pos?.y ?? null;

    let odist: number | null = null;
    if (ownerEntity && px != null && py != null) {
      odist = Math.hypot(ownerEntity.pos.x - px, ownerEntity.pos.y - py);
    }

    let edist: number | null = null;
    if (worldState && ctx.gameData && px != null && py != null) {
      const nearest = worldState.getNearestEnemy(ctx.gameData, { x: px, y: py }, { hpMin: 1 });
      edist = nearest ? nearest.dist : null;
    }

    return {
      hit: {
        otype: ownerEntity?.objectType ?? null,
        x: px,
        y: py,
        odist,
        edist,
        hp: client.playerData?.health ?? null,
        maxhp: client.playerData?.maxHealth ?? null,
      },
    };
  }

  return {};
}
