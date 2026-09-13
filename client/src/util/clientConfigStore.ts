/**
 * Merged client config: bundled `resources/data/config.json` + optional persistent user overlay.
 * Packaged apps often run from a temp `resources` tree each launch; dashboard writes must survive restarts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

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
      out = { ...out, ...(JSON.parse(readFileSync(bundled, 'utf8')) as Record<string, unknown>) };
    } catch {
      /* keep out */
    }
  }
  const user = getUserClientConfigPath();
  if (user && existsSync(user)) {
    try {
      out = { ...out, ...(JSON.parse(readFileSync(user, 'utf8')) as Record<string, unknown>) };
    } catch {
      /* keep out */
    }
  }
  return out;
}

/**
 * Save settings where the next launch reads them (getClientConfigWritePath).
 * Keys already in that file and not named in `values` are kept; a key set to
 * `undefined` is removed. Returns the file written.
 */
export function writeClientConfig(resourcesRoot: string, values: Record<string, unknown>): string {
  const target = getClientConfigWritePath(resourcesRoot);
  let existing: Record<string, unknown> = {};
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    } catch {
      /* unreadable: rewrite it from values */
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ ...existing, ...values }, null, 2), 'utf8');
  return target;
}

export function truthyConfigFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}
