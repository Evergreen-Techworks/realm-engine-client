/**
 * CLI for extracting RotMG game XML/assets into RealmEngine's data directory.
 *
 * Examples:
 *   npm run download-game-xml
 *   npm run download-game-xml -- --force
 *   npm run download-game-xml -- --dir ./data
 */

import { resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { extractGameXmls, getRealmengineDataDir } from '../src/util/rotmgAssetExtractor.js';

const args = process.argv.slice(2);
const force = args.includes('--force');

let dataDir = getRealmengineDataDir();

const dirIdx = args.indexOf('--dir');
if (dirIdx !== -1 && args[dirIdx + 1]) {
  dataDir = resolve(args[dirIdx + 1]!);
}

if (force) {
  for (const f of ['.build-hash', '.local-build-hash']) {
    const p = resolve(dataDir, f);
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`[force] Removed ${f} — will re-extract`);
    }
  }
}

console.log(`[download-game-xml] Target directory: ${dataDir}`);

const result = await extractGameXmls(dataDir);

if (result.objectsXml) {
  console.log(`[download-game-xml] objects.xml -> ${result.objectsXml}`);
} else {
  console.error('[download-game-xml] objects.xml: NOT OBTAINED');
}

if (result.tilesXml) {
  console.log(`[download-game-xml] tiles.xml -> ${result.tilesXml}`);
} else {
  console.error('[download-game-xml] tiles.xml: NOT OBTAINED');
}

if (!result.objectsXml || !result.tilesXml) {
  process.exit(1);
}
