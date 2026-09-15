import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginManager } from '../PluginManager.js';

describe('plugin discovery readiness', () => {
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
