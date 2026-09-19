#!/usr/bin/env node
// Stamps client/data/build-info.json with the commit this build was made from.
//
// C:\realm-engine (the build source) is NOT a git repo, so the commit cannot be
// read at build time there. Run this in the git worktree BEFORE the source is
// mirrored to the build root; the mirrored data/build-info.json then rides along
// as an ordinary generated data file (electron-builder's `data` extraResources
// already ships everything under data/ except the few names it excludes, and
// build-info.json is not one of them).
//
// The client reads this back at startup (src/util/buildInfo.ts) to log
// `[Main] build: version=<app version> commit=<short sha or unknown> date=...`.
// A missing file is harmless there (falls back to commit=unknown) — this script
// existing or running is not required for the app to start.
//
// Run: node scripts/stamp-build-info.mjs   (from client/, or anywhere — path is
// resolved relative to this file, not the cwd)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'data', 'build-info.json');

function git(args) {
  return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8' }).trim();
}

let commit = 'unknown';
let dirty = false;
try {
  commit = git(['rev-parse', '--short', 'HEAD']);
  dirty = git(['status', '--porcelain']).length > 0;
} catch (err) {
  console.error(`[stamp-build-info] could not read git state (${err.message}); writing commit=unknown`);
}

writeFileSync(outPath, `${JSON.stringify({ commit, dirty })}\n`);
console.log(`[stamp-build-info] wrote ${outPath}: commit=${commit}${dirty ? ' (dirty)' : ''}`);
