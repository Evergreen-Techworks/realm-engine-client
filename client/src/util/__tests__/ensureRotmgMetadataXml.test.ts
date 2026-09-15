import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRotmgMetadataXml } from '../ensureRotmgMetadataXml.js';

describe('metadata mirror cancellation', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'metadata-test-')); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

  it('does not fetch a warm file', async () => {
    writeFileSync(join(directory, 'enchantments.xml'), 'existing');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await ensureRotmgMetadataXml(directory)).toEqual({ ok: true, failed: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out each of six hanging candidates', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    vi.stubGlobal('fetch', fetcher);
    const pending = ensureRotmgMetadataXml(directory, { bases: ['https://one/', 'https://two/'] });
    await vi.advanceTimersByTimeAsync(48000);
    expect(await pending).toEqual({ ok: false, failed: ['enchantments.xml'] });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('parent cancellation stops before another candidate or destination write', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    vi.stubGlobal('fetch', fetcher);
    const pending = ensureRotmgMetadataXml(directory, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow();
    controller.abort();
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(existsSync(join(directory, 'enchantments.xml'))).toBe(false);
  });

  it('does not write when cancelled after body resolution', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => { controller.abort(); return new ArrayBuffer(100); } })));
    await expect(ensureRotmgMetadataXml(directory, { signal: controller.signal })).rejects.toThrow();
    expect(existsSync(join(directory, 'enchantments.xml'))).toBe(false);
  });
});
