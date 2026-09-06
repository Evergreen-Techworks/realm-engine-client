import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { PluginManager } from '../../plugins/PluginManager.js';
import { Logger } from '../../util/Logger.js';

const DEFAULT_PLUGIN_CONFIG_ID = 'default';
const DEFAULT_PLUGIN_CONFIG_NAME = 'default';

/**
 * Manages plugin configuration persistence: save/load/autosave of plugin
 * snapshots (enabled state, hotkeys, settings per plugin). Extracted from
 * DevServer to isolate config snapshot responsibility.
 *
 * Constructor callbacks provide the DevServer hooks that must fire after a
 * config change (broadcast, sync, persist) so this service stays decoupled
 * from WebSocket and DLL internals.
 */
export class PluginConfigService {
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly configsDir: string,
    private readonly pluginManager: PluginManager,
    private readonly getActivePluginConfigId: () => string,
    private readonly setActivePluginConfigId: (id: string) => void,
    private readonly onConfigChanged: () => void,
    private readonly onPluginStateChanged: () => void,
    private readonly onSyncHotkeys: () => void,
  ) {}

  private ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  sanitizeConfigId(name: string): string {
    const cleaned = name
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();
    return cleaned || `config-${Date.now()}`;
  }

  buildPluginConfigSnapshot(name: string): {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    plugins: Array<{ id: string; enabled: boolean; hotkey: string; settings: Record<string, unknown> }>;
  } {
    const now = Date.now();
    const plugins = this.pluginManager.getPlugins().map((p) => {
      const settings: Record<string, unknown> = {};
      // Persist only value settings; skip action buttons (load should never "click" UI buttons).
      for (const s of p.settings || []) {
        if (s.type === 'button') continue;
        settings[s.key] = s.value;
      }
      return { id: p.id, enabled: !!p.enabled, hotkey: String((p as any).hotkey || ''), settings };
    });
    return {
      id: this.sanitizeConfigId(name),
      name: name.trim() || 'Unnamed Config',
      createdAt: now,
      updatedAt: now,
      plugins,
    };
  }

  // ── Autosave: persist current plugin state on every change ─────────────
  // Settings used to reset on restart because nothing wrote the live state
  // (only the manual "Save config" did). We now debounce-write the whole
  // current state to a reserved "Autosave" config and point
  // lastPluginConfigId at it, so tryAutoLoadLastPluginConfig() restores it
  // on next launch — no manual save needed.

  writeAutosaveSnapshot(): void {
    if (this.getActivePluginConfigId() !== DEFAULT_PLUGIN_CONFIG_ID) return;
    try {
      const snapshot = this.buildPluginConfigSnapshot(DEFAULT_PLUGIN_CONFIG_NAME);
      this.ensureDir(this.configsDir);
      const filePath = join(this.configsDir, snapshot.id + '.json');
      if (existsSync(filePath)) {
        try {
          const oldCfg = JSON.parse(readFileSync(filePath, 'utf8')) as { createdAt?: number };
          if (Number(oldCfg.createdAt) > 0) snapshot.createdAt = Number(oldCfg.createdAt);
        } catch {}
        snapshot.updatedAt = Date.now();
      }
      writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
      this.setActivePluginConfigId(snapshot.id);
      this.onConfigChanged();
    } catch (err) {
      Logger.warn('PluginConfigService', `autosave failed: ${(err as Error).message}`);
    }
  }

  scheduleAutosave(): void {
    if (this.getActivePluginConfigId() !== DEFAULT_PLUGIN_CONFIG_ID) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.writeAutosaveSnapshot();
    }, 800);
  }

  applyPluginConfigSnapshot(snapshot: any): { ok: boolean; message: string } {
    if (!snapshot || !Array.isArray(snapshot.plugins)) {
      return { ok: false, message: 'Invalid config format: plugins[] is required.' };
    }
    const livePlugins = this.pluginManager.getPlugins();
    for (const p of snapshot.plugins as Array<any>) {
      if (!p || typeof p.id !== 'string') continue;
      const live = livePlugins.find((lp) => lp.id === p.id);
      const liveSettingByKey = new Map<string, { type?: string }>();
      for (const s of live?.settings || []) {
        liveSettingByKey.set(String(s.key), { type: String((s as any).type || '') });
      }
      if (typeof p.enabled === 'boolean') {
        this.pluginManager.togglePlugin(p.id, p.enabled);
      }
      if (typeof p.hotkey === 'string') {
        const result = this.pluginManager.updatePluginHotkey(p.id, p.hotkey);
        if (!result.ok) {
          Logger.warn('PluginConfigService', `Skipped hotkey for ${p.id}: ${result.reason || 'invalid hotkey'}`);
        }
      }
      if (p.settings && typeof p.settings === 'object') {
        for (const [key, value] of Object.entries(p.settings as Record<string, unknown>)) {
          // Never execute button settings from a config replay.
          const st = liveSettingByKey.get(String(key));
          if (st?.type === 'button') continue;
          this.pluginManager.updateSetting(p.id, key, value);
        }
      }
    }
    this.onPluginStateChanged();
    this.onSyncHotkeys();
    return { ok: true, message: `Loaded config "${String(snapshot.name || snapshot.id || 'config')}".` };
  }

  tryAutoLoadDefaultPluginConfig(): void {
    try {
      const safeId = DEFAULT_PLUGIN_CONFIG_ID;
      const filePath = join(this.configsDir, safeId + '.json');
      if (!existsSync(filePath)) {
        this.ensureDir(this.configsDir);
        const snapshot = this.buildPluginConfigSnapshot(DEFAULT_PLUGIN_CONFIG_NAME);
        writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        this.setActivePluginConfigId(snapshot.id);
        this.onConfigChanged();
        Logger.log('PluginConfigService', 'Initialized default plugin config');
        return;
      }
      const raw = readFileSync(filePath, 'utf8');
      const snapshot = JSON.parse(raw);
      const result = this.applyPluginConfigSnapshot(snapshot);
      if (!result.ok) {
        Logger.warn('PluginConfigService', `Auto-load config failed: ${result.message}`);
        return;
      }
      this.setActivePluginConfigId(safeId);
      this.onConfigChanged();
      Logger.log('PluginConfigService', `Auto-loaded plugin config: ${safeId}`);
    } catch (err) {
      Logger.warn('PluginConfigService', `Auto-load config error: ${(err as Error).message}`);
    }
  }
}
