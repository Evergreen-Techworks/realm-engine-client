import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../plugins/auto-dodge.js';
import type { PluginContext } from '../../../plugins/api.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';

// Navigation rebuild Stage 1: the navCollisionRule toggle (legacy | game, default legacy).
describe('auto-dodge navCollisionRule', () => {
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

  it('is a unified-mode select that defaults to legacy', () => {
    const { configs } = load();
    const setting = configs.get('navCollisionRule');
    expect(setting).toBeDefined();
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('legacy');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['legacy', 'game']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen rule to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('navCollisionRule')!('game');
    expect(sent).toContainEqual(['navCollisionRule', 'game']);
    callbacks.get('navCollisionRule')!('anything-else');
    expect(sent.at(-1)).toEqual(['navCollisionRule', 'legacy']);
  });

  it('re-sends the saved rule when the client connects', () => {
    const { events, sent } = load({ navCollisionRule: 'game' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['navCollisionRule', 'game']);
  });
  it('exposes opt-in persistent point routing without changing legacy defaults', () => {
    const { configs, callbacks, sent } = load();
    const setting = configs.get('navNavigator');
    expect(setting).toBeDefined();
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('legacy');
    expect(setting.options.map((option: { value: string }) => option.value)).toEqual(['legacy', 'dstar']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
    callbacks.get('navNavigator')!('dstar');
    expect(sent.at(-1)).toEqual(['navNavigator', 'dstar']);
    callbacks.get('navNavigator')!('invalid');
    expect(sent.at(-1)).toEqual(['navNavigator', 'legacy']);
  });
  it('resends the saved global routing opt-in on connection and leaves absent settings legacy', () => {
    const optedIn = load({ navNavigator: 'dstar' });
    optedIn.events.get('clientConnected')!();
    expect(optedIn.sent).toContainEqual(['navNavigator', 'dstar']);
    const defaults = load();
    defaults.events.get('clientConnected')!();
    expect(defaults.sent).toContainEqual(['navNavigator', 'legacy']);
  });
});
