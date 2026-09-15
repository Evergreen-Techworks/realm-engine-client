import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { startServices } from '../startServices.js';

describe('mandatory startup boundary', () => {
  function fixture() {
    const controller = new AbortController();
    const calls: string[] = [];
    const deps = {
      signal: controller.signal,
      loadPlugins: async () => ({ loaded: ['auto-nexus'], failed: ['user-broken'] }),
      applyProfile: async () => {},
      startWatching: async () => { calls.push('watch'); },
      publish: vi.fn(() => { calls.push('report'); }),
      startProxy: () => { calls.push('proxy'); },
      startPipe: () => { calls.push('pipe'); },
    };
    return { controller, calls, deps };
  }

  it('waits for the saved profile and publishes degraded readiness before listeners', async () => {
    const { deps, calls } = fixture();
    let finish!: () => void;
    deps.applyProfile = () => new Promise<void>(resolve => { finish = resolve; });
    const run = startServices(deps);
    await Promise.resolve();
    expect(calls).toEqual([]);
    finish();
    await run;
    expect(calls).toEqual(['watch', 'report', 'proxy', 'pipe']);
    expect(deps.publish).toHaveBeenCalledWith({ loaded: ['auto-nexus'], failed: ['user-broken'] });
  });

  it.each(['loadPlugins', 'applyProfile', 'startWatching'] as const)('cancels during %s', async boundary => {
    const { deps, controller, calls } = fixture();
    const original = deps[boundary];
    Object.assign(deps, { [boundary]: async () => { const result = await original(); controller.abort(); return result; } });
    await startServices(deps);
    expect(calls).not.toContain('proxy');
    expect(calls).not.toContain('pipe');
  });

  it('does not open listeners on mandatory failure or a pre-aborted signal', async () => {
    const { deps, controller, calls } = fixture();
    deps.applyProfile = () => { throw new Error('profile failed'); };
    await expect(startServices(deps)).rejects.toThrow('profile failed');
    expect(calls).toEqual([]);
    controller.abort();
    await startServices(deps);
    expect(calls).toEqual([]);
  });

  it('is used by the production entry point', () => {
    expect(readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')).toContain('await startServices({');
  });
});
