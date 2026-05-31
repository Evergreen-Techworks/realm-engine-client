import { readdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { pathToFileURL } from 'url';
import { PluginContext, type PluginCategory } from './PluginContext.js';
import { UserPluginContext, type UserPluginCleanup } from './UserPluginContext.js';
import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from '../state/GameWorldState.js';
import type { ProjectileTracker } from '../state/ProjectileTracker.js';
import { Logger } from '../util/Logger.js';

/**
 * Where a loaded plugin's code came from.
 * - `bundled`: shipped in the app (TS/JS files in `plugins/`).
 * - `user`: a `.mjs` the user dropped into `Documents/Realmengine/Plugins/` themselves.
 * User plugins are local files and run through the restricted SDK context.
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

  /** Get all loaded plugins for the dashboard. */
  getPlugins(): { id: string; name: string; enabled: boolean; category: PluginCategory; settings: any[]; source: PluginSource }[] {
    return Array.from(this.loadedPlugins.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.context.enabled,
        category: p.context.category,
        settings: this.getDashboardSettings(p),
        source: p.source,
      }));
  }

  private getDashboardSettings(plugin: LoadedPlugin): any[] {
    return plugin.context.getSettings().map((setting) => ({ ...setting }));
  }

  private isAlwaysEnabled(pluginId: string): boolean {
    return PluginManager.alwaysEnabledPluginIds.has(pluginId);
  }

  /**
   * Toggle a plugin on/off.
   */
  togglePlugin(pluginId: string, enabled: boolean): { ok: boolean; reason?: string } {
    const plugin = this.loadedPlugins.get(pluginId);
    if (!plugin) return { ok: false, reason: 'Plugin not found' };

    if (this.isAlwaysEnabled(pluginId)) {
      plugin.context.enabled = true;
      return { ok: true };
    }

    plugin.context.enabled = enabled;
    return { ok: true };
  }

  disableAllPlugins(): void {
    for (const plugin of this.loadedPlugins.values()) {
      if (this.isAlwaysEnabled(plugin.id)) plugin.context.enabled = true;
    }
  }

  disableAdminGatedPlugins(): void {
    // No-op.
  }

  enforceNonAdminSettingCaps(): void {
    // No-op.
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
    const files = readdirSync(dir)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .sort((a, b) => {
        // Auto Nexus must register before other plugins so its hooks can use prepend and still be first in line.
        const isNx = (n: string) => stripPluginExt(n).toLowerCase() === 'auto-nexus';
        const na = isNx(a);
        const nb = isNx(b);
        if (na && !nb) return -1;
        if (!na && nb) return 1;
        return a.localeCompare(b);
      });
    for (const file of files) {
      await this.loadPlugin(join(dir, file), source);
    }
  }

  /** Load a single plugin file. `source` defaults to `'bundled'` for back-compat. */
  async loadPlugin(filePath: string, source: PluginSource = 'bundled'): Promise<void> {
    const id = stripPluginExt(basename(filePath));

    try {
      // Unload if already loaded (for hot-reload)
      if (this.loadedPlugins.has(id)) {
        await this.unloadPlugin(id);
      }

      // Dynamic import with cache busting for hot-reload
      const absPath = resolve(filePath);
      const fileUrl = pathToFileURL(absPath).href + `?t=${Date.now()}`;
      const module = await import(fileUrl);

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
        context,
        userCleanup,
      });

      Logger.log('PluginManager', `Loaded ${source} plugin: ${context.name || id}`);
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
    const matchesExt = (p: string) => exts.some((e) => p.toLowerCase().endsWith(e));

    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    watcher.on('change', async (filePath: string) => {
      if (!matchesExt(filePath)) return;
      Logger.log('PluginManager', `Plugin changed: ${basename(filePath)}, reloading...`);
      await this.loadPlugin(filePath, source);
    });

    watcher.on('add', async (filePath: string) => {
      if (!matchesExt(filePath)) return;
      Logger.log('PluginManager', `New plugin: ${basename(filePath)}, loading...`);
      await this.loadPlugin(filePath, source);
    });

    watcher.on('unlink', async (filePath: string) => {
      if (!matchesExt(filePath)) return;
      const id = stripPluginExt(basename(filePath));
      await this.unloadPlugin(id);
    });

    return watcher;
  }

  stopWatching(): void {
    this.bundledWatcher?.close();
    this.bundledWatcher = null;
    this.userWatcher?.close();
    this.userWatcher = null;
  }
}
