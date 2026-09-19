import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../plugins/auto-dodge.js';
import type { PluginContext } from '../../../plugins/api.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';

// Tactician Slice 3: the udodgePlanner switch (classic | tactician, default classic).
describe('auto-dodge udodgePlanner', () => {
  afterEach(() => setDllFeatureSender(null));

  function load(saved: Record<string, unknown> = {}) {
    const configs = new Map<string, any>();
    const callbacks = new Map<string, (value: any) => void>();
    const events = new Map<string, () => void>();
    const ctx = {
      enabled: true,
      registerSetting: vi.fn((key: string, config: any, cb?: (value: any) => void) => {
        configs.set(key, config);
        if (cb) callbacks.set(key, cb);
      }),
      getSetting: vi.fn((key: string) => (key in saved ? saved[key] : configs.get(key)?.value)),
      hookPacket: vi.fn(),
      on: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      onEnabledChange: vi.fn(),
      registerCleanup: vi.fn(),
      log: vi.fn(),
    } as unknown as PluginContext;
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    register(ctx);
    return { configs, callbacks, events, sent };
  }

  it('is a unified-mode select that defaults to classic', () => {
    const { configs } = load();
    const setting = configs.get('udodgePlanner');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Planner');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('classic');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['classic', 'tactician']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen policy to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgePlanner')!('tactician');
    expect(sent).toContainEqual(['udodgePlanner', 'tactician']);
    callbacks.get('udodgePlanner')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgePlanner', 'classic']);
  });

  it('re-sends the saved policy when the client connects', () => {
    const { events, sent } = load({ udodgePlanner: 'classic' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgePlanner', 'classic']);
  });
});

// ENEMY STANDOFF: the udodgeEnemyStandoff switch (auto | off, default off —
// owner ruling 2026-09-19: unproven behaviour ships behind a switch, default
// off, after private 1.0.18 dodged worse with this on).
describe('auto-dodge udodgeEnemyStandoff', () => {
  afterEach(() => setDllFeatureSender(null));

  function load(saved: Record<string, unknown> = {}) {
    const configs = new Map<string, any>();
    const callbacks = new Map<string, (value: any) => void>();
    const events = new Map<string, () => void>();
    const ctx = {
      enabled: true,
      registerSetting: vi.fn((key: string, config: any, cb?: (value: any) => void) => {
        configs.set(key, config);
        if (cb) callbacks.set(key, cb);
      }),
      getSetting: vi.fn((key: string) => (key in saved ? saved[key] : configs.get(key)?.value)),
      hookPacket: vi.fn(),
      on: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      onEnabledChange: vi.fn(),
      registerCleanup: vi.fn(),
      log: vi.fn(),
    } as unknown as PluginContext;
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    register(ctx);
    return { configs, callbacks, events, sent };
  }

  it('is a unified-mode select that defaults to off', () => {
    const { configs } = load();
    const setting = configs.get('udodgeEnemyStandoff');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Enemy standoff');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('off');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['auto', 'off']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen mode to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgeEnemyStandoff')!('off');
    expect(sent).toContainEqual(['udodgeEnemyStandoff', 'off']);
    callbacks.get('udodgeEnemyStandoff')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgeEnemyStandoff', 'auto']);
  });

  it('re-sends the saved mode when the client connects', () => {
    const { events, sent } = load({ udodgeEnemyStandoff: 'off' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeEnemyStandoff', 'off']);
  });

  it('re-sends off when nothing has been saved (the new default)', () => {
    const { events, sent } = load();
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeEnemyStandoff', 'off']);
  });

  it('an explicitly saved auto still resends auto (the ON path)', () => {
    const { events, sent } = load({ udodgeEnemyStandoff: 'auto' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeEnemyStandoff', 'auto']);
  });
});

// Navigation finish plan, Item 1: the udodgeRouteCommit switch (on | off,
// default off — owner ruling 2026-09-19: unproven behaviour ships behind a
// switch, default off, after private 1.0.18 dodged worse with this on).
describe('auto-dodge udodgeRouteCommit', () => {
  afterEach(() => setDllFeatureSender(null));

  function load(saved: Record<string, unknown> = {}) {
    const configs = new Map<string, any>();
    const callbacks = new Map<string, (value: any) => void>();
    const events = new Map<string, () => void>();
    const ctx = {
      enabled: true,
      registerSetting: vi.fn((key: string, config: any, cb?: (value: any) => void) => {
        configs.set(key, config);
        if (cb) callbacks.set(key, cb);
      }),
      getSetting: vi.fn((key: string) => (key in saved ? saved[key] : configs.get(key)?.value)),
      hookPacket: vi.fn(),
      on: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      onEnabledChange: vi.fn(),
      registerCleanup: vi.fn(),
      log: vi.fn(),
    } as unknown as PluginContext;
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    register(ctx);
    return { configs, callbacks, events, sent };
  }

  it('is a unified-mode select that defaults to off', () => {
    const { configs } = load();
    const setting = configs.get('udodgeRouteCommit');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Route commitment');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('off');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['on', 'off']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen state to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgeRouteCommit')!('off');
    expect(sent).toContainEqual(['udodgeRouteCommit', 'off']);
    callbacks.get('udodgeRouteCommit')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgeRouteCommit', 'on']);
  });

  it('re-sends the saved state when the client connects', () => {
    const { events, sent } = load({ udodgeRouteCommit: 'off' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeRouteCommit', 'off']);
  });

  it('re-sends off when nothing has been saved (the new default)', () => {
    const { events, sent } = load();
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeRouteCommit', 'off']);
  });

  it('an explicitly saved on still resends on (the ON path)', () => {
    const { events, sent } = load({ udodgeRouteCommit: 'on' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeRouteCommit', 'on']);
  });
});

// Navigation finish plan, item 2: the udodgeFallbackSidestep switch (on | off,
// default off — owner ruling 2026-09-19: unproven behaviour ships behind a
// switch, default off, after private 1.0.18 dodged worse with this on).
describe('auto-dodge udodgeFallbackSidestep', () => {
  afterEach(() => setDllFeatureSender(null));

  function load(saved: Record<string, unknown> = {}) {
    const configs = new Map<string, any>();
    const callbacks = new Map<string, (value: any) => void>();
    const events = new Map<string, () => void>();
    const ctx = {
      enabled: true,
      registerSetting: vi.fn((key: string, config: any, cb?: (value: any) => void) => {
        configs.set(key, config);
        if (cb) callbacks.set(key, cb);
      }),
      getSetting: vi.fn((key: string) => (key in saved ? saved[key] : configs.get(key)?.value)),
      hookPacket: vi.fn(),
      on: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      onEnabledChange: vi.fn(),
      registerCleanup: vi.fn(),
      log: vi.fn(),
    } as unknown as PluginContext;
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    register(ctx);
    return { configs, callbacks, events, sent };
  }

  it('is a unified-mode select that defaults to off', () => {
    const { configs } = load();
    const setting = configs.get('udodgeFallbackSidestep');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Fallback sidestep');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('off');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['on', 'off']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen state to the DLL as 0/1', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgeFallbackSidestep')!('on');
    expect(sent).toContainEqual(['udodgeFallbackSidestep', 1]);
    callbacks.get('udodgeFallbackSidestep')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgeFallbackSidestep', 0]);
  });

  it('re-sends off when nothing has been saved (the new default)', () => {
    const { events, sent } = load();
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeFallbackSidestep', 0]);
  });

  it('an explicitly saved on still resends on (the ON path)', () => {
    const { events, sent } = load({ udodgeFallbackSidestep: 'on' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeFallbackSidestep', 1]);
  });
});

// Navigation finish plan, item 4: the udodgeFrameBudget switch (auto | off,
// default off — owner ruling 2026-09-19: unproven behaviour ships behind a
// switch, default off, after private 1.0.18 dodged worse with this on).
describe('auto-dodge udodgeFrameBudget', () => {
  afterEach(() => setDllFeatureSender(null));

  function load(saved: Record<string, unknown> = {}) {
    const configs = new Map<string, any>();
    const callbacks = new Map<string, (value: any) => void>();
    const events = new Map<string, () => void>();
    const ctx = {
      enabled: true,
      registerSetting: vi.fn((key: string, config: any, cb?: (value: any) => void) => {
        configs.set(key, config);
        if (cb) callbacks.set(key, cb);
      }),
      getSetting: vi.fn((key: string) => (key in saved ? saved[key] : configs.get(key)?.value)),
      hookPacket: vi.fn(),
      on: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      onEnabledChange: vi.fn(),
      registerCleanup: vi.fn(),
      log: vi.fn(),
    } as unknown as PluginContext;
    const sent: Array<[string, unknown]> = [];
    setDllFeatureSender((key, value) => { sent.push([key, value]); });
    register(ctx);
    return { configs, callbacks, events, sent };
  }

  it('is a unified-mode select that defaults to off', () => {
    const { configs } = load();
    const setting = configs.get('udodgeFrameBudget');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Frame budget');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('off');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['auto', 'off']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen state to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgeFrameBudget')!('off');
    expect(sent).toContainEqual(['udodgeFrameBudget', 'off']);
    callbacks.get('udodgeFrameBudget')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgeFrameBudget', 'auto']);
  });

  it('re-sends off when nothing has been saved (the new default)', () => {
    const { events, sent } = load();
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeFrameBudget', 'off']);
  });

  it('an explicitly saved auto still resends auto (the ON path)', () => {
    const { events, sent } = load({ udodgeFrameBudget: 'auto' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgeFrameBudget', 'auto']);
  });
});
