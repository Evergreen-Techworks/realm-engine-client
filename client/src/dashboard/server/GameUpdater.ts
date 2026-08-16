// RotMG Exalt game updater.
//
// Ported 1:1 from ExaltAccountManager's `eam_commons/src/rotmg_updater.rs`,
// which is the reference implementation for Deca's undocumented update flow:
//
//   1. POST /app/init  -> XML carrying BuildId / BuildCDN / BuildHash
//   2. GET  {CDN}{Hash}/{Id}/checksum.json -> every shipped file + its md5
//   3. md5 each local file; missing or mismatched means it needs replacing
//   4. GET  {CDN}{Hash}/{Id}/{file}.gz -> gunzip -> write under the game root
//
// Deviations from EAM, all deliberate:
//   - No caching of app-init / file-list state. EAM memoizes it in statics and
//     needs a `force_recheck` flag plus a cache-invalidation routine to undo
//     that; re-fetching two small JSON/XML documents per check is cheaper than
//     the bug surface of serving a stale BuildId.
//   - Downloads run 4-wide instead of strictly sequentially.
//   - Paths from checksum.json are validated to stay under the game root
//     (see resolveInsideRoot) — this is remote-controlled input naming a file
//     we are about to overwrite on disk.

import { createReadStream, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, resolve, sep } from 'path';
import { gunzipSync } from 'zlib';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from '../../util/Logger.js';

const APP_INIT_URL =
  process.platform === 'darwin'
    ? 'https://www.realmofthemadgod.com/app/init?platform=standaloneosxuniversal&key=9KnJFxtTvLu2frXv'
    : 'https://www.realmofthemadgod.com/app/init?platform=standalonewindows64&key=9KnJFxtTvLu2frXv';

const METADATA_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const HASH_CONCURRENCY = 10;
const DOWNLOAD_CONCURRENCY = 4;

/** One entry of Deca's checksum.json. `permision` is their spelling, kept as-is. */
export interface GameFile {
  file: string;
  checksum: string;
  permision: string;
  size: number;
}

export interface AppInit {
  buildId: string;
  buildCdn: string;
  buildHash: string;
}

export interface GameUpdateStatus {
  state: 'idle' | 'checking' | 'updating';
  buildId: string;
  /** Files known to be stale after the last successful check. */
  filesToUpdate: number;
  bytesToUpdate: number;
  filesDone: number;
  bytesDone: number;
  /** Epoch ms of the last completed check, or null if never checked. */
  lastCheck: number | null;
  error: string | null;
}

export function emptyStatus(): GameUpdateStatus {
  return {
    state: 'idle',
    buildId: '',
    filesToUpdate: 0,
    bytesToUpdate: 0,
    filesDone: 0,
    bytesDone: 0,
    lastCheck: null,
    error: null,
  };
}

// ── Pure helpers (exercised by scripts/test-game-updater.ts) ─────────────────

/**
 * Pull BuildId / BuildCDN / BuildHash out of the /app/init response.
 *
 * Deca has moved these between nesting levels before, so we walk the whole
 * parsed tree for the tag names rather than indexing a fixed path — the same
 * thing EAM does with roxmltree's `descendants()`.
 */
export function parseAppInit(xml: string): AppInit {
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
  const found: Record<string, string> = {};

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string' && !found[key]) found[key] = value.trim();
      else walk(value);
    }
  };
  walk(parsed);

  const init: AppInit = {
    buildId: found.BuildId || '',
    buildCdn: found.BuildCDN || '',
    buildHash: found.BuildHash || '',
  };
  if (!init.buildCdn || !init.buildHash || !init.buildId) {
    throw new Error('RotMG /app/init did not return a usable build descriptor');
  }
  return init;
}

export function parseFileList(json: string): GameFile[] {
  const parsed = JSON.parse(json) as { files?: unknown };
  if (!Array.isArray(parsed.files)) {
    throw new Error('checksum.json did not contain a files array');
  }
  return parsed.files as GameFile[];
}

/**
 * Resolve a checksum.json path against the game root, refusing anything that
 * escapes it. The file names come from a remote server and land in a
 * `writeFile`, so `../../Windows/System32/...` has to die here.
 */
export function resolveInsideRoot(root: string, relative: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relative);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new Error(`Refusing to write outside the game directory: ${relative}`);
  }
  return target;
}

export function md5File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('error', rej)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => res(hash.digest('hex')));
  });
}

/** Files that are missing locally or whose md5 no longer matches the manifest. */
export async function diffAgainstDisk(root: string, files: GameFile[]): Promise<GameFile[]> {
  const stale = await inBatches(files, HASH_CONCURRENCY, async (entry) => {
    const path = resolveInsideRoot(root, entry.file);
    if (!existsSync(path)) return entry;
    // An unreadable file (locked, permissions) counts as stale: re-downloading
    // is the right repair either way, and the write will surface a real error.
    const actual = await md5File(path).catch(() => '');
    return actual === entry.checksum ? null : entry;
  });
  return stale.filter((entry): entry is GameFile => entry !== null);
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// ── Network ──────────────────────────────────────────────────────────────────

async function fetchAppInit(): Promise<AppInit> {
  const res = await fetch(APP_INIT_URL, {
    method: 'POST',
    headers: { 'Content-Length': '0', 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RotMG /app/init returned HTTP ${res.status}`);
  return parseAppInit(await res.text());
}

function buildUrl(init: AppInit, suffix: string): string {
  return `${init.buildCdn}${init.buildHash}/${init.buildId}${suffix}`;
}

async function fetchFileList(init: AppInit): Promise<GameFile[]> {
  const url = buildUrl(init, '/checksum.json');
  const res = await fetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`checksum.json returned HTTP ${res.status}`);
  return parseFileList(await res.text());
}

async function downloadFile(init: AppInit, root: string, entry: GameFile): Promise<void> {
  // Resolve before the download so a hostile path fails without burning bandwidth.
  const target = resolveInsideRoot(root, entry.file);
  const url = buildUrl(init, `/${entry.file}.gz`);

  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);

  const unpacked = gunzipSync(Buffer.from(await res.arrayBuffer()));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, unpacked);
}

// ── Orchestration ────────────────────────────────────────────────────────────

export class GameUpdater {
  private status: GameUpdateStatus = emptyStatus();
  /** Stale files from the last check, plus the build they were computed against. */
  private pending: GameFile[] = [];
  private pendingInit: AppInit | null = null;

  constructor(
    private readonly getGameRoot: () => string | null,
    private readonly isGameRunning: () => boolean,
    private readonly onChange: (status: GameUpdateStatus) => void,
  ) {}

  getStatus(): GameUpdateStatus {
    return { ...this.status };
  }

  private emit(patch: Partial<GameUpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.getStatus());
  }

  /** Refresh `filesToUpdate`. Never throws — failures land in `status.error`. */
  async check(): Promise<void> {
    if (this.status.state !== 'idle') return;

    const root = this.getGameRoot();
    if (!root) {
      this.emit({ error: 'Set your RotMG Exalt path in Settings first.' });
      return;
    }

    this.emit({ state: 'checking', error: null, filesDone: 0, bytesDone: 0 });
    try {
      const init = await fetchAppInit();
      const stale = await diffAgainstDisk(root, await fetchFileList(init));

      this.pending = stale;
      this.pendingInit = init;
      this.emit({
        state: 'idle',
        buildId: init.buildId,
        filesToUpdate: stale.length,
        bytesToUpdate: stale.reduce((sum, f) => sum + (Number(f.size) || 0), 0),
        lastCheck: Date.now(),
        error: null,
      });
      Logger.log('GameUpdater', `Build ${init.buildId}: ${stale.length} file(s) need updating.`);
    } catch (err) {
      this.pending = [];
      this.pendingInit = null;
      this.emit({ state: 'idle', error: (err as Error).message || 'Update check failed' });
      Logger.warn('GameUpdater', `Check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Download and write every stale file. Never throws.
   *
   * A partial run is safe and self-healing: whatever landed is correct, and the
   * next check re-detects the rest. That is also why files are written in place
   * rather than staged — a torn write fails its md5 next time and is redone.
   */
  async update(): Promise<void> {
    if (this.status.state !== 'idle') return;

    const root = this.getGameRoot();
    if (!root) {
      this.emit({ error: 'Set your RotMG Exalt path in Settings first.' });
      return;
    }
    // Writes into the install directory fail (or corrupt a loaded asset) while
    // the game holds those files open.
    if (this.isGameRunning()) {
      this.emit({ error: 'Close RotMG Exalt before updating the game.' });
      return;
    }
    if (!this.pending.length || !this.pendingInit) {
      this.emit({ error: 'Check for updates first.' });
      return;
    }

    const init = this.pendingInit;
    const queue = this.pending;
    this.emit({ state: 'updating', error: null, filesDone: 0, bytesDone: 0 });

    try {
      await inBatches(queue, DOWNLOAD_CONCURRENCY, async (entry) => {
        await downloadFile(init, root, entry);
        this.emit({
          filesDone: this.status.filesDone + 1,
          bytesDone: this.status.bytesDone + (Number(entry.size) || 0),
        });
      });

      this.pending = [];
      this.pendingInit = null;
      this.emit({ state: 'idle', filesToUpdate: 0, bytesToUpdate: 0, error: null });
      Logger.log('GameUpdater', `Updated ${queue.length} file(s) to build ${init.buildId}.`);
    } catch (err) {
      this.emit({ state: 'idle', error: (err as Error).message || 'Update failed' });
      Logger.warn('GameUpdater', `Update failed: ${(err as Error).message}`);
      // Stale list is intentionally kept: the user can retry without a re-check.
    }
  }
}
