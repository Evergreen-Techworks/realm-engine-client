import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// build-prod.mjs runs under plain node (no TypeScript, no bundler), so its
// private-only gate lives in a .mjs module this test imports directly — same
// pattern as scripts/lib/packet-keys.mjs and src/packets/__tests__/directionKeys.test.ts.
import {
  excludedPluginKeys,
  pluginKeyForPath,
  readPrivateOnlyManifest,
  scanForMarker,
  validatePrivateOnlyManifest,
} from '../../../scripts/lib/private-only.mjs';

describe('pluginKeyForPath', () => {
  it('keys a top-level plugin file by its file name', () => {
    expect(pluginKeyForPath('plugins/testlab-recorder.ts')).toBe('testlab-recorder.ts');
  });

  it('keys a directory plugin by its folder name', () => {
    expect(pluginKeyForPath('plugins/auto-drink/index.ts')).toBe('auto-drink');
  });

  it('is null for a path that is not a plugin entry point', () => {
    expect(pluginKeyForPath('src/testlab/recorderCore.ts')).toBeNull();
    expect(pluginKeyForPath('plugins/auto-drink/helpers.ts')).toBeNull();
  });
});

describe('validatePrivateOnlyManifest', () => {
  const root = '/repo/client';

  it('accepts a well-formed manifest', () => {
    const raw = { marker: 'TESTLAB_PRIVATE_ONLY', paths: ['plugins/testlab-recorder.ts', 'src/testlab/recorderCore.ts'] };
    expect(validatePrivateOnlyManifest(raw, root)).toEqual(raw);
  });

  it('rejects a missing or empty marker', () => {
    expect(() => validatePrivateOnlyManifest({ paths: [] }, root)).toThrow(/marker/);
    expect(() => validatePrivateOnlyManifest({ marker: '', paths: [] }, root)).toThrow(/marker/);
  });

  it('rejects an absolute path (POSIX or Windows-style)', () => {
    expect(() => validatePrivateOnlyManifest({ marker: 'M', paths: ['/etc/passwd'] }, root)).toThrow(/relative|absolute/);
    expect(() => validatePrivateOnlyManifest({ marker: 'M', paths: ['C:\\Windows\\System32'] }, root)).toThrow(/relative|absolute/);
  });

  it('rejects a path that escapes the root via ..', () => {
    expect(() => validatePrivateOnlyManifest({ marker: 'M', paths: ['../outside.ts'] }, root)).toThrow(/escapes/);
    expect(() => validatePrivateOnlyManifest({ marker: 'M', paths: ['plugins/../../outside.ts'] }, root)).toThrow(/escapes/);
  });

  it('accepts a path that merely contains a literal ".." substring in a name', () => {
    // Sanity check: the escape check is about traversal, not the substring "..".
    expect(() => validatePrivateOnlyManifest({ marker: 'M', paths: ['plugins/foo..bar.ts'] }, root)).not.toThrow();
  });
});

describe('readPrivateOnlyManifest', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'private-only-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null when the manifest file does not exist (no-op case)', () => {
    expect(readPrivateOnlyManifest(join(root, 'private-only.json'), root)).toBeNull();
  });

  it('reads and validates an existing manifest', () => {
    const manifestPath = join(root, 'private-only.json');
    writeFileSync(manifestPath, JSON.stringify({ marker: 'TESTLAB_PRIVATE_ONLY', paths: ['plugins/testlab-recorder.ts'] }));
    expect(readPrivateOnlyManifest(manifestPath, root)).toEqual({
      marker: 'TESTLAB_PRIVATE_ONLY',
      paths: ['plugins/testlab-recorder.ts'],
    });
  });

  it('throws on a manifest with an escaping path', () => {
    const manifestPath = join(root, 'private-only.json');
    writeFileSync(manifestPath, JSON.stringify({ marker: 'M', paths: ['../escape.ts'] }));
    expect(() => readPrivateOnlyManifest(manifestPath, root)).toThrow(/escapes/);
  });
});

describe('excludedPluginKeys', () => {
  const manifest = {
    marker: 'TESTLAB_PRIVATE_ONLY',
    paths: [
      'plugins/testlab-recorder.ts',
      'src/testlab/recorderCore.ts',
      'plugins/testlab-interleaver.ts',
      'src/testlab/interleaverCore.ts',
    ],
  };

  it('customer build: excludes only the plugin entry points, keyed by file name', () => {
    expect(excludedPluginKeys(manifest, false)).toEqual(new Set(['testlab-recorder.ts', 'testlab-interleaver.ts']));
  });

  it('private build: excludes nothing (RE_PRIVATE_BUILD=1 ships everything)', () => {
    expect(excludedPluginKeys(manifest, true)).toEqual(new Set());
  });

  it('no manifest: excludes nothing, in either mode', () => {
    expect(excludedPluginKeys(null, false)).toEqual(new Set());
    expect(excludedPluginKeys(null, true)).toEqual(new Set());
  });
});

describe('scanForMarker', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'private-only-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes (empty result) on a clean tree', () => {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'app.cjs'), 'console.log("hello")');
    writeFileSync(join(dir, 'plugins', 'auto-dodge.js'), 'export default {}');
    expect(scanForMarker(dir, 'TESTLAB_PRIVATE_ONLY')).toEqual([]);
  });

  it('finds a hit in a nested text file', () => {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'testlab-recorder.js'), 'const M="TESTLAB_PRIVATE_ONLY";');
    expect(scanForMarker(dir, 'TESTLAB_PRIVATE_ONLY')).toEqual(['plugins/testlab-recorder.js']);
  });

  it('finds a hit inside binary-ish (non-UTF8) bytes', () => {
    const needle = Buffer.from('TESTLAB_PRIVATE_ONLY', 'utf8');
    const junk = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0x80, 0x81]);
    const contents = Buffer.concat([junk, needle, junk]);
    writeFileSync(join(dir, 'app.asar'), contents);
    expect(scanForMarker(dir, 'TESTLAB_PRIVATE_ONLY')).toEqual(['app.asar']);
  });

  it('returns [] for a directory that does not exist', () => {
    expect(scanForMarker(join(dir, 'nope'), 'TESTLAB_PRIVATE_ONLY')).toEqual([]);
  });
});
