/**
 * CLI for extractGameXmls — extracts objects.xml and tiles.xml from the RotMG CDN.
 *
 *   npm run extract-game-xml
 *   npm run extract-game-xml -- --force   (re-extract even if build hash matches)
 *   npm run extract-game-xml -- --dir /custom/path
 */

import { resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { extractGameXmls, getRealmengineDataDir } from '../../src/util/rotmgAssetExtractor.js';

const args = process.argv.slice(2);
const force = args.includes('--force');

let dataDir = getRealmengineDataDir();
const dirIdx = args.indexOf('--dir');
if (dirIdx !== -1 && args[dirIdx + 1]) {
  dataDir = resolve(args[dirIdx + 1]);
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

console.log(`Target directory: ${dataDir}`);

const result = await extractGameXmls(dataDir);

if (result.objectsXml) {
  console.log(`objects.xml    → ${result.objectsXml}`);
} else {
  console.error('objects.xml: NOT OBTAINED');
}
if (result.tilesXml) {
  console.log(`tiles.xml      → ${result.tilesXml}`);
} else {
  console.error('tiles.xml: NOT OBTAINED');
}

const spritesheet = resolve(dataDir, 'spritesheet.xml');
if (existsSync(spritesheet)) {
  console.log(`spritesheet.xml → ${spritesheet}`);
}
const imagesDir = resolve(dataDir, 'images');
if (existsSync(imagesDir)) {
  console.log(`images/        → ${imagesDir}`);
}

if (!result.objectsXml || !result.tilesXml) {
  process.exit(1);
}
