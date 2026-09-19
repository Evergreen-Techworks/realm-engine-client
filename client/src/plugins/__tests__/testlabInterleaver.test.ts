import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../plugins/testlab-interleaver.js';
import type { PluginContext } from '../../../plugins/api.js';

const RECORDER_BUS_SLOT_KEY = '__realmengine_testlabRecorderBus_v1';

interface FakeWriter {
  writeLine: ReturnType<typeof vi.fn>;
}

function setRecorderBus(enabled: boolean, writer: FakeWriter | null = { writeLine: vi.fn() }) {
  (globalThis as unknown as Record<string, unknown>)[RECORDER_BUS_SLOT_KEY] = { enabled, writer };
  return writer;
}

function clearRecorderBus() {
  delete (globalThis as unknown as Record<string, unknown>)[RECORDER_BUS_SLOT_KEY];
}

/**
 * A fake PluginContext that actually implements the enabled-setter ->
 * onEnabledChange-callback wiring the real PluginContext has (needed to
 * exercise the plugin's self-revert-on-refusal path), plus the cross-plugin
 * get/update-other-plugin-setting surface this task added to PluginContext.
 */
function load(opts: { otherSettings?: Record<string, unknown> } = {}) {
  const settings = new Map<string, unknown>();
  const settingConfigs = new Map<string, any>();
  const changeCallbacks = new Map<string, (value: unknown) => void>();
  const enabledCallbacks: ((enabled: boolean) => void)[] = [];
  const cleanupFns: (() => void)[] = [];
  const dashboardLogs: string[] = [];
  const logs: string[] = [];
  const otherPluginUpdates: Array<[string, string, unknown]> = [];
  const otherSettings = new Map<string, unknown>(Object.entries(opts.otherSettings ?? { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' }));
  let _enabled = false;

  const ctx = {
    setData: vi.fn(),
    get enabled() {
      return _enabled;
    },
    set enabled(v: boolean) {
      _enabled = v;
      for (const cb of [...enabledCallbacks]) cb(v);
    },
    registerSetting: vi.fn((key: string, config: any, cb?: (value: unknown) => void) => {
      settingConfigs.set(key, config);
      settings.set(key, config.value);
      if (cb) changeCallbacks.set(key, cb);
    }),
    updateSetting: vi.fn((key: string, value: unknown) => {
      settings.set(key, value);
      const cb = changeCallbacks.get(key);
      if (cb) cb(value);
      return true;
    }),
    getSetting: vi.fn((key: string) => settings.get(key)),
    getOtherPluginSetting: vi.fn((_pluginId: string, key: string) => otherSettings.get(key)),
    updateOtherPluginSetting: vi.fn((pluginId: string, key: string, value: unknown) => {
      otherPluginUpdates.push([pluginId, key, value]);
      otherSettings.set(key, value);
      return true;
    }),
    dashboardLog: vi.fn((msg: string) => dashboardLogs.push(msg)),
    log: vi.fn((msg: string) => logs.push(msg)),
    onEnabledChange: vi.fn((cb: (enabled: boolean) => void) => enabledCallbacks.push(cb)),
    registerCleanup: vi.fn((fn: () => void) => cleanupFns.push(fn)),
  } as unknown as PluginContext;

  register(ctx);

  return {
    ctx,
    settings,
    settingConfigs,
    dashboardLogs,
    logs,
    otherPluginUpdates,
    otherSettings,
    runCleanup: () => cleanupFns.forEach((fn) => fn()),
    setEnabled: (v: boolean) => {
      (ctx as unknown as { enabled: boolean }).enabled = v;
    },
  };
}

describe('Test Lab A/B interleaver plugin', () => {
  afterEach(() => {
    clearRecorderBus();
  });

  it('registers default DISABLED with the four real Auto Dodge switch keys', () => {
    setRecorderBus(true);
    const h = load();
    expect(h.ctx.enabled).toBe(false);
    const targetConfig = h.settingConfigs.get('target');
    expect(targetConfig.type).toBe('select');
    expect(targetConfig.options.map((o: { value: string }) => o.value).sort()).toEqual(
      ['udodgeEnemyStandoff', 'udodgeFallbackSidestep', 'udodgeFrameBudget', 'udodgeRouteCommit'].sort(),
    );
    expect(h.settings.get('valueA')).toBe('off');
    expect(h.settings.get('valueB')).toBe('auto'); // Enemy standoff's on value is 'auto', not 'on'.
    expect(h.settings.get('blockMinutes')).toBe(3);
    h.runCleanup();
  });

  it('does not start when the recorder is disabled', () => {
    setRecorderBus(false);
    const h = load();
    h.setEnabled(true);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/Test Lab Recorder is not enabled/);
    expect(h.ctx.enabled).toBe(false); // self-reverted
    h.runCleanup();
  });

  it('does not start when Dodge mode is not Unified', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'xdodge', udodgeEnemyStandoff: 'off' } });
    h.setEnabled(true);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/Dodge mode is not Unified/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('does not start when valueA === valueB', () => {
    setRecorderBus(true);
    const h = load();
    h.settings.set('valueA', 'off');
    h.settings.set('valueB', 'off');
    h.setEnabled(true);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/nothing to compare/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('flips call the settings path with the right key/value and call mark', () => {
    const writer = setRecorderBus(true);
    const h = load();
    h.setEnabled(true);

    // The settings path: PluginManager.updateSetting-equivalent for the
    // 'auto-dodge' plugin's real setting key, with the real legal value.
    expect(h.otherPluginUpdates.length).toBeGreaterThan(0);
    const [pluginId, key, value] = h.otherPluginUpdates[0];
    expect(pluginId).toBe('auto-dodge');
    expect(key).toBe('udodgeEnemyStandoff');
    expect(['off', 'auto']).toContain(value);

    // mark() went through the recorder's bus slot with an arm record shape.
    expect(writer!.writeLine).toHaveBeenCalled();
    const [record] = writer!.writeLine.mock.calls[0];
    expect(record).toMatchObject({ k: 'arm', key: 'ab.start' });

    // The normal-Logger line uses the exact format from the brief.
    expect(h.logs.at(-1)).toMatch(/^\[TestLabAB\] udodgeEnemyStandoff=(off|auto) block=0 seed=\d+$/);
    h.runCleanup();
  });

  it('marks ab.start once at start with key/a/b/blockMinutes/seed', () => {
    const writer = setRecorderBus(true);
    const h = load();
    h.setEnabled(true);
    const startRecord = writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).find((r: any) => r.key === 'ab.start');
    expect(startRecord).toMatchObject({
      k: 'arm',
      key: 'ab.start',
      value: { key: 'udodgeEnemyStandoff', a: 'off', b: 'auto', blockMinutes: 3 },
    });
    expect(typeof (startRecord as any).value.seed).toBe('number');
    h.runCleanup();
  });

  it('restores the original value on disable and marks ab.stop', () => {
    const writer = setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' } });
    h.setEnabled(true);
    h.setEnabled(false);

    // Last update for the target key should restore the pre-flip value ('off').
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');

    const stopRecord = writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).find((r: any) => r.key === 'ab.stop');
    expect(stopRecord).toMatchObject({ k: 'arm', key: 'ab.stop', value: { key: 'udodgeEnemyStandoff', restored: 'off' } });
    h.runCleanup();
  });

  it('restores on plugin unload (registerCleanup) even without an explicit disable', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' } });
    h.setEnabled(true);
    h.otherPluginUpdates.length = 0; // clear the initial flip
    h.runCleanup();
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
  });

  it('never throws when the recorder bus slot is entirely absent', () => {
    clearRecorderBus();
    const h = load();
    expect(() => h.setEnabled(true)).not.toThrow();
    expect(h.ctx.enabled).toBe(false); // recorder-not-enabled refusal
    h.runCleanup();
  });

  it('re-defaults valueA/valueB when the target changes', () => {
    setRecorderBus(true);
    const h = load();
    h.ctx.updateSetting('target', 'udodgeRouteCommit');
    expect(h.settings.get('valueA')).toBe('off');
    expect(h.settings.get('valueB')).toBe('on');
    h.runCleanup();
  });
});
