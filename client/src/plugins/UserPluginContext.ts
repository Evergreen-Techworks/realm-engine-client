import type { Proxy } from '../proxy/Proxy.js';
import { Logger } from '../util/Logger.js';
import type { PluginCategory, SettingDef } from './PluginContext.js';
// The community-facing shape is authored ONCE in the SDK; this runtime class is
// checked against it via `implements` so the two can no longer drift silently.
import type { UserPluginContext as UserPluginContextContract } from '@realmengine/sdk';

/**
 * Cleanup callback an optional community plugin may return from its
 * `register(ctx)` function. Called by the plugin manager on unload or
 * hot-reload so the plugin can tear down its SDK subscriptions, timers, etc.
 *
 *   export function register(ctx) {
 *     const unsub = events.onEnemySpawned(handler);
 *     return () => unsub();
 *   }
 */
export type UserPluginCleanup = () => void;

/**
 * Restricted plugin context handed to **community `.mjs` plugins** that live in
 * `Documents/Realmengine/Plugins/`.
 *
 * Community plugins are almost entirely SDK-driven: anything about the game
 * world — chat, events, enemies, players, self, inventory, world — comes from
 * `@realmengine/sdk`. `ctx` only covers plugin *runtime* concerns that the SDK
 * has no way to scope to an individual plugin on its own:
 *
 *   - identity (`name`, `category`, read-only `pluginId` / `pluginFile`)
 *   - the `enabled` state driven by the dashboard toggle
 *   - per-plugin dashboard settings (`registerSetting` / `getSetting`)
 *   - per-plugin chat commands (`registerCommand`)
 *
 * Teardown is done by returning a cleanup function from `register(ctx)`; the
 * plugin manager calls it on disable, hot-reload or unload.
 *
 * Anything admin-/first-party-oriented (log-panel routing, WebSocket
 * broadcasts, packet access, proxy events) is deliberately absent from this
 * surface and stays on the bundled {@link PluginContext}.
 */
export class UserPluginContext implements UserPluginContextContract {
  private _enabled = true;
  private _name: string;
  private _category: PluginCategory | undefined;
  private _settings = new Map<string, SettingDef>();
  private _settingCallbacks = new Map<string, (value: any) => void>();
  /** Registration-time defaults — never mutated by updateSetting. Powers
   *  the dashboard "Reset to defaults" button. */
  private _settingDefaults = new Map<string, any>();

  constructor(
    private proxy: Proxy,
    public readonly pluginId: string,
    public readonly pluginFile: string,
  ) {
    this._name = pluginId;
  }

  // ── Identity ─────────────────────────────────────────

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(val: boolean) {
    this._enabled = val;
    Logger.debug('plugin-config', 'Plugin', `${this._name} ${val ? 'enabled' : 'disabled'}`);
  }

  get name(): string {
    return this._name;
  }

  set name(val: string) {
    this._name = val;
  }

  /** Dashboard Plugins hub category; defaults to `utility` when unset. */
  get category(): PluginCategory {
    return this._category ?? 'utility';
  }

  set category(val: PluginCategory) {
    this._category = val;
  }

  // ── Settings ─────────────────────────────────────────

  /** Register a configurable setting (shown in dashboard). */
  registerSetting(
    key: string,
    config: Omit<SettingDef, 'key'>,
    onChange?: (value: any) => void,
  ): void {
    this._settings.set(key, { key, ...config });
    if (onChange) this._settingCallbacks.set(key, onChange);
    if (config.type !== 'button') {
      this._settingDefaults.set(key, config.value);
    }
  }

  /** Read the current value of a setting. */
  getSetting<T = any>(key: string): T {
    return this._settings.get(key)?.value;
  }

  /** Update a setting value (called by the dashboard). */
  updateSetting(key: string, value: any): boolean {
    const setting = this._settings.get(key);
    if (!setting) return false;

    if (setting.type === 'number' || setting.type === 'range') {
      value = Number(value);
      if (isNaN(value)) return false;
      if (setting.min !== undefined) value = Math.max(setting.min, value);
      if (setting.max !== undefined) value = Math.min(setting.max, value);
    } else if (setting.type === 'boolean') {
      value = !!value;
    } else if (setting.type === 'button') {
      const cb = this._settingCallbacks.get(key);
      if (cb) cb(true);
      return true;
    } else if (setting.type === 'select' || setting.type === 'text') {
      value = String(value ?? '');
    }

    setting.value = value;
    Logger.debug('plugin-config', 'Plugin', `${this._name}: ${setting.label} = ${value}`);

    const cb = this._settingCallbacks.get(key);
    if (cb) cb(value);
    return true;
  }

  /** All registered settings (for dashboard rendering). */
  getSettings(): SettingDef[] {
    return [...this._settings.values()];
  }

  /** Reset every setting to its registration-time value (drives onChange so
   *  consumers stay in sync). Buttons skipped. Returns the keys actually
   *  reset. Mirrors the same method on PluginContext. */
  resetSettingsToDefaults(): string[] {
    const changed: string[] = [];
    for (const [key, def] of this._settingDefaults) {
      const setting = this._settings.get(key);
      if (!setting || setting.type === 'button') continue;
      if (setting.value === def) continue;
      if (this.updateSetting(key, def)) changed.push(key);
    }
    return changed;
  }

  // ── Chat commands ────────────────────────────────────

  /**
   * Register a chat command (e.g. `'greet'` → `/greet`).
   *
   * The handler receives the parsed argument list. To reply, call
   * `chat.notify(...)` or `chat.say(...)` from `@realmengine/sdk`.
   *
   * Handlers are automatically gated by `ctx.enabled` — when the dashboard
   * toggle is off, `/command` is silently ignored.
   */
  registerCommand(command: string, handler: (args: string[]) => void): void {
    this.proxy.hookCommand(
      command,
      (_client, _cmd, args) => {
        if (!this._enabled) return false;
        try {
          handler(args);
        } catch (err) {
          Logger.error('Plugin', `${this._name}: /${command} threw`, err as Error);
        }
        return true;
      },
      this.pluginId,
    );
  }
}
