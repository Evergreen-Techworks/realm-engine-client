/**
 * Startup build marker: which packaged version and which
 * client-repo commit this proxy process was built from, so the Test Lab log
 * parser no longer has to guess which build a session came from.
 *
 * C:\realm-engine (the build source) is NOT a git repo, so the commit cannot be
 * read at build time there. `scripts/stamp-build-info.mjs` writes
 * data/build-info.json (`{"commit":"<short sha>","dirty":<bool>}`) in the git
 * worktree, before the source is mirrored to the build root; this module just
 * reads that file back at startup. The file is gitignored (regenerated per
 * build) and may legitimately be absent — that must never throw or delay
 * startup, and always resolves to commit=unknown instead.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export interface BuildInfo {
  commit: string;
  dirty: boolean;
}

/** Reads `<resourcesRoot>/data/build-info.json`. Never throws; a missing or malformed file is `null`. */
export function readBuildInfoFile(resourcesRoot: string): BuildInfo | null {
  try {
    const path = resolve(resourcesRoot, 'data', 'build-info.json');
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { commit?: unknown; dirty?: unknown };
    const commit = typeof raw?.commit === 'string' ? raw.commit.trim() : '';
    if (!commit) return null;
    return { commit, dirty: raw?.dirty === true };
  } catch {
    return null;
  }
}

/** `<short sha>`, `<short sha>-dirty`, or `unknown` when there is no build info. */
export function formatCommit(info: BuildInfo | null): string {
  if (!info) return 'unknown';
  return info.dirty ? `${info.commit}-dirty` : info.commit;
}

/**
 * The text logged after `[Main] `: `build: version=<v> commit=<c> date=<ISO-8601 UTC now>`.
 * Pure given `now`; the caller (index.ts) still wraps the call, since reading
 * process.env or the clock is trivial but "never throw" is an absolute here.
 */
export function formatBuildInfoLine(version: string, info: BuildInfo | null, now: Date = new Date()): string {
  const v = version && version.trim() ? version.trim() : 'unknown';
  return `build: version=${v} commit=${formatCommit(info)} date=${now.toISOString()}`;
}
