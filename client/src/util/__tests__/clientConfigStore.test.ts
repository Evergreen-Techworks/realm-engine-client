import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMergedClientConfigRaw, writeClientConfig } from '../clientConfigStore.js';

// The dashboard saves the game folder and last plugin config through
// writeClientConfig; startup reads them back through readMergedClientConfigRaw.
// A packaged app's resources tree is replaced (the portable EXE unpacks a new
// one per build), so saves must land in the user overlay that main.cjs sets.

function resourcesTree(root: string, name: string): string {
  const resources = join(root, 'app', name, 'resources');
  mkdirSync(join(resources, 'data'), { recursive: true });
  writeFileSync(join(resources, 'data', 'config.json'), '{}\n');
  return resources;
}

describe('client config persistence', () => {
  let root: string;
  let savedOverlay: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'client-config-'));
    savedOverlay = process.env.REALM_ENGINE_USER_CONFIG_PATH;
  });

  afterEach(() => {
    if (savedOverlay === undefined) delete process.env.REALM_ENGINE_USER_CONFIG_PATH;
    else process.env.REALM_ENGINE_USER_CONFIG_PATH = savedOverlay;
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps a saved game folder when a new resources tree replaces the old one', () => {
    const overlay = join(root, 'RE_ASSETS', 'realm-engine', 'config.json');
    process.env.REALM_ENGINE_USER_CONFIG_PATH = overlay;
    const first = resourcesTree(root, 'build-a');

    const written = writeClientConfig(first, { rotmgPath: 'D:\\Games\\RotMG Exalt', lastPluginConfigId: 'farming' });

    expect(written).toBe(overlay);
    expect(readFileSync(join(first, 'data', 'config.json'), 'utf8')).toBe('{}\n');
    const next = resourcesTree(root, 'build-b');
    const loaded = readMergedClientConfigRaw(next);
    expect(loaded.rotmgPath).toBe('D:\\Games\\RotMG Exalt');
    expect(loaded.lastPluginConfigId).toBe('farming');
  });

  it('keeps keys it was not asked to change and drops cleared ones', () => {
    const overlay = join(root, 'user', 'config.json');
    process.env.REALM_ENGINE_USER_CONFIG_PATH = overlay;
    mkdirSync(join(root, 'user'));
    writeFileSync(overlay, JSON.stringify({ skipWinhttpInstall: true, rotmgPath: 'C:\\Old' }));
    const resources = resourcesTree(root, 'build');

    writeClientConfig(resources, { rotmgPath: undefined, lastPluginConfigId: 'default' });

    expect(JSON.parse(readFileSync(overlay, 'utf8'))).toEqual({ skipWinhttpInstall: true, lastPluginConfigId: 'default' });
  });

  it('writes the bundled data/config.json when no overlay is configured (dev)', () => {
    delete process.env.REALM_ENGINE_USER_CONFIG_PATH;
    const resources = resourcesTree(root, 'dev');

    const written = writeClientConfig(resources, { rotmgPath: 'C:\\Dev\\Game' });

    expect(written).toBe(join(resources, 'data', 'config.json'));
    expect(readMergedClientConfigRaw(resources).rotmgPath).toBe('C:\\Dev\\Game');
  });
});
