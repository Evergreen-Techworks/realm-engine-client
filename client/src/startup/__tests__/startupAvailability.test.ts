import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DevServer } from '../../dashboard/server/DevServer.js';
import { WS_MSG } from '../../dashboard/wsMessageTypes.js';
import { startMetadataEnrichment } from '../metadataEnrichment.js';
import { startServices } from '../startServices.js';
import { register as registerDamageSniffer } from '../../../plugins/damage-sniffer.js';
import { AbilityScalingManager } from '../../damage-sniffer/abilityScalingManager.js';

describe('dashboard startup availability', () => {
  function fixture() {
    const server = Object.create(DevServer.prototype) as any;
    const socket = { readyState: 1, send: vi.fn(), on: vi.fn() };
    Object.assign(server, {
      wss: { clients: new Set([socket]) },
      pluginManager: { getPlugins: () => [], getPluginData: () => undefined },
      lastUnresolvedClasses: null, configResetNotice: null,
      inspector: { getRecent: () => [], subscribe: () => () => {} },
      buildConfigMessage: () => '{}', lab: { getUnknowns: () => [] },
      gameUpdater: { getStatus: () => ({}) }, autoUpdateCheckDone: true,
    });
    return { server, socket };
  }

  it('broadcasts loading, degraded plugins, then availability and replays the snapshot', () => {
    const { server, socket } = fixture();
    const loading = { metadata: { state: 'loading', failed: [] }, plugins: null };
    server.setStartupStatus(loading);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: WS_MSG.STARTUP_STATUS, ...loading });
    const ready = { metadata: { state: 'available', failed: [] }, plugins: { loaded: ['damage-sniffer'], failed: ['broken'] } };
    server.setStartupStatus(ready);
    ready.plugins.failed.push('mutated externally');
    const newcomer = { readyState: 1, send: vi.fn(), on: vi.fn() };
    server.handleWsConnection(newcomer);
    const status = newcomer.send.mock.calls.map(call => JSON.parse(call[0])).find(message => message.type === WS_MSG.STARTUP_STATUS);
    expect(status.plugins.failed).toEqual(['broken']);
    expect(status.metadata.state).toBe('available');
  });

  it('does not publish after shutdown', () => {
    const { server, socket } = fixture();
    server.startupStopped = true;
    server.setStartupStatus({ metadata: { state: 'available', failed: [] }, plugins: null });
    expect(socket.send).not.toHaveBeenCalled();
    expect(readFileSync(new URL('../../dashboard/server/DevServer.ts', import.meta.url), 'utf8')).toMatch(/stop\(\): void \{\s*this.startupStopped = true/);
  });

  it('retains the objects-based scaling handoff and has no invented enchant refresh', () => {
    const plugin = readFileSync(new URL('../../../plugins/damage-sniffer.ts', import.meta.url), 'utf8');
    expect(plugin.match(/takeParsedObjects\(/g)).toHaveLength(1);
    expect(plugin).toContain('loadFromParsedObjects');
    expect(plugin).not.toContain('loadEnchantments');
    const entry = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
    expect(entry).toContain('void startMetadataEnrichment({');
    expect(entry.indexOf('void startMetadataEnrichment({')).toBeLessThan(entry.indexOf('await startServices({'));
  });

  it('initializes objects scaling once even when metadata completes later', async () => {
    const controller = new AbortController();
    let finish!: (value: { ok: boolean; failed: string[] }) => void;
    const pending = startMetadataEnrichment({ signal: controller.signal, publish() {}, run: () => new Promise(resolve => { finish = resolve; }) });
    const objects = { Objects: { Object: [] } };
    const takeParsedObjects = vi.fn(() => objects);
    const load = vi.spyOn(AbilityScalingManager.prototype, 'loadFromParsedObjects');
    const context = new Proxy({ gameData: { takeParsedObjects } } as any, {
      get(target, key) { return key in target ? target[key] : vi.fn(); },
    });
    try {
      await startServices({ signal: controller.signal, loadPlugins: async () => { registerDamageSniffer(context); return { loaded: ['damage-sniffer'], failed: [] }; }, applyProfile() {}, startWatching() {}, publish() {}, startProxy() {}, startPipe() {} });
      expect(takeParsedObjects).toHaveBeenCalledOnce();
      expect(load).toHaveBeenCalledWith(objects);
      finish({ ok: true, failed: [] });
      await pending;
      expect(load).toHaveBeenCalledOnce();
    } finally {
      load.mockRestore();
      controller.abort();
    }
  });
});
