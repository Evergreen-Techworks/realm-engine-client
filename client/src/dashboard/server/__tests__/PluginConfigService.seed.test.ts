import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../util/Logger.js', () => ({
  Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Logger } from '../../../util/Logger.js';
import { PluginConfigService } from '../PluginConfigService.js';

// First-run seeding of <configsDir>/default.json from a bundled, frozen plugin
// setup (the portable pipeline injects it as data/plugin-defaults.json).

type FakeSetting = { key: string; type: string; value: unknown };
type FakePlugin = { id: string; name: string; enabled: boolean; hotkey: string; settings: FakeSetting[] };

function factoryPlugins(): FakePlugin[] {
  return [
    {
      id: 'auto-dodge',
      name: 'Auto Dodge',
      enabled: false,
      hotkey: '',
      settings: [
        { key: 'dodgeMode', type: 'select', value: 'xdodge' },
        { key: 'zdodgeDebugOverlay', type: 'select', value: 'on' },
        { key: 'resetDefaults', type: 'button', value: undefined },
      ],
    },
    { id: 'packet-logger', name: 'Packet Logger', enabled: true, hotkey: '', settings: [] },
    {
      id: 'server-switch',
      name: 'Server Switch',
      enabled: false,
      hotkey: '',
      settings: [{ key: 'server', type: 'select', value: 'USEast' }],
    },
  ];
}

function fakePluginManager(plugins: FakePlugin[]) {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const calls = {
    toggles: [] as Array<[string, boolean]>,
    hotkeys: [] as Array<[string, unknown]>,
    settings: [] as Array<[string, string, unknown]>,
  };
  const manager = {
    getPlugins: () => plugins.map((p) => ({ ...p, settings: p.settings.map((s) => ({ ...s })) })),
    togglePlugin: (id: string, enabled: boolean) => {
      calls.toggles.push([id, enabled]);
      const p = byId.get(id);
      if (!p) return { ok: false, reason: 'Plugin not found' };
      p.enabled = enabled;
      return { ok: true };
    },
    updatePluginHotkey: (id: string, hotkey: unknown) => {
      calls.hotkeys.push([id, hotkey]);
      const p = byId.get(id);
      if (!p) return { ok: false, reason: 'Plugin not found' };
      p.hotkey = String(hotkey);
      return { ok: true, hotkey: p.hotkey };
    },
    updateSetting: (id: string, key: string, value: unknown) => {
      calls.settings.push([id, key, value]);
      const setting = byId.get(id)?.settings.find((s) => s.key === key);
      if (!setting) return false;
      setting.value = value;
      return true;
    },
  };
  return { manager, calls, byId };
}

const VALID_SEED = {
  id: 'default',
  name: 'default',
  createdAt: 1789257577684,
  updatedAt: 1789260453215,
  plugins: [
    {
      id: 'auto-dodge',
      enabled: true,
      hotkey: 'F6',
      settings: { dodgeMode: 'zdodge', zdodgeDebugOverlay: 'off', resetDefaults: true },
    },
    { id: 'packet-logger', enabled: false, hotkey: '', settings: {} },
    { id: 'server-switch', enabled: true, hotkey: '', settings: { server: 'EUEast' } },
  ],
};

let root: string;
let configsDir: string;
let seedPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 're-plugin-seed-'));
  configsDir = join(root, 'RE_ASSETS', 'configs');
  seedPath = join(root, 'resources', 'data', 'plugin-defaults.json');
  vi.mocked(Logger.log).mockClear();
  vi.mocked(Logger.warn).mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSeed(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  const dir = join(root, 'resources', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(seedPath, bytes);
  return bytes;
}

function makeService(manager: unknown, bundledSeed: string | null = seedPath) {
  const setActive = vi.fn();
  const onConfigChanged = vi.fn();
  const service = new (PluginConfigService as any)(
    configsDir,
    manager,
    () => 'default',
    setActive,
    onConfigChanged,
    () => {},
    () => {},
    bundledSeed,
  ) as PluginConfigService;
  return { service, setActive, onConfigChanged };
}

function warnings(): string[] {
  return vi.mocked(Logger.warn).mock.calls.map((c) => String(c[1]));
}

function readDefault(): any {
  return JSON.parse(readFileSync(join(configsDir, 'default.json'), 'utf8'));
}

describe('PluginConfigService first-run plugin defaults seed', () => {
  it('applies a valid seed when no default.json exists, and writes it as default.json', () => {
    const seedBytes = writeSeed(JSON.stringify(VALID_SEED, null, 2));
    const { manager, calls, byId } = fakePluginManager(factoryPlugins());
    const { service, setActive, onConfigChanged } = makeService(manager);

    service.tryAutoLoadDefaultPluginConfig();

    // Applied to the live plugins...
    expect(byId.get('auto-dodge')!.enabled).toBe(true);
    expect(byId.get('auto-dodge')!.hotkey).toBe('F6');
    expect(byId.get('auto-dodge')!.settings.find((s) => s.key === 'dodgeMode')!.value).toBe('zdodge');
    expect(byId.get('auto-dodge')!.settings.find((s) => s.key === 'zdodgeDebugOverlay')!.value).toBe('off');
    expect(byId.get('packet-logger')!.enabled).toBe(false);
    expect(byId.get('server-switch')!.enabled).toBe(true);
    expect(byId.get('server-switch')!.settings[0].value).toBe('EUEast');
    // ...through the snapshot loader, which never "clicks" a button setting.
    expect(calls.settings.some(([, key]) => key === 'resetDefaults')).toBe(false);

    // ...and persisted as the default config.
    const written = readDefault();
    expect(written.id).toBe('default');
    const dodge = written.plugins.find((p: any) => p.id === 'auto-dodge');
    expect(dodge).toMatchObject({ enabled: true, hotkey: 'F6', settings: { dodgeMode: 'zdodge', zdodgeDebugOverlay: 'off' } });
    expect(written.plugins.find((p: any) => p.id === 'packet-logger').enabled).toBe(false);
    expect(written.plugins.find((p: any) => p.id === 'server-switch').settings.server).toBe('EUEast');
    expect(setActive).toHaveBeenCalledWith('default');
    expect(onConfigChanged).toHaveBeenCalledTimes(1);

    // The log ties this profile to the exact seed bytes the build recorded.
    const sha256 = createHash('sha256').update(seedBytes).digest('hex');
    const logged = vi.mocked(Logger.log).mock.calls.map((c) => String(c[1]));
    expect(logged.some((line) => line.includes(seedPath) && line.includes(sha256))).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it('never overwrites or merges into an existing default.json, byte for byte', () => {
    writeSeed(JSON.stringify(VALID_SEED));
    const existing = {
      id: 'default',
      name: 'default',
      createdAt: 5,
      updatedAt: 6,
      plugins: [
        { id: 'auto-dodge', enabled: false, hotkey: '', settings: { dodgeMode: 'repp' } },
        { id: 'server-switch', enabled: true, hotkey: '', settings: { server: 'USWest' } },
      ],
    };
    mkdirSync(configsDir, { recursive: true });
    const filePath = join(configsDir, 'default.json');
    // Unusual formatting and a trailing newline: any rewrite would change bytes.
    writeFileSync(filePath, JSON.stringify(existing, null, 3) + '\n\n');
    const before = readFileSync(filePath);
    const { manager, byId } = fakePluginManager(factoryPlugins());
    const { service } = makeService(manager);

    service.tryAutoLoadDefaultPluginConfig();

    expect(readFileSync(filePath).equals(before)).toBe(true);
    // The user's own config was loaded, not the seed.
    expect(byId.get('auto-dodge')!.hotkey).toBe('');
    expect(byId.get('auto-dodge')!.settings.find((s) => s.key === 'dodgeMode')!.value).toBe('repp');
    expect(byId.get('server-switch')!.settings[0].value).toBe('USWest');
    expect(byId.get('packet-logger')!.enabled).toBe(true);
  });

  it.each([
    ['invalid JSON', '{"plugins": [ '],
    ['JSON null', 'null'],
    ['an array', JSON.stringify(VALID_SEED.plugins)],
    ['no plugins array', JSON.stringify({ id: 'default', name: 'default' })],
    ['plugins not an array', JSON.stringify({ ...VALID_SEED, plugins: { 'auto-dodge': { enabled: true } } })],
    ['a plugin entry without an id', JSON.stringify({ ...VALID_SEED, plugins: [{ enabled: true, settings: {} }] })],
    ['a plugin entry that is not an object', JSON.stringify({ ...VALID_SEED, plugins: ['auto-dodge'] })],
  ])('falls back to factory defaults, with a warning, for a seed that is %s', (_label, text) => {
    writeSeed(text);
    const { manager, calls, byId } = fakePluginManager(factoryPlugins());
    const { service, setActive } = makeService(manager);

    service.tryAutoLoadDefaultPluginConfig();

    expect(calls.toggles).toEqual([]);
    expect(calls.settings).toEqual([]);
    expect(byId.get('packet-logger')!.enabled).toBe(true);
    const written = readDefault();
    expect(written.plugins.find((p: any) => p.id === 'auto-dodge')).toMatchObject({
      enabled: false,
      settings: { dodgeMode: 'xdodge', zdodgeDebugOverlay: 'on' },
    });
    expect(written.plugins.find((p: any) => p.id === 'packet-logger').enabled).toBe(true);
    expect(setActive).toHaveBeenCalledWith('default');
    expect(warnings().some((w) => w.includes(seedPath) && /factory defaults/i.test(w))).toBe(true);
  });

  it('skips a seed entry whose plugin is not loaded in this build, naming it, and applies the rest', () => {
    const seed = {
      ...VALID_SEED,
      plugins: [{ id: 'retired-plugin', enabled: true, hotkey: 'F9', settings: { level: 3 } }, ...VALID_SEED.plugins],
    };
    writeSeed(JSON.stringify(seed));
    const { manager, calls, byId } = fakePluginManager(factoryPlugins());
    const { service } = makeService(manager);

    expect(() => service.tryAutoLoadDefaultPluginConfig()).not.toThrow();

    expect(warnings().some((w) => w.includes('"retired-plugin"'))).toBe(true);
    expect(calls.toggles.some(([id]) => id === 'retired-plugin')).toBe(false);
    expect(calls.hotkeys.some(([id]) => id === 'retired-plugin')).toBe(false);
    expect(calls.settings.some(([id]) => id === 'retired-plugin')).toBe(false);
    expect(byId.get('auto-dodge')!.enabled).toBe(true);
    expect(byId.get('server-switch')!.settings[0].value).toBe('EUEast');
    const written = readDefault();
    expect(written.plugins.some((p: any) => p.id === 'retired-plugin')).toBe(false);
    expect(written.plugins.find((p: any) => p.id === 'auto-dodge').enabled).toBe(true);
  });

  it('keeps factory defaults when no seed is bundled', () => {
    const { manager, calls } = fakePluginManager(factoryPlugins());
    const { service } = makeService(manager);

    service.tryAutoLoadDefaultPluginConfig();

    expect(existsSync(seedPath)).toBe(false);
    expect(calls.toggles).toEqual([]);
    expect(readDefault().plugins.find((p: any) => p.id === 'packet-logger').enabled).toBe(true);
    expect(warnings()).toEqual([]);
  });

  it('keeps factory defaults when the service is built without a seed path', () => {
    writeSeed(JSON.stringify(VALID_SEED));
    const { manager, calls } = fakePluginManager(factoryPlugins());
    const { service } = makeService(manager, null);

    service.tryAutoLoadDefaultPluginConfig();

    expect(calls.toggles).toEqual([]);
    expect(readDefault().plugins.find((p: any) => p.id === 'packet-logger').enabled).toBe(true);
  });
});
