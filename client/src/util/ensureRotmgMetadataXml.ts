/**
 * Ensures RotMG mirror XML files exist under {@code data/} (equip.xml + enchantments.xml for Damage Sniffer / future enchants).
 * Used at app startup and by {@code npm run download-game-xml}.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export const DEFAULT_XML_BASES = [
  'https://rotmg-mirror.github.io/rotmg-metadata/assets/production/xml/',
  'https://static.drips.pw/rotmg/production/current/xml/',
];

export interface XmlFileSpec {
  out: string;
  candidates: string[];
}

/** Always kept present when possible. equip.xml is covered by objects.xml extracted from the local game. */
export const METADATA_XML_SPECS: XmlFileSpec[] = [
  { out: 'enchantments.xml', candidates: ['enchantments.xml', 'Enchantments.xml', 'enchants.xml'] },
];

export const FULL_GAME_XML_SPECS: XmlFileSpec[] = [
  { out: 'objects.xml', candidates: ['objects.xml', 'Objects.xml'] },
  { out: 'tiles.xml', candidates: ['tiles.xml', 'Tiles.xml'] },
];

export interface EnsureRotmgMetadataXmlOptions {
  signal?: AbortSignal;
  /** Overwrite even if the file already exists */
  force?: boolean;
  /** Also try objects.xml + tiles.xml */
  full?: boolean;
  /** Mirror directory URLs (trailing slash optional). If unset, uses env ROTMG_XML_BASE or {@link DEFAULT_XML_BASES}. */
  bases?: string[];
  /** Logging (defaults to no-op for library use; CLI passes console) */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function joinUrl(base: string, name: string): string {
  const b = base.replace(/\/?$/, '/');
  const n = name.replace(/^\//, '');
  return b + n;
}

/** Keep low so app UI (Electron waits ~10s for :3000) is not blocked when mirrors are slow or missing files. */
const FETCH_TIMEOUT_MS = 8_000;

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'realm-engine-ensure-rotmg-xml/1.0' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function resolveBases(override?: string[]): string[] {
  if (override && override.length > 0) return override.map((b) => (b.endsWith('/') ? b : `${b}/`));
  const envBase = process.env.ROTMG_XML_BASE?.trim();
  if (envBase) {
    return [envBase.endsWith('/') ? envBase : `${envBase}/`];
  }
  return [...DEFAULT_XML_BASES];
}

/**
 * Download one spec: try every base × every candidate filename until one succeeds.
 */
export async function downloadXmlSpec(
  dataDir: string,
  spec: XmlFileSpec,
  bases: string[],
  force: boolean,
  log?: EnsureRotmgMetadataXmlOptions['log'],
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const dest = resolve(dataDir, spec.out);
  if (existsSync(dest) && !force) {
    log?.('info', `${spec.out} already present — skip`);
    return true;
  }

  const errors: string[] = [];
  for (const base of bases) {
    for (const name of spec.candidates) {
      signal?.throwIfAborted();
      const url = joinUrl(base, name);
      try {
        const buf = await fetchBuffer(url, signal);
        signal?.throwIfAborted();
        if (buf.length < 64) {
          errors.push(`${url}: response too small (${buf.length} bytes)`);
          continue;
        }
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(dest, buf);
        log?.('info', `Downloaded ${spec.out} (${buf.length} bytes) <= ${url}`);
        return true;
      } catch (e) {
        signal?.throwIfAborted();
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
  }
  log?.('error', `Failed to fetch ${spec.out}:\n  ${errors.join('\n  ')}`);
  return false;
}

export interface EnsureRotmgMetadataXmlResult {
  ok: boolean;
  /** Basenames that are missing or failed to download */
  failed: string[];
}

/**
 * For each spec: if file missing (or {@code force}), download from mirrors. Both equip and enchantments are required for {@code ok}.
 */
export async function ensureRotmgMetadataXml(
  dataDir: string,
  options: EnsureRotmgMetadataXmlOptions = {},
): Promise<EnsureRotmgMetadataXmlResult> {
  const { force = false, full = false, bases: basesOpt, log, signal } = options;
  signal?.throwIfAborted();
  const bases = resolveBases(basesOpt);
  mkdirSync(dataDir, { recursive: true });

  log?.('info', `Metadata XML bases: ${bases.join(' | ')}`);

  for (const spec of METADATA_XML_SPECS) {
    const dest = resolve(dataDir, spec.out);
    const needs = force || !existsSync(dest);
    if (!needs) {
      log?.('info', `${spec.out} already present — skip`);
      continue;
    }
    await downloadXmlSpec(dataDir, spec, bases, force, log, signal);
  }

  if (full) {
    for (const spec of FULL_GAME_XML_SPECS) {
      const dest = resolve(dataDir, spec.out);
      const needs = force || !existsSync(dest);
      if (!needs) {
        log?.('info', `${spec.out} already present — skip`);
        continue;
      }
      await downloadXmlSpec(dataDir, spec, bases, force, log, signal);
    }
  }

  const failed = METADATA_XML_SPECS.filter((s) => !existsSync(resolve(dataDir, s.out))).map((s) => s.out);
  return { ok: failed.length === 0, failed };
}
