import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from '../PluginManager.js';

describe('plugin discovery readiness', () => {
  it('awaits asynchronous registration before declaring a plugin ready', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'plugin-async-'));
    try {
      writeFileSync(join(directory, 'good.js'), 'export async function register() { await new Promise(resolve => { globalThis.__pluginFinish = resolve; }); globalThis.__pluginReadinessFixture = "ready"; }');
      const manager = new PluginManager({} as any, directory, join(directory, 'absent'), true);
      const completed = vi.fn();
      const pending = manager.loadPlugin(join(directory, 'good.js')).then(completed);
      await vi.waitFor(() => expect((globalThis as any).__pluginFinish).toBeTypeOf('function'));
      expect(completed).not.toHaveBeenCalled();
      (globalThis as any).__pluginFinish();
      await pending;
      expect((globalThis as any).__pluginReadinessFixture).toBe('ready');
    } finally {
      delete (globalThis as any).__pluginReadinessFixture;
      (globalThis as any).__pluginFinish?.();
      delete (globalThis as any).__pluginFinish;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('reports throwing and invalid registrations while continuing discovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'plugin-readiness-'));
    try {
      writeFileSync(join(directory, 'broken.js'), 'export function register() { throw new Error("fixture failure"); }');
      writeFileSync(join(directory, 'invalid.js'), 'export const value = 1;');
      writeFileSync(join(directory, 'good.js'), 'export function register() {}');
      const manager = new PluginManager({} as any, directory, join(directory, 'absent'), true);
      expect(await manager.loadAll()).toEqual({ loaded: ['good'], failed: ['broken', 'invalid'] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
