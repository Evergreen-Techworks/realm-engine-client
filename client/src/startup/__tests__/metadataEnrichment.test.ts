import { describe, expect, it, vi } from 'vitest';
import { startMetadataEnrichment } from '../metadataEnrichment.js';
import { startServices } from '../startServices.js';

describe('optional enrichment', () => {
  it('does not hold gameplay listeners while metadata remains pending', async () => {
    const controller = new AbortController();
    const publish = vi.fn();
    let finish!: (value: { ok: boolean; failed: string[] }) => void;
    const pending = startMetadataEnrichment({ signal: controller.signal, publish, run: () => new Promise(resolve => { finish = resolve; }) });
    const startProxy = vi.fn();
    const startPipe = vi.fn();
    await startServices({ signal: controller.signal, loadPlugins: async () => ({ loaded: [], failed: [] }), applyProfile() {}, startWatching() {}, publish() {}, startProxy, startPipe });
    expect(startProxy).toHaveBeenCalledOnce();
    expect(startPipe).toHaveBeenCalledOnce();
    expect(publish.mock.calls).toEqual([[{ state: 'loading', failed: [] }]]);
    finish({ ok: true, failed: [] });
    await pending;
    expect(publish.mock.calls.at(-1)).toEqual([{ state: 'available', failed: [] }]);
  });

  it.each([false, true])('catches optional failures (synchronous=%s)', async synchronous => {
    const publish = vi.fn();
    await startMetadataEnrichment({ signal: new AbortController().signal, publish, run: () => {
      if (synchronous) throw new Error('offline');
      return Promise.reject(new Error('offline'));
    } });
    expect(publish.mock.calls.at(-1)?.[0].state).toBe('unavailable');
  });

  it('publishes cancellation once and ignores late completion', async () => {
    const controller = new AbortController();
    const publish = vi.fn();
    let finish!: (value: { ok: boolean; failed: string[] }) => void;
    const pending = startMetadataEnrichment({ signal: controller.signal, publish, run: () => new Promise(resolve => { finish = resolve; }) });
    controller.abort();
    finish({ ok: true, failed: [] });
    await pending;
    expect(publish.mock.calls.map(call => call[0].state)).toEqual(['loading', 'cancelled']);
  });
});
