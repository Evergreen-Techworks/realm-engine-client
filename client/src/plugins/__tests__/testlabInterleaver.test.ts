import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** The real Auto Dodge shapes this suite exercises against, read through the
 *  general `describeOtherPluginSetting` hook — kept minimal (not the whole
 *  744-line plugin) but structurally identical to what `getSettings()` would
 *  hand back for these two real keys. */
const DEFAULT_DESCRIPTIONS: Record<string, any> = {
  udodgeEnemyStandoff: {
    type: 'select',
    options: [{ value: 'off' }, { value: 'auto' }],
    visibleWhen: { key: 'dodgeMode', value: 'unified' },
  },
  dodgeMode: {
    type: 'select',
    options: [{ value: 'off' }, { value: 'xdodge' }, { value: 'unified' }, { value: 'zdodge' }],
    // dodgeMode itself is never gated on anything.
  },
};

/**
 * A fake PluginContext that actually implements the enabled-setter ->
 * onEnabledChange-callback wiring the real PluginContext has (needed to
 * exercise the plugin's self-revert-on-refusal path), plus the cross-plugin
 * get/update/describe-other-plugin-setting surface PluginContext exposes for
 * this.
 */
function load(opts: { otherSettings?: Record<string, unknown>; descriptions?: Record<string, any> } = {}) {
  const settings = new Map<string, unknown>();
  const settingConfigs = new Map<string, any>();
  const changeCallbacks = new Map<string, (value: unknown) => void>();
  const enabledCallbacks: ((enabled: boolean) => void)[] = [];
  const cleanupFns: (() => void)[] = [];
  const dashboardLogs: string[] = [];
  const logs: string[] = [];
  const otherPluginUpdates: Array<[string, string, unknown]> = [];
  const otherSettings = new Map<string, unknown>(Object.entries(opts.otherSettings ?? { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' }));
  const descriptions = new Map<string, any>(Object.entries(opts.descriptions ?? DEFAULT_DESCRIPTIONS));
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
    describeOtherPluginSetting: vi.fn((_pluginId: string, key: string) => descriptions.get(key)),
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
    descriptions,
    runCleanup: () => cleanupFns.forEach((fn) => fn()),
    setEnabled: (v: boolean) => {
      (ctx as unknown as { enabled: boolean }).enabled = v;
    },
  };
}

/**
 * Enable the plugin and flush its deferred first-arm attempt.
 *
 * `testlab-interleaver.ts`'s `scheduleStart` deliberately arms one tick after
 * `enabled` flips true rather than synchronously inside the setter (see that
 * function's doc comment) — this is what lets it survive a per-run config
 * apply that enables the recorder and/or writes this plugin's own settings
 * in the same synchronous batch, moments AFTER this plugin's own `enabled`
 * flip. Every test that wants to observe a (successful or refused) start
 * must flush that tick with fake timers active, which is why `beforeEach`
 * below installs them for the whole suite.
 */
function arm(h: ReturnType<typeof load>): void {
  h.setEnabled(true);
  vi.advanceTimersByTime(0);
}

describe('Test Lab A/B interleaver plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearRecorderBus();
    vi.useRealTimers();
  });

  it('registers default DISABLED with a free-text target key (not a fixed switch list)', () => {
    setRecorderBus(true);
    const h = load();
    expect(h.ctx.enabled).toBe(false);
    const targetConfig = h.settingConfigs.get('target');
    expect(targetConfig.type).toBe('text');
    expect(h.settings.get('target')).toBe('udodgeEnemyStandoff');
    expect(h.settingConfigs.get('valueA').type).toBe('text');
    expect(h.settings.get('valueA')).toBe('off');
    expect(h.settings.get('valueB')).toBe('auto');
    expect(h.settings.get('blockMinutes')).toBe(3);
    h.runCleanup();
  });

  it('does not start when the recorder is disabled', () => {
    setRecorderBus(false);
    const h = load();
    arm(h);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/Test Lab Recorder is not enabled/);
    expect(h.ctx.enabled).toBe(false); // self-reverted
    h.runCleanup();
  });

  it('refuses an unknown target key', () => {
    setRecorderBus(true);
    const h = load();
    h.settings.set('target', 'notARealSetting');
    arm(h);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/Unknown Auto Dodge setting "notARealSetting"/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('does not start when the target is gated to a dodgeMode the plugin is not currently in', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'xdodge', udodgeEnemyStandoff: 'off' } });
    arm(h);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/only applies when dodgeMode=unified/);
    expect(h.dashboardLogs.at(-1)).toMatch(/xdodge/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('allows dodgeMode itself as a target regardless of the current mode', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'xdodge' } });
    h.settings.set('target', 'dodgeMode');
    h.settings.set('valueA', 'xdodge');
    h.settings.set('valueB', 'unified');
    arm(h);
    expect(h.otherPluginUpdates.length).toBeGreaterThan(0);
    const [pluginId, key, value] = h.otherPluginUpdates[0];
    expect(pluginId).toBe('auto-dodge');
    expect(key).toBe('dodgeMode');
    expect(['xdodge', 'unified']).toContain(value);
    h.runCleanup();
  });

  it('does not start when valueA === valueB', () => {
    setRecorderBus(true);
    const h = load();
    h.settings.set('valueA', 'off');
    h.settings.set('valueB', 'off');
    arm(h);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/nothing to compare/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('does not start when a requested value is not legal for the target', () => {
    setRecorderBus(true);
    const h = load();
    h.settings.set('valueB', 'bogus');
    arm(h);
    expect(h.otherPluginUpdates).toEqual([]);
    expect(h.dashboardLogs.at(-1)).toMatch(/bogus/);
    expect(h.ctx.enabled).toBe(false);
    h.runCleanup();
  });

  it('flips call the settings path with the right key/value and call mark', () => {
    const writer = setRecorderBus(true);
    const h = load();
    arm(h);

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

    // The normal-Logger line uses the documented `[TestLabAB] <key>=<value> block=<n> seed=<n>` format.
    expect(h.logs.at(-1)).toMatch(/^\[TestLabAB\] udodgeEnemyStandoff=(off|auto) block=0 seed=\d+$/);
    h.runCleanup();
  });

  it('marks ab.start once at start with key/a/b/blockMinutes/seed', () => {
    const writer = setRecorderBus(true);
    const h = load();
    arm(h);
    const startRecord = writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).find((r: any) => r.key === 'ab.start');
    expect(startRecord).toMatchObject({
      k: 'arm',
      key: 'ab.start',
      value: { key: 'udodgeEnemyStandoff', a: 'off', b: 'auto', blockMinutes: 3 },
    });
    expect(typeof (startRecord as any).value.seed).toBe('number');
    h.runCleanup();
  });

  it('restores the original value on disable, marks ab.stop with the reason, and logs why it stopped', () => {
    const writer = setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' } });
    arm(h);
    h.setEnabled(false);

    // Last update for the target key should restore the pre-flip value ('off').
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');

    const stopRecord = writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).find((r: any) => r.key === 'ab.stop');
    expect(stopRecord).toMatchObject({
      k: 'arm',
      key: 'ab.stop',
      value: { key: 'udodgeEnemyStandoff', restored: 'off', reason: 'disabled-by-user' },
    });
    expect(h.logs.at(-1)).toBe('[TestLabAB] stopped reason=disabled-by-user restored=off');
    h.runCleanup();
  });

  it('restores on plugin unload (registerCleanup) even without an explicit disable, and logs reason=plugin-unload', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' } });
    arm(h);
    h.otherPluginUpdates.length = 0; // clear the initial flip
    h.runCleanup();
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
    expect(h.logs.at(-1)).toBe('[TestLabAB] stopped reason=plugin-unload restored=off');
  });

  it('never throws when the recorder bus slot is entirely absent', () => {
    clearRecorderBus();
    const h = load();
    expect(() => h.setEnabled(true)).not.toThrow();
    expect(() => vi.advanceTimersByTime(0)).not.toThrow(); // flush the deferred first-arm attempt
    expect(h.ctx.enabled).toBe(false); // recorder-not-enabled refusal
    h.runCleanup();
  });

  it('delays the arm mark by SETTLE_MS after a dodgeMode flip, but applies the value and logs the flip immediately', () => {
    const writer = setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'xdodge' } });
    h.settings.set('target', 'dodgeMode');
    h.settings.set('valueA', 'xdodge');
    h.settings.set('valueB', 'unified');
    arm(h);

    // Applied and logged immediately.
    expect(h.otherPluginUpdates.some(([, key]) => key === 'dodgeMode')).toBe(true);
    expect(h.logs.at(-1)).toMatch(/^\[TestLabAB\] dodgeMode=(xdodge|unified) block=0 seed=\d+$/);

    // The per-arm mark (keyed 'dodgeMode') has NOT been written yet.
    const dodgeModeMarks = () => writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).filter((r: any) => r.key === 'dodgeMode');
    expect(dodgeModeMarks().length).toBe(0);

    vi.advanceTimersByTime(1999);
    expect(dodgeModeMarks().length).toBe(0);

    vi.advanceTimersByTime(1);
    expect(dodgeModeMarks().length).toBe(1);

    h.runCleanup();
  });

  it('stops mid-run with reason=recorder-disabled when the recorder is turned off during a run', () => {
    const writer = setRecorderBus(true);
    const h = load();
    arm(h); // armed while the recorder is still enabled -- this is the mid-RUN disable path, not the arm-time refusal.
    setRecorderBus(false, writer);

    vi.advanceTimersByTime(5000); // TICK_MS

    expect(h.ctx.enabled).toBe(false);
    expect(h.logs.at(-1)).toBe('[TestLabAB] stopped reason=recorder-disabled restored=off');
    // Restore is unconditional even though the recorder (now off) can't record it.
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
  });

  it('stops mid-run with reason=target-invalid when dodgeMode changes away from a mode-gated target', () => {
    setRecorderBus(true);
    const h = load({ otherSettings: { dodgeMode: 'unified', udodgeEnemyStandoff: 'off' } });
    arm(h);
    h.otherSettings.set('dodgeMode', 'xdodge'); // something else changed the mode mid-run

    vi.advanceTimersByTime(5000); // TICK_MS

    expect(h.ctx.enabled).toBe(false);
    expect(h.logs.at(-1)).toMatch(/^\[TestLabAB\] stopped reason=target-invalid restored=/);
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
  });

  it('stops mid-run with reason=target-invalid when the target setting disappears entirely', () => {
    setRecorderBus(true);
    const h = load();
    arm(h);
    h.descriptions.delete('udodgeEnemyStandoff'); // e.g. Auto Dodge unloaded/changed shape

    vi.advanceTimersByTime(5000);

    expect(h.ctx.enabled).toBe(false);
    expect(h.logs.at(-1)).toMatch(/^\[TestLabAB\] stopped reason=target-invalid restored=/);
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
  });

  it('stops mid-run with reason=error:<message> when something in the tick throws, and still restores', () => {
    setRecorderBus(true);
    const h = load();
    arm(h);
    (h.ctx as any).describeOtherPluginSetting = vi.fn(() => {
      throw new Error('boom');
    });

    vi.advanceTimersByTime(5000);

    expect(h.ctx.enabled).toBe(false);
    expect(h.logs.at(-1)).toBe('[TestLabAB] stopped reason=error:boom restored=off');
    const lastForKey = [...h.otherPluginUpdates].reverse().find(([, key]) => key === 'udodgeEnemyStandoff');
    expect(lastForKey?.[2]).toBe('off');
  });

  // ── Regression: 2026-09-20, runId 20260920T182708Z-9617 ──────────────────
  //
  // A real unattended run's run-request enabled BOTH `testlab-recorder` and
  // `testlab-interleaver` in one per-run plugin config, applied through
  // PluginConfigService.applyPluginConfigSnapshot in a single synchronous
  // pass. That function toggles every plugin's `enabled` (and then its
  // `settings`) in the order PluginManager.getPlugins() returns them —
  // alphabetical by plugin NAME. 'Test Lab A/B' sorts before 'Test Lab
  // Recorder', so this plugin's own enable-triggered start ran and
  // permanently refused (recorder not enabled YET) before the recorder's own
  // turn, later in that same pass, ever enabled it. The refusal was reported
  // only via ctx.dashboardLog (see the other fix in this file), so an
  // unattended run — nobody watching the dashboard — saw nothing at all: zero
  // arm records, zero "TestLabAB"/"interleav" lines anywhere in the proxy
  // log, for the entire run.
  //
  // These two plugins are exactly one instance of the general "enabled at
  // load time, no separate enabled-state transition, still in the middle of
  // a same-batch config apply" scenario: the plugin goes false -> true
  // exactly once (never disabled first), and other state that arming depends
  // on — a sibling plugin's enabled flag, or even this plugin's OWN
  // settings, applied by that same batch right after `enabled` per
  // PluginConfigService's per-plugin ordering — can still be mid-flight at
  // that single transition. Both must still arm.

  it('arms even when the recorder plugin is enabled AFTER this plugin, in the same synchronous config-apply batch', () => {
    setRecorderBus(false); // recorder not enabled YET at the instant this plugin turns on...
    const h = load();
    h.setEnabled(true); // ...enabled once, as a per-run config apply does (no prior disable -- no separate "transition").
    const writer = setRecorderBus(true); // ...recorder's own turn in the SAME synchronous batch enables it moments later.
    vi.advanceTimersByTime(0); // flush the deferred first-arm attempt, now that the batch has settled.

    expect(h.ctx.enabled).toBe(true); // still armed -- not permanently self-disabled by a since-resolved race.
    expect(h.otherPluginUpdates.length).toBeGreaterThan(0);
    expect(writer!.writeLine).toHaveBeenCalled();
    const startRecord = writer!.writeLine.mock.calls.map((c: unknown[]) => c[0]).find((r: any) => r.key === 'ab.start');
    expect(startRecord).toMatchObject({ k: 'arm', key: 'ab.start' });
    h.runCleanup();
  });

  it("arms against this run's requested settings even when they are applied to this plugin AFTER its own enable, in the same synchronous batch", () => {
    setRecorderBus(true);
    const h = load(); // defaults: target=udodgeEnemyStandoff, valueA=off, valueB=auto
    h.setEnabled(true); // enabled first, exactly as applyPluginConfigSnapshot does per-plugin...
    h.settings.set('target', 'dodgeMode'); // ...then this run's requested settings, still the same synchronous batch.
    h.settings.set('valueA', 'xdodge');
    h.settings.set('valueB', 'unified');
    vi.advanceTimersByTime(0); // flush the deferred first-arm attempt.

    expect(h.otherPluginUpdates.length).toBeGreaterThan(0);
    const [pluginId, key, value] = h.otherPluginUpdates[0];
    expect(pluginId).toBe('auto-dodge');
    // Armed against the FINAL settings applied by the batch, not the stale
    // defaults that were live at the instant `enabled` flipped true.
    expect(key).toBe('dodgeMode');
    expect(['xdodge', 'unified']).toContain(value);
    h.runCleanup();
  });
});
