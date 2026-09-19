// Shared logic behind `client/private-only.json`: which files are private-only
// (Test Lab today) and must never reach a customer build.
//
// Contract with the pipeline (do not change unilaterally — it also sets this):
// the environment variable RE_PRIVATE_BUILD=1 means "this is a private build:
// include private-only features." Anything else (unset, empty, "0") means
// customer build.
//
// This module is plain node (no TypeScript, no bundler) so build-prod.mjs can
// import it directly, the same way scripts/lib/packet-keys.mjs is shared with
// PacketFactory's tests.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Windows-style absolute paths (`C:\...`, `C:/...`, `\\server\share`) so a
// manifest checked out on Linux still rejects them; POSIX absolute paths are
// caught by node's own `isAbsolute`.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Validate an already-`JSON.parse`d private-only.json body: a non-empty
 * `marker` string and a `paths` array of strings, each relative to `root` and
 * staying inside it (no absolute path, no `..` escape). Throws on the first
 * problem found; a caller that wants a build to fail loudly on a malformed
 * manifest should let this throw rather than catching it.
 * @param {unknown} raw
 * @param {string} root
 * @returns {{ marker: string, paths: string[] }}
 */
export function validatePrivateOnlyManifest(raw, root) {
  const marker = typeof raw?.marker === 'string' ? raw.marker : '';
  if (!marker) throw new Error('private-only.json: missing or empty "marker"');
  const rawPaths = raw?.paths;
  if (!Array.isArray(rawPaths)) throw new Error('private-only.json: "paths" must be an array');

  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  const paths = rawPaths.map((p) => {
    if (typeof p !== 'string' || !p) throw new Error(`private-only.json: invalid path entry ${JSON.stringify(p)}`);
    if (isAbsolute(p) || WINDOWS_ABSOLUTE.test(p)) {
      throw new Error(`private-only.json: path must be relative to client/, not absolute: ${p}`);
    }
    const resolved = resolve(root, p);
    if (resolved !== root.replace(/[\\/]+$/, '') && !resolved.startsWith(rootPrefix)) {
      throw new Error(`private-only.json: path escapes client/: ${p}`);
    }
    return p;
  });
  return { marker, paths };
}

/**
 * Read and validate `manifestPath`. Returns `null` when the file does not
 * exist — a missing manifest is the "nothing is private-only" no-op case, not
 * an error.
 * @param {string} manifestPath
 * @param {string} root
 * @returns {{ marker: string, paths: string[] } | null}
 */
export function readPrivateOnlyManifest(manifestPath, root) {
  if (!existsSync(manifestPath)) return null;
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return validatePrivateOnlyManifest(raw, root);
}

const TOP_LEVEL_PLUGIN_PATH = /^plugins\/([^/]+\.ts)$/;
const DIR_PLUGIN_INDEX_PATH = /^plugins\/([^/]+)\/index\.ts$/;

/**
 * The plugin-discovery key (as build-prod.mjs's `EXCLUDED_PLUGINS` /
 * `ADMIN_ONLY_PLUGINS` sets use it: a top-level plugin's file name, or a
 * directory plugin's folder name) that a manifest path belongs to, or `null`
 * when the path isn't a plugin entry point at all (e.g. a pure core file
 * under `src/testlab/` that a plugin entry point imports — those are only
 * reachable through their plugin's entry point, so excluding the entry point
 * from bundling is what keeps them out; they need no separate key).
 * @param {string} manifestPath
 * @returns {string | null}
 */
export function pluginKeyForPath(manifestPath) {
  const top = TOP_LEVEL_PLUGIN_PATH.exec(manifestPath);
  if (top) return top[1];
  const dir = DIR_PLUGIN_INDEX_PATH.exec(manifestPath);
  if (dir) return dir[1];
  return null;
}

/**
 * Plugin-discovery keys to exclude from bundling for this build.
 * Empty when there is no manifest (nothing is private-only) or this is a
 * private build (RE_PRIVATE_BUILD=1 — everything ships).
 * @param {{ marker: string, paths: string[] } | null} manifest
 * @param {boolean} isPrivateBuild
 * @returns {Set<string>}
 */
export function excludedPluginKeys(manifest, isPrivateBuild) {
  const keys = new Set();
  if (!manifest || isPrivateBuild) return keys;
  for (const p of manifest.paths) {
    const key = pluginKeyForPath(p);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Recursively scan `dir` for `marker` as raw bytes — not decoded text, so a
 * minified/bundled or otherwise binary-ish file still fails the scan if the
 * exact marker bytes survived into it. Returns every matching file's path
 * relative to `dir`, in no particular order; empty when `dir` doesn't exist
 * (a build that produced no output has nothing to scan) or nothing matched.
 * @param {string} dir
 * @param {string} marker
 * @returns {string[]}
 */
export function scanForMarker(dir, marker) {
  const needle = Buffer.from(marker, 'utf8');
  const hits = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && readFileSync(full).includes(needle)) hits.push(relative(dir, full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}
