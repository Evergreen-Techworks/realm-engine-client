/**
 * Test Lab character supply — plugin shell (TESTLAB_PRIVATE_ONLY; never
 * ships in a customer build — listed in client/private-only.json).
 *
 * Wires src/testlab/supplyCore.ts to the proxy: when a launch reaches
 * MAPINFO but never enters the world within the grace window (the exact
 * signature of an account sitting at character select with zero living
 * characters), inject a CREATE packet on the game's own connection — the
 * same wire the real character-select screen uses — and let the cap/pacing
 * ledger decide whether it may. Also logs one HELLO-structure line per
 * connection (lengths + 8-char prefixes only, never full tokens) for
 * protocol diagnostics.
 *
 * The lab queue stops sessions on death by design; with this plugin the
 * NEXT launch self-heals instead of needing a hand-made character (the
 * binding constraint on unattended testing since 2026-09-21).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PluginContext, ClientConnection } from './api.js';
import { RuntimeScheduler } from './api.js';
import { loggerDirectory } from '../src/util/Logger.js';
import {
  TESTLAB_PRIVATE_ONLY,
  supplyCoreMarker,
  createAllowed,
  decideCreate,
  supplyLocalDay,
  CREATE_CLASS_TYPES,
  DEFAULT_CAP_PER_DAY,
  DEFAULT_GRACE_MS,
  type SupplyLedgerEntry,
} from '../src/testlab/supplyCore.js';

export { TESTLAB_PRIVATE_ONLY };

const TESTLAB_DIR_NAME = 'testlab';
const LEDGER_FILE_NAME = 'character-supply.json';

export function register(ctx: PluginContext): void {
  ctx.name = 'Test Lab Supply';
  ctx.category = 'utility';
  ctx.setData('testlabPrivateOnlyMarkers', [TESTLAB_PRIVATE_ONLY, supplyCoreMarker()]);

  const scheduler = new RuntimeScheduler();
  let currentClient: ClientConnection | null = null;
  let mapInfoAt: number | null = null;
  let worldEnteredAt: number | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  ctx.registerSetting('enabled', {
    label: 'Auto-create on missing character',
    type: 'boolean',
    value: true,
  });
  ctx.registerSetting('capPerDay', {
    label: 'Max creations per day (0 disables)',
    type: 'number',
    value: DEFAULT_CAP_PER_DAY,
  });
  ctx.registerSetting('classType', {
    label: 'Class to create (wizard=782)',
    type: 'number',
    value: CREATE_CLASS_TYPES.wizard,
  });

  function testlabDir(): string {
    return join(loggerDirectory(), TESTLAB_DIR_NAME);
  }

  function ledgerPath(): string {
    return join(testlabDir(), LEDGER_FILE_NAME);
  }

  function readLedger(): SupplyLedgerEntry[] {
    try {
      return JSON.parse(readFileSync(ledgerPath(), 'utf8')) as SupplyLedgerEntry[];
    } catch {
      return [];
    }
  }

  function appendLedger(entry: SupplyLedgerEntry): void {
    try {
      const dir = testlabDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const all = readLedger();
      all.push(entry);
      writeFileSync(ledgerPath(), JSON.stringify(all, null, 2), 'utf8');
    } catch (err) {
      ctx.log(`ledger write failed (${(err as Error).message}) — cap may under-count, refusing to continue blind`);
      throw err;
    }
  }

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  function sendCreate(): void {
    const client = currentClient;
    if (!client) return;
    const now = Date.now();
    const enabled = ctx.getSetting('enabled') === true || ctx.getSetting('enabled') === 'true';
    const capPerDay = Number(ctx.getSetting('capPerDay') ?? DEFAULT_CAP_PER_DAY) || 0;
    const classType = Number(ctx.getSetting('classType') ?? CREATE_CLASS_TYPES.wizard) || CREATE_CLASS_TYPES.wizard;

    let gate: { allowed: boolean; reason: string };
    if (!enabled) {
      gate = { allowed: false, reason: 'disabled by setting' };
    } else {
      gate = createAllowed(readLedger(), now, capPerDay);
    }
    if (!gate.allowed) {
      appendLedger({ ts: now, day: supplyLocalDay(now), outcome: 'skipped-disabled', mapName: lastMapName });
      ctx.log(`[TestLabSupply] not creating: ${gate.reason}`);
      return;
    }
    try {
      const packet = ctx.createPacket('CREATE');
      packet.data = { classType, skinType: 0, isChallenger: true, isSeasonal: true, isBonus: true };
      packet.modified = true;
      client.sendToServer(packet);
      appendLedger({ ts: now, day: supplyLocalDay(now), outcome: 'sent', mapName: lastMapName });
      ctx.log(`[TestLabSupply] CREATE sent classType=${classType} (${gate.reason}) — waiting for CREATESUCCESS`);
    } catch (err) {
      ctx.log(`[TestLabSupply] CREATE failed to build/send (${(err as Error).message})`);
    }
  }

  let lastMapName = '';

  ctx.on('clientConnected', (client) => {
    currentClient = client;
    mapInfoAt = null;
    worldEnteredAt = null;
    lastMapName = '';
    clearGrace();
  });

  ctx.on('clientDisconnected', () => {
    currentClient = null;
    clearGrace();
  });

  ctx.hookPacket('MAPINFO', (_client, packet) => {
    if (worldEnteredAt !== null) return;
    lastMapName = String(packet.data?.name ?? '');
    if (mapInfoAt === null) {
      mapInfoAt = Date.now();
      clearGrace();
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!currentClient) return;
        const loaded = currentClient.admission?.phase === 'loaded';
        if (!loaded && decideCreate({ mapInfoAt, worldEnteredAt, now: Date.now() })) {
          sendCreate();
        }
      }, DEFAULT_GRACE_MS);
    }
  });

  ctx.hookPacket('CREATESUCCESS', () => {
    worldEnteredAt = Date.now();
    clearGrace();
    ctx.log(`[TestLabSupply] CREATESUCCESS — the newborn should load into the world`);
  });

  // World entry via a normal (existing-character) load also clears the
  // trigger — poll admission because not every load path emits an
  // observable packet from the plugin surface.
  scheduler.scheduleRepeating(2000, () => {
    if (worldEnteredAt === null && currentClient?.admission?.phase === 'loaded') {
      worldEnteredAt = Date.now();
      clearGrace();
    }
  });

  ctx.log(`Loaded — auto-create on missing character (cap ${DEFAULT_CAP_PER_DAY}/day), grace ${DEFAULT_GRACE_MS / 1000}s`);
}
