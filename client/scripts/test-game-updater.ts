// Self-check for the RotMG game updater's non-trivial logic: the /app/init XML
// parse, the checksum.json parse, the md5 diff against disk, and the path-
// escape guard. No network, no framework.
//
//   npx tsx scripts/test-game-updater.ts

import assert from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseAppInit,
  parseFileList,
  resolveInsideRoot,
  diffAgainstDisk,
} from '../src/dashboard/server/GameUpdater.js';

// Shape of a real /app/init response, trimmed to the tags we read.
const APP_INIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AppSettings>
  <Version>6.9.0.1.0</Version>
  <BuildId>6.9.0.1.0</BuildId>
  <BuildCDN>https://rotmg-build.decagames.com/build-release/</BuildCDN>
  <BuildHash>a1b2c3d4e5f6</BuildHash>
  <Nested><Unrelated>ignored</Unrelated></Nested>
</AppSettings>`;

const init = parseAppInit(APP_INIT_XML);
assert.strictEqual(init.buildId, '6.9.0.1.0');
assert.strictEqual(init.buildCdn, 'https://rotmg-build.decagames.com/build-release/');
assert.strictEqual(init.buildHash, 'a1b2c3d4e5f6');

// A response missing the build descriptor must fail loudly, not silently build
// a garbage CDN URL out of empty strings.
assert.throws(() => parseAppInit('<AppSettings><Error>maintenance</Error></AppSettings>'));

// md5("alpha") and md5("beta"), used as the manifest checksums below.
const MD5_ALPHA = '2c1743a391305fbf367df8e4f069f9f9';
const MD5_BETA = '987bcab01b929eb2c07877b224215c92';

const files = parseFileList(JSON.stringify({
  files: [
    { file: 'good.txt', checksum: MD5_ALPHA, permision: '', size: 5 },
    { file: 'RotMG Exalt_Data/corrupt.txt', checksum: MD5_BETA, permision: '', size: 5 },
    { file: 'missing.txt', checksum: MD5_ALPHA, permision: '', size: 5 },
  ],
}));
assert.strictEqual(files.length, 3);
assert.throws(() => parseFileList('{"oops":true}'));

const root = mkdtempSync(join(tmpdir(), 're-updater-'));
try {
  writeFileSync(join(root, 'good.txt'), 'alpha');
  // Same manifest entry as corrupt.txt but with the wrong bytes on disk.
  writeFileSync(join(root, 'corrupt.txt'), 'alpha');
  const withCorruptAtRoot = files.map((f) =>
    f.file === 'RotMG Exalt_Data/corrupt.txt' ? { ...f, file: 'corrupt.txt' } : f,
  );

  const stale = await diffAgainstDisk(root, withCorruptAtRoot);
  const names = stale.map((f) => f.file).sort();
  assert.deepStrictEqual(names, ['corrupt.txt', 'missing.txt'],
    `expected the mismatched and missing files, got ${JSON.stringify(names)}`);

  // Nested manifest paths resolve under the root...
  assert.strictEqual(
    resolveInsideRoot(root, 'RotMG Exalt_Data/resources.assets'),
    join(root, 'RotMG Exalt_Data', 'resources.assets'),
  );
  // ...but a traversal from the CDN never gets to touch the filesystem.
  assert.throws(() => resolveInsideRoot(root, '../../evil.dll'), /outside the game directory/);
  assert.throws(() => resolveInsideRoot(root, 'a/../../evil.dll'), /outside the game directory/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('game-updater self-check passed');
