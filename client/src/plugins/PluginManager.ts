import { readdirSync, existsSync } from 'fs';
import { join, basename, resolve, relative } from 'path';
import { pathToFileURL } from 'url';
import { PluginContext, type PluginCategory } from './PluginContext.js';
import { UserPluginContext, type UserPluginCleanup } from './UserPluginContext.js';
import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from '../state/GameWorldState.js';
import type { ProjectileTracker } from '../state/ProjectileTracker.js';
import { Logger } from '../util/Logger.js';
import { sendDllFeature } from '../bridge/DllFeatureBus.js';

/**
 * Where a loaded plugin's code came from.
 * - `bundled`: shipped in the app (TS/JS files in `plugins/`).
 * - `user`: a `.mjs` the user dropped into `Documents/Realmengine/Plugins/` themselves.
 */
type PluginSource = 'bundled' | 'user';

/**
 * Either context type exposes the same management surface used by
 * `PluginManager` (enabled flag, name, category, settings, cleanup, dashboard
 * hooks). Their register-time APIs differ — bundled plugins get packet-level
 * access via {@link PluginContext}; user `.mjs` plugins get the restricted
 * {@link UserPluginContext} and reach the game through `@realmengine/sdk`.
 */
type AnyPluginContext = PluginContext | UserPluginContext;

interface LoadedPlugin {
  id: string;
  name: string;
  filePath: string;
  source: PluginSource;
  hotkey: string;
  context: AnyPluginContext;
  /**
   * Optional teardown returned from a user plugin's `register(ctx)` call.
   * Bundled plugins handle teardown via their own `ctx.registerCleanup`, so
   * this stays `null` for them.
   */
  userCleanup: UserPluginCleanup | null;
}

const BUNDLED_PLUGIN_EXTS = ['.ts', '.js'] as const;
const USER_PLUGIN_EXTS = ['.mjs'] as const;

function stripPluginExt(fileName: string): string {
  return fileName.replace(/\.(?:mjs|js|ts)$/i, '');
}

const HOTKEY_ALIASES = new Map<string, string>([
  ['ESC', 'Escape'],
  ['ESCAPE', 'Escape'],
  ['INS', 'Insert'],
  ['INSERT', 'Insert'],
  ['DEL', 'Delete'],
  ['DELETE', 'Delete'],
  ['HOME', 'Home'],
  ['END', 'End'],
  ['PGUP', 'PageUp'],
  ['PAGEUP', 'PageUp'],
  ['PGDN', 'PageDown'],
  ['PAGEDOWN', 'PageDown'],
  ['UP', 'Up'],
  ['ARROWUP', 'Up'],
  ['DOWN', 'Down'],
  ['ARROWDOWN', 'Down'],
  ['LEFT', 'Left'],
  ['ARROWLEFT', 'Left'],
  ['RIGHT', 'Right'],
  ['ARROWRIGHT', 'Right'],
  ['SPACE', 'Space'],
  ['SPACEBAR', 'Space'],
  ['TAB', 'Tab'],
  ['BACKSPACE', 'Backspace'],
  ['ENTER', 'Enter'],
  ['RETURN', 'Enter'],
]);

const HOTKEY_MODIFIER_ALIASES = new Map<string, string>([
  ['CTRL', 'Ctrl'],
  ['CONTROL', 'Ctrl'],
  ['ALT', 'Alt'],
  ['MENU', 'Alt'],
  ['SHIFT', 'Shift'],
]);

function normalizeHotkeyKey(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (!compact) return null;
  if (/^[A-Z0-9]$/.test(compact)) return compact;
  const fKey = compact.match(/^F([1-9]|1[0-2])$/);
  if (fKey) return `F${fKey[1]}`;
  const numpad = compact.match(/^(?:NUMPAD|NUM)([0-9])$/);
  if (numpad) return `Numpad${numpad[1]}`;
  const alias = HOTKEY_ALIASES.get(compact);
  if (alias) return alias;
  return null;
}

function normalizeHotkey(raw: unknown): string | null {
  const input = String(raw ?? '').trim();
  if (!input) return '';
  const parts = input.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';

  const modifiers = new Set<string>();
  let mainKey = '';

  for (const part of parts) {
    const compact = part.replace(/\s+/g, '').toUpperCase();
    const modifier = HOTKEY_MODIFIER_ALIASES.get(compact);
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (mainKey) return null;
    const normalized = normalizeHotkeyKey(part);
    if (!normalized) return null;
    mainKey = normalized;
  }

  if (!mainKey) return null;

  const orderedModifiers = ['Ctrl', 'Alt', 'Shift'].filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, mainKey].join('+');
}

/**
 * Loads single-file .ts plugins from the /plugins/ directory.
 * Each plugin exports a `register(ctx: PluginContext)` function.
 */
export class PluginManager {
  /** Hidden dashboard service plugins that must keep running even when plugin profiles/logins change. */
  private static readonly alwaysEnabledPluginIds = new Set<string>([
    'damage-sniffer',
  ]);

  private loadedPlugins = new Map<string, LoadedPlugin>();
  private bundledWatcher: any = null;
  private userWatcher: any = null;
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private gameData?: GameDataLoader;
  private worldState?: GameWorldState;
  private projectileTracker?: ProjectileTracker;
  private sessionStateResolver?: (client: ClientConnection) => {
    worldState: GameWorldState | null;
    projectileTracker: ProjectileTracker | null;
  };
  private dashboardLogListeners = new Set<(pluginName: string, message: string) => void>();
  private broadcastDataListeners = new Set<(pluginId: string, type: string, data: any) => void>();

  constructor(
    private proxy: Proxy,
    /** Bundled first-party plugins shipped with the client (compiled `.ts`/`.js`). */
    private bundledPluginDir: string,
    /** User plugins directory (`Documents/Realmengine/Plugins`, loose `.mjs` files). */
    private userPluginDir: string,
    private allowLocalDiskPlugins = true,
    gameData?: GameDataLoader,
    worldState?: GameWorldState,
    projectileTracker?: ProjectileTracker,
    sessionStateResolver?: (client: ClientConnection) => {
      worldState: GameWorldState | null;
      projectileTracker: ProjectileTracker | null;
    },
  ) {
    this.gameData = gameData;
    this.worldState = worldState;
    this.projectileTracker = projectileTracker;
    this.sessionStateResolver = sessionStateResolver;
  }

  /** Get all loaded plugins (for dashboard). */
  getPlugins(): { id: string; name: string; enabled: boolean; category: PluginCategory; settings: any[]; source: PluginSource; requiredPlan: string | null; hotkey: string; hotkeyLocked: boolean }[] {
    return Array.from(this.loadedPlugins.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.context.enabled,
        category: p.context.category,
        settings: this.getDashboardSettings(p),
        source: p.source,
        requiredPlan: null,
        hotkey: p.hotkey,
        hotkeyLocked: this.isAlwaysEnabled(p.id),
      }));
  }

  private getDashboardSettings(plugin: LoadedPlugin): any[] {
    return plugin.context.getSettings().map((setting) => {
      const s = { ...setting };
      if (plugin.id === 'speed-hack' && s.key === 'speedMult') {
        s.min = 1;
        s.step = 0.1;
        s.type = 'number';
        delete s.max;
      }
      return s;
    });
  }

  private isAlwaysEnabled(pluginId: string): boolean {
    return PluginManager.alwaysEnabledPluginIds.has(pluginId);
  }

  /**
   * Toggle a plugin on/off.
   *
   * Bundled plugins still require login, and some additionally require gems or admin.
   * User plugins (loose `.mjs` in `Documents/Realmengine/Plugins`) are unverified and
   * explicitly lax — they ignore all gates.
   */
  togglePlugin(pluginId: string, enabled: boolean): { ok: boolean; reason?: string; requiredPlan?: string } {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return { ok: false, reason: 'Plugin not found' };
    if (this.isAlwaysEnabled(pluginId)) {
      plugin.context.enabled = true;
      return { ok: true };
    }
    plugin.context.enabled = enabled;
    sendDllFeature('showPluginFloatingText', `${plugin.name}: ${enabled ? 'Enabled' : 'Disabled'}`);
    return { ok: true };
  }

  togglePluginByHotkey(pluginId: string): { ok: boolean; enabled?: boolean; reason?: string; requiredPlan?: string } {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return { ok: false, reason: 'Plugin not found' };
    if (!plugin.hotkey) return { ok: false, reason: 'Plugin has no hotkey' };
    if (this.isAlwaysEnabled(pluginId)) return { ok: false, reason: 'Plugin is always enabled' };
    const nextEnabled = !plugin.context.enabled;
    const result = this.togglePlugin(pluginId, nextEnabled);
    return result.ok ? { ...result, enabled: nextEnabled } : result;
  }

  updatePluginHotkey(pluginId: string, rawHotkey: unknown): { ok: boolean; hotkey?: string; reason?: string; conflictPluginId?: string } {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return { ok: false, reason: 'Plugin not found' };
    if (this.isAlwaysEnabled(pluginId)) return { ok: false, reason: 'Plugin is always enabled' };

    const hotkey = normalizeHotkey(rawHotkey);
    if (hotkey === null) return { ok: false, reason: 'Unsupported hotkey' };

    if (hotkey) {
      const hotkeyLower = hotkey.toLowerCase();
      for (const other of this.loadedPlugins.values()) {
        if (other.id === pluginId) continue;
        if (other.hotkey && other.hotkey.toLowerCase() === hotkeyLower) {
          return {
            ok: false,
            reason: `Hotkey already assigned to ${other.name || other.id}`,
            conflictPluginId: other.id,
          };
        }
      }
    }

    plugin.hotkey = hotkey;
    Logger.debug('plugin-config', 'PluginManager', `Hotkey for ${plugin.name || plugin.id}: ${hotkey || '(none)'}`);
    return { ok: true, hotkey };
  }

  getPluginHotkeyBindings(): Array<{ pluginId: string; hotkey: string }> {
    return Array.from(this.loadedPlugins.values())
      .filter((p) => !!p.hotkey && !this.isAlwaysEnabled(p.id))
      .map((p) => ({ pluginId: p.id, hotkey: p.hotkey }));
  }

  /**
   * Disable bundled plugins (called on logout). User plugins are not tied to an account
   * and stay in whatever state the user left them.
   */
  disableAllPlugins(): void {
    for (const plugin of this.loadedPlugins.values()) {
      if (plugin.source !== 'bundled') continue;
      if (this.isAlwaysEnabled(plugin.id)) {
        plugin.context.enabled = true;
        continue;
      }
      plugin.context.enabled = false;
    }
  }

  /** Subscribe to dashboard-only log messages from plugins. */
  onDashboardLog(listener: (pluginName: string, message: string) => void): () => void {
    this.dashboardLogListeners.add(listener);
    return () => this.dashboardLogListeners.delete(listener);
  }

  /**
   * Get runtime data stored by a plugin.
   *
   * Only bundled plugins can stash runtime data via `ctx.setData` — user
   * `.mjs` plugins don't get `setData`/`getData` on their restricted context.
   * Requests for user plugins here always return `undefined`.
   */
  getPluginData<T = any>(pluginId: string, key: string): T | undefined {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return undefined;
    if (plugin.context instanceof PluginContext) {
      return plugin.context.getData<T>(key);
    }
    return undefined;
  }

  /** Subscribe to structured broadcast data from plugins. */
  onBroadcastData(listener: (pluginId: string, type: string, data: any) => void): () => void {
    this.broadcastDataListeners.add(listener);
    return () => this.broadcastDataListeners.delete(listener);
  }

  /** Update a plugin setting. */
  updateSetting(pluginId: string, key: string, value: any): boolean {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return false;
    if (pluginId === 'speed-hack' && key === 'speedMult') {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return false;
      value = Math.max(1, numericValue);
    }
    return plugin.context.updateSetting(key, value);
  }

  /**
   * Reset a plugin's settings to the values they were registered with.
   * Each changed setting fires its onChange callback so the DLL/dashboard
   * resync — no extra plumbing required. Returns the list of keys reset
   * (empty if nothing changed or plugin unknown).
   */
  resetPluginSettings(pluginId: string): string[] {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return [];
    return plugin.context.resetSettingsToDefaults();
  }

  /**
   * Load plugins from both the bundled directory (first-party `.ts`/`.js`) and the
   * user directory (`Documents/Realmengine/Plugins/*.mjs`).
   *
   * The two sources are sorted differently on purpose: bundled files are compiled
   * TypeScript that ships with the client, user files are loose ESM modules the
   * user dropped in themselves. Both still expose `register(ctx)` and run through
   * the same `PluginContext` — only the discovery filter and the resulting
   * `source` tag differ.
   */
  async loadAll(): Promise<void> {
    if (!this.allowLocalDiskPlugins) {
      Logger.warn('PluginManager', 'Local disk plugins are disabled in this build mode.');
      return;
    }
    await this.loadFromDir(this.bundledPluginDir, 'bundled');
    await this.loadFromDir(this.userPluginDir, 'user');
    Logger.log('PluginManager', `Loaded ${this.loadedPlugins.size} plugins`);
  }

  private async loadFromDir(dir: string, source: PluginSource): Promise<void> {
    if (!existsSync(dir)) {
      if (source === 'user') {
        Logger.log('PluginManager', `No user plugins directory yet: ${dir}`);
      } else {
        Logger.warn('PluginManager', `Bundled plugin directory not found: ${dir}`);
      }
      return;
    }
    const exts = source === 'bundled' ? BUNDLED_PLUGIN_EXTS : USER_PLUGIN_EXTS;
    const entries = this.discoverPluginEntries(dir, exts)
      .sort((a, b) => {
        // Auto Nexus must register before other plugins so its hooks can use prepend and still be first in line.
        const isNx = (id: string) => id.toLowerCase() === 'auto-nexus';
        const na = isNx(a.id);
        const nb = isNx(b.id);
        if (na && !nb) return -1;
        if (!na && nb) return 1;
        return a.id.localeCompare(b.id);
      });
    for (const { id, entryPath } of entries) {
      await this.loadPlugin(entryPath, source, id);
    }
  }

  /** Entry filename (sans extension) for a directory plugin: `<dir>/index.<ext>`. */
  private static readonly DIR_PLUGIN_ENTRY = 'index';

  /** Locate a directory plugin's entry file (`index.ts`/`.js`/`.mjs`), or null. */
  private findDirPluginEntry(dirPath: string, exts: readonly string[]): string | null {
    for (const e of exts) {
      const candidate = join(dirPath, `${PluginManager.DIR_PLUGIN_ENTRY}${e}`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Discover plugin entries in `dir`:
   *  - top-level files → id = filename without extension;
   *  - subfolders containing an `index` entry → id = folder name (a "directory
   *    plugin", e.g. `auto-drink/index.ts`, `auto-loot/index.ts`). Subfolders
   *    without an `index` entry are ignored (they're just import targets).
   * Top-level files win when an id collides with a directory plugin.
   */
  private discoverPluginEntries(dir: string, exts: readonly string[]): { id: string; entryPath: string }[] {
    const byId = new Map<string, string>();
    const dirCandidates: { id: string; entryPath: string }[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile()) {
        if (exts.some((e) => ent.name.toLowerCase().endsWith(e))) {
          byId.set(stripPluginExt(ent.name), join(dir, ent.name));
        }
      } else if (ent.isDirectory()) {
        const entryPath = this.findDirPluginEntry(join(dir, ent.name), exts);
        if (entryPath) dirCandidates.push({ id: ent.name, entryPath });
      }
    }
    for (const c of dirCandidates) {
      if (!byId.has(c.id)) byId.set(c.id, c.entryPath);
    }
    return [...byId].map(([id, entryPath]) => ({ id, entryPath }));
  }

  /** Map a watched file under `dir` to the plugin it belongs to (top-level file or directory plugin). */
  private resolveWatchedPlugin(dir: string, changedPath: string, exts: readonly string[]): { id: string; entryPath: string } | null {
    const rel = relative(dir, changedPath);
    if (!rel || rel.startsWith('..')) return null;
    const segments = rel.split(/[\\/]/);
    if (segments.length === 1) {
      if (!exts.some((e) => segments[0].toLowerCase().endsWith(e))) return null;
      return { id: stripPluginExt(segments[0]), entryPath: join(dir, segments[0]) };
    }
    // A file inside a subfolder → reload the directory plugin (id = folder name).
    const id = segments[0];
    const entryPath = this.findDirPluginEntry(join(dir, id), exts);
    return entryPath ? { id, entryPath } : null;
  }

  /**
   * Load a single plugin. `source` defaults to `'bundled'` for back-compat.
   * `idOverride` is the plugin id when it can't be derived from the filename —
   * e.g. directory plugins use the folder name, not `index`.
   */
  async loadPlugin(
    filePath: string,
    source: PluginSource = 'bundled',
    idOverride?: string,
    hotReload = false,
  ): Promise<void> {
    const id = idOverride ?? stripPluginExt(basename(filePath));

    try {
      // Unload if already loaded (for hot-reload)
      if (this.loadedPlugins.has(id)) {
        await this.unloadPlugin(id);
      }

      // A query string only invalidates the entry module; Node keeps every
      // transitive import cached. Directory plugins therefore used to reload
      // index.ts while silently retaining stale engine/constants/etc modules.
      // For a watched bundled-plugin change, bundle the complete reachable
      // graph into one fresh data URL so every local helper is the new version.
      const absPath = resolve(filePath);
      let module: any;
      if (hotReload && source === 'bundled') {
        const esbuild = await import('esbuild');
        const result = await esbuild.build({
          entryPoints: [absPath],
          bundle: true,
          write: false,
          platform: 'node',
          target: 'node20',
          format: 'esm',
          treeShaking: true,
          external: ['koffi', 'sharp', 'electron'],
          logLevel: 'silent',
        });
        const code = result.outputFiles[0]?.text;
        if (!code) throw new Error(`Hot-reload bundle for ${id} produced no output`);
        const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
        module = await import(dataUrl);
      } else {
        const fileUrl = pathToFileURL(absPath).href + `?t=${Date.now()}`;
        module = await import(fileUrl);
      }

      if (typeof module.register !== 'function') {
        Logger.warn('PluginManager', `Plugin ${id} has no register() export, skipping`);
        return;
      }

      const context: AnyPluginContext = source === 'user'
        ? new UserPluginContext(this.proxy, id, filePath)
        : new PluginContext(
          this.proxy,
          id,
          filePath,
          this.gameData,
          this.worldState,
          this.projectileTracker,
          this.sessionStateResolver,
        );

      // Dashboard log + broadcastData listeners are admin-only plumbing —
      // they're only exposed on the full bundled context.
      if (context instanceof PluginContext) {
        context.onDashboardLog = (pluginName, message) => {
          for (const listener of this.dashboardLogListeners) {
            try { listener(pluginName, message); } catch {}
          }
        };
        context.onBroadcastData = (pluginId, type, data) => {
          for (const listener of this.broadcastDataListeners) {
            try { listener(pluginId, type, data); } catch {}
          }
        };
      }

      const registerResult = module.register(context);
      const userCleanup: UserPluginCleanup | null =
        context instanceof UserPluginContext && typeof registerResult === 'function'
          ? (registerResult as UserPluginCleanup)
          : null;

      this.loadedPlugins.set(id, {
        id,
        name: context.name || id,
        filePath,
        source,
        hotkey: '',
        context,
        userCleanup,
      });

      Logger.debug('plugin-load', 'PluginManager', `Loaded ${source} plugin: ${context.name || id}`);
    } catch (err) {
      Logger.error('PluginManager', `Failed to load plugin ${id}`, err as Error);
    }
  }

  /** Unload a plugin and remove its hooks. */
  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return;

    // Bundled plugins use the `ctx.registerCleanup` collector;
    // user plugins return a single cleanup function from `register(ctx)`.
    if (plugin.context instanceof PluginContext) {
      plugin.context.runCleanup();
    } else if (plugin.userCleanup) {
      try {
        plugin.userCleanup();
      } catch (err) {
        Logger.error('PluginManager', `Cleanup for user plugin ${plugin.name} threw`, err as Error);
      }
    }

    this.proxy.unhookPlugin(pluginId);
    this.loadedPlugins.delete(pluginId);
    Logger.log('PluginManager', `Unloaded plugin: ${plugin.name}`);
  }

  /** Start watching plugin directories for changes (hot-reload). */
  async startWatching(): Promise<void> {
    if (!this.allowLocalDiskPlugins) return;
    try {
      const chokidar = await import('chokidar');
      this.bundledWatcher = this.watchDir(chokidar, this.bundledPluginDir, 'bundled');
      this.userWatcher = this.watchDir(chokidar, this.userPluginDir, 'user');
      Logger.log('PluginManager', 'Watching plugin directories for changes');
    } catch {
      Logger.warn('PluginManager', 'Hot-reload unavailable (chokidar not found)');
    }
  }

  private watchDir(chokidar: any, dir: string, source: PluginSource): any {
    if (!existsSync(dir)) return null;
    const exts = source === 'bundled' ? BUNDLED_PLUGIN_EXTS : USER_PLUGIN_EXTS;

    // Watches recursively, so changes to a directory plugin's modules
    // (e.g. auto-drink/catalog.ts) resolve to and reload the parent plugin.
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    const scheduleReload = (target: { id: string; entryPath: string }, reason: string) => {
      const key = `${source}:${target.id}`;
      const previous = this.reloadTimers.get(key);
      if (previous) clearTimeout(previous);
      this.reloadTimers.set(key, setTimeout(async () => {
        this.reloadTimers.delete(key);
        Logger.log('PluginManager', `${reason}: ${target.id}, reloading...`);
        await this.loadPlugin(target.entryPath, source, target.id, true);
      }, 75));
    };

    watcher.on('change', (filePath: string) => {
      const target = this.resolveWatchedPlugin(dir, filePath, exts);
      if (!target) return;
      scheduleReload(target, 'Plugin changed');
    });

    watcher.on('add', (filePath: string) => {
      const target = this.resolveWatchedPlugin(dir, filePath, exts);
      if (!target) return;
      scheduleReload(target, 'New plugin');
    });

    watcher.on('unlink', async (filePath: string) => {
      const rel = relative(dir, filePath);
      if (!rel || rel.startsWith('..')) return;
      const segments = rel.split(/[\\/]/);
      if (segments.length === 1) {
        if (!exts.some((e) => segments[0].toLowerCase().endsWith(e))) return;
        await this.unloadPlugin(stripPluginExt(segments[0]));
        return;
      }
      // A module file inside a directory plugin was removed: reload the plugin
      // if its entry survives, otherwise unload it entirely.
      const id = segments[0];
      const entryPath = this.findDirPluginEntry(join(dir, id), exts);
      if (entryPath) await this.loadPlugin(entryPath, source, id, true);
      else await this.unloadPlugin(id);
    });

    return watcher;
  }

  stopWatching(): void {
    for (const timer of this.reloadTimers.values()) clearTimeout(timer);
    this.reloadTimers.clear();
    this.bundledWatcher?.close();
    this.bundledWatcher = null;
    this.userWatcher?.close();
    this.userWatcher = null;
  }
}
