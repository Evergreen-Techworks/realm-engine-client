import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../plugins/auto-dodge.js';
import type { PluginContext } from '../../../plugins/api.js';
import { setDllFeatureSender } from '../../bridge/DllFeatureBus.js';

// Tactician Slice 3: the udodgePlanner switch (tactician | classic, default tactician).
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

  it('is a unified-mode select that defaults to tactician', () => {
    const { configs } = load();
    const setting = configs.get('udodgePlanner');
    expect(setting).toBeDefined();
    expect(setting.label).toBe('[UDodge] Planner');
    expect(setting.type).toBe('select');
    expect(setting.value).toBe('tactician');
    expect(setting.options.map((o: { value: string }) => o.value)).toEqual(['tactician', 'classic']);
    expect(setting.visibleWhen).toEqual({ key: 'dodgeMode', value: 'unified' });
  });

  it('sends the chosen policy to the DLL as text', () => {
    const { callbacks, sent } = load();
    callbacks.get('udodgePlanner')!('classic');
    expect(sent).toContainEqual(['udodgePlanner', 'classic']);
    callbacks.get('udodgePlanner')!('anything-else');
    expect(sent.at(-1)).toEqual(['udodgePlanner', 'tactician']);
  });

  it('re-sends the saved policy when the client connects', () => {
    const { events, sent } = load({ udodgePlanner: 'classic' });
    sent.length = 0;
    events.get('clientConnected')!();
    expect(sent).toContainEqual(['udodgePlanner', 'classic']);
  });
});
