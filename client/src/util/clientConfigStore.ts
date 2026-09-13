/**
 * Merged client config: bundled `resources/data/config.json` + optional persistent user overlay.
 * Packaged apps often run from a temp `resources` tree each launch; dashboard writes must survive restarts.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs';
import { dirname, resolve } from 'path';

/** Drop a leading UTF-8 BOM (PowerShell 5.1 `Set-Content -Encoding UTF8` writes one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseConfig(raw: string): Record<string, unknown> {
  return JSON.parse(stripBom(raw)) as Record<string, unknown>;
}

export function getUserClientConfigPath(): string | null {
  const p = String(process.env.REALM_ENGINE_USER_CONFIG_PATH || '').trim();
  return p ? resolve(p) : null;
}

/** Where dashboard saves: user overlay file when set, else bundled data/config.json */
export function getClientConfigWritePath(resourcesRoot: string): string {
  return getUserClientConfigPath() ?? resolve(resourcesRoot, 'data', 'config.json');
}

/** Bundled defaults merged with user file (user wins on overlapping keys). */
export function readMergedClientConfigRaw(resourcesRoot: string): Record<string, unknown> {
  const bundled = resolve(resourcesRoot, 'data', 'config.json');
  let out: Record<string, unknown> = {};
  if (existsSync(bundled)) {
    try {
      out = { ...out, ...parseConfig(readFileSync(bundled, 'utf8')) };
    } catch {
      /* keep out */
    }
  }
  const user = getUserClientConfigPath();
  if (user && existsSync(user)) {
    try {
      out = { ...out, ...parseConfig(readFileSync(user, 'utf8')) };
    } catch {
      /* keep out */
    }
  }
  return out;
}

export interface WriteClientConfigResult {
  /** The file that now holds the settings. */
  path: string;
  /** Set when the existing file was unparseable: where its bytes were preserved. */
  corruptBackup?: string;
}

/**
 * Save settings where the next launch reads them (getClientConfigWritePath).
 * Keys already in that file and not named in `values` are kept; a key set to
 * `undefined` is removed.
 *
 * The write is atomic (temp file, fsync, rename) so a crash mid-write cannot
 * leave a half-written config that later reads as corrupt. A leading BOM is
 * tolerated on read. If the existing file still will not parse, its bytes are
 * preserved by renaming it aside to `<path>.corrupt-<timestamp>` (never
 * silently dropped) and a fresh file is written from `values`; the returned
 * `corruptBackup` lets the caller surface that to the user.
 */
export function writeClientConfig(resourcesRoot: string, values: Record<string, unknown>): WriteClientConfigResult {
  const target = getClientConfigWritePath(resourcesRoot);
  let existing: Record<string, unknown> = {};
  let corruptBackup: string | undefined;
  if (existsSync(target)) {
    const raw = readFileSync(target, 'utf8');
    try {
      existing = parseConfig(raw);
    } catch {
      const aside = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        renameSync(target, aside);
        corruptBackup = aside;
      } catch {
        // Could not move it aside (locked/permissions): keep the user's bytes
        // in place and give up on this save rather than overwrite them.
        throw new Error(`config ${target} is unparseable and could not be set aside`);
      }
      existing = {};
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const payload = JSON.stringify({ ...existing, ...values }, null, 2);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* leave the temp file for the next write to overwrite */
    }
    // If we had already set a corrupt file aside, carry that path on the error
    // so the caller can still tell the user where their bytes are.
    if (corruptBackup) (err as { corruptBackup?: string }).corruptBackup = corruptBackup;
    throw err;
  }
  return { path: target, corruptBackup };
}

export function truthyConfigFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}
