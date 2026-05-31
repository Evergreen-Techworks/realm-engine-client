import { readdirSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { pathToFileURL } from 'url';
import { createDecipheriv, createHash, createPublicKey, verify } from 'crypto';
import { PluginContext, type PluginCategory } from './PluginContext.js';
import { UserPluginContext, type UserPluginCleanup } from './UserPluginContext.js';
import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from '../state/GameWorldState.js';
import type { ProjectileTracker } from '../state/ProjectileTracker.js';
import { Logger } from '../util/Logger.js';
import { sendDllFeature } from '../bridge/DllFeatureBus.js';

declare const __PLUGIN_BUNDLE_SIGNING_PUBLIC_KEY__: string | undefined;
declare const __PLUGIN_BUNDLE_ENC_KEY__: string | undefined;

const IS_PROD = process.env.REALM_ENGINE_PROD === '1';

function getSigningPublicKeyPem(): string {
  try {
    return String(typeof __PLUGIN_BUNDLE_SIGNING_PUBLIC_KEY__ !== 'undefined' ? __PLUGIN_BUNDLE_SIGNING_PUBLIC_KEY__ : '').trim();
  } catch {
    return '';
  }
}

function getBundleEncKeyHex(): string {
  try {
    return String(typeof __PLUGIN_BUNDLE_ENC_KEY__ !== 'undefined' ? __PLUGIN_BUNDLE_ENC_KEY__ : '').trim();
  } catch {
    return '';
  }
}

function isHexKey32(v: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(v);
}

/**
 * Where a loaded plugin's code came from.
 * - `bundled`: shipped in the app (TS/JS files in `plugins/`) or fetched from the signed API bundle.
 * - `user`: a `.mjs` the user dropped into `Documents/Realmengine/Plugins/` themselves.
 * User plugins are unverified and bypass the login/gem/admin gates — they are free to run.
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

interface SecurePluginRecord {
  id: string;
  alg: 'aes-256-gcm';
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
  sha256: string;
}

interface SecureBundlePayload {
  version: number;
  protocol: 'plugin-bundle-v1';
  generatedAt: string;
  plugins: SecurePluginRecord[];
}

interface SecureBundleEnvelope {
  version: number;
  sigAlg: 'ed25519';
  payloadB64: string;
  signatureB64: string;
}

/**
 * Loads single-file .ts plugins from the /plugins/ directory.
 * Each plugin exports a `register(ctx: PluginContext)` function.
 */
export class PluginManager {
  /**
   * Maps normalized plan names to the plugin IDs that require that plan.
   * 'combined' is not listed here — it is expanded to 'dodge' + 'developer' in setActivePlans().
   */
  private static readonly planGatedPlugins: Record<string, string[]> = {
    dodge: ['auto-dodge', 'safe-walk', 'godfarming'],
    developer: ['spoof-push-tiles'],
  };

  /** Hidden dashboard service plugins that must keep running even when plugin profiles/logins change. */
  private static readonly alwaysEnabledPluginIds = new Set<string>([
    'damage-sniffer',
  ]);

  /** Plugins only visible and usable when the logged-in user is an admin. */
  private static readonly adminGatedPluginIds = new Set<string>([
    'admin-autododge',
    'camera-controls',
    'auto-drink',
    'rollback',
    'auto-ability',
    'player-noclip',
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

  /** Admin dev: always true — plugins usable without sign-in. */
  loginGateActive = true;

  /**
   * Currently active plan names (normalized to lowercase).
   * 'combined' is expanded to both 'dodge' and 'developer' via setActivePlans().
   */
  activePlans = new Set<string>(['free', 'dodge', 'developer', 'pro', 'elite', 'combined']);

  /** Admin dev: always true — admin-gated plugins always visible and usable. */
  adminMode = true;

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

  /** Get all loaded plugins (for dashboard). Admin-gated plugins hidden when adminMode is off. */
  getPlugins(): { id: string; name: string; enabled: boolean; category: PluginCategory; settings: any[]; source: PluginSource; requiredPlan: string | null; hotkey: string; hotkeyLocked: boolean }[] {
    return Array.from(this.loadedPlugins.values())
      .filter(p => !this.isAdminGated(p.id) || this.adminMode)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({
        id: p.id,
        name: p.name,
        enabled: p.context.enabled,
        category: p.context.category,
        settings: this.getDashboardSettings(p),
        source: p.source,
        requiredPlan: this.getRequiredPlan(p.id),
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
        if (this.adminMode) {
          s.type = 'number';
          delete s.max;
        } else {
          s.type = 'range';
          s.max = 4;
          if (Number(s.value) > 4) s.value = 4;
        }
      }
      return s;
    });
  }

  /** Returns the plan name required to use this plugin, or null if freely available. */
  getRequiredPlan(_pluginId: string): string | null {
    // Admin dev: no plan required for any plugin.
    return null;
  }

  private isAdminGated(pluginId: string): boolean {
    return PluginManager.adminGatedPluginIds.has(pluginId);
  }

  private isAlwaysEnabled(pluginId: string): boolean {
    return PluginManager.alwaysEnabledPluginIds.has(pluginId);
  }

  /**
   * Update the set of active plans from the server subscription response.
   * Expands 'combined' → 'dodge' + 'developer'.
   * Automatically disables plugins for any plan that is no longer active.
   */
  setActivePlans(planNames: string[]): void {
    const next = new Set<string>();
    for (const name of planNames) {
      const lower = name.toLowerCase();
      next.add(lower);
      if (lower) {
        next.add('dodge');
        next.add('developer');
      }
    }
    // Disable plugins for plans that are no longer active
    // for (const [plan, ids] of Object.entries(PluginManager.planGatedPlugins)) {
    //   if (!next.has(plan)) {
    //     for (const id of ids) {
    //       if (this.isAlwaysEnabled(id)) continue;
    //       const plugin = this.loadedPlugins.get(id);
    //       if (plugin && plugin.source === 'bundled') plugin.context.enabled = false;
    //     }
    //   }
    // }
    this.activePlans = next;
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
    const gated = plugin.source === 'bundled';
    // Admin dev: all gate checks removed — every plugin can be toggled freely.
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
    Logger.log('PluginManager', `Hotkey for ${plugin.name || plugin.id}: ${hotkey || '(none)'}`);
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

  /** Disable admin-gated plugins (called when admin mode is revoked). */
  disableAdminGatedPlugins(): void {
    for (const plugin of this.loadedPlugins.values()) {
      if (plugin.source !== 'bundled') continue;
      if (this.isAdminGated(plugin.id)) {
        plugin.context.enabled = false;
      }
    }
  }

  /** Clamp settings that admin users can raise beyond normal user limits. */
  enforceNonAdminSettingCaps(): void {
    if (this.adminMode) return;
    const speedHack = this.loadedPlugins.get('speed-hack');
    if (!speedHack) return;
    const current = Number(speedHack.context.getSetting('speedMult'));
    if (Number.isFinite(current) && current > 4) {
      speedHack.context.updateSetting('speedMult', 4);
    }
  }

  /** Disable all plan-gated plugins (called when login is lost or subscription status is unknown). */
  disableGemGatedPlugins(): void {
    if (this.adminMode) return;
    for (const ids of Object.values(PluginManager.planGatedPlugins)) {
      for (const id of ids) {
        if (this.isAlwaysEnabled(id)) continue;
        const plugin = this.loadedPlugins.get(id);
        if (plugin && plugin.source === 'bundled') plugin.context.enabled = false;
      }
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
    if (plugin.source === 'bundled' && this.isAdminGated(pluginId) && !this.adminMode) {
      return false;
    }
    if (pluginId === 'speed-hack' && key === 'speedMult' && !this.adminMode) {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return false;
      value = Math.min(4, Math.max(1, numericValue));
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
        hotkey: '',
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

  private parseSecureBundle(input: unknown): SecureBundleEnvelope | null {
    if (!input || typeof input !== 'object') return null;
    const b = input as Record<string, unknown>;
    if (b.version !== 1 || b.sigAlg !== 'ed25519') return null;
    if (typeof b.payloadB64 !== 'string' || typeof b.signatureB64 !== 'string') return null;
    return {
      version: 1,
      sigAlg: 'ed25519',
      payloadB64: b.payloadB64,
      signatureB64: b.signatureB64,
    };
  }

  private verifyBundleSignature(bundle: SecureBundleEnvelope): SecureBundlePayload | null {
    const pubPem = getSigningPublicKeyPem();
    if (!pubPem) {
      Logger.warn('PluginManager', 'Missing plugin bundle signing public key.');
      return null;
    }
    let payloadRaw: Buffer;
    let signature: Buffer;
    try {
      payloadRaw = Buffer.from(bundle.payloadB64, 'base64');
      signature = Buffer.from(bundle.signatureB64, 'base64');
    } catch {
      return null;
    }

    try {
      const key = createPublicKey(pubPem);
      const ok = verify(null, Buffer.from(bundle.payloadB64, 'utf8'), key, signature);
      if (!ok) {
        Logger.warn('PluginManager', 'Plugin bundle signature verification failed.');
        return null;
      }
    } catch (err) {
      Logger.warn('PluginManager', `Plugin signature verification error: ${(err as Error).message}`);
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(payloadRaw.toString('utf8'));
    } catch {
      return null;
    }
    const p = payload as Partial<SecureBundlePayload>;
    if (p?.version !== 1 || p?.protocol !== 'plugin-bundle-v1' || !Array.isArray(p.plugins)) return null;
    return p as SecureBundlePayload;
  }

  private decryptPluginCode(record: SecurePluginRecord): string | null {
    const keyHex = getBundleEncKeyHex();
    if (!isHexKey32(keyHex)) {
      Logger.warn('PluginManager', 'Missing/invalid plugin bundle encryption key.');
      return null;
    }
    if (record.alg !== 'aes-256-gcm') return null;
    try {
      const key = Buffer.from(keyHex, 'hex');
      const iv = Buffer.from(record.ivB64, 'base64');
      const tag = Buffer.from(record.tagB64, 'base64');
      const cipherText = Buffer.from(record.ciphertextB64, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      const code = plain.toString('utf8');
      const digest = createHash('sha256').update(code).digest('hex');
      if (digest.toLowerCase() !== String(record.sha256 || '').toLowerCase()) {
        Logger.warn('PluginManager', `Plugin hash mismatch for ${record.id}`);
        return null;
      }
      return code;
    } catch (err) {
      Logger.warn('PluginManager', `Plugin decrypt failed for ${record.id}: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Remote plugin loading (in-memory only, never touches disk) ─────────

  /**
   * Load a plugin from raw JS source code (fetched from the API).
   * Uses a data: URL import so the code lives only in memory.
   */
  async loadPluginFromCode(id: string, code: string): Promise<void> {
    try {
      if (this.loadedPlugins.has(id)) {
        await this.unloadPlugin(id);
      }

      // Import via data: URL — ESM module loaded entirely from memory
      const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
      const module = await import(dataUrl);

      if (typeof module.register !== 'function') {
        Logger.warn('PluginManager', `Remote plugin ${id} has no register() export, skipping`);
        return;
      }

      const context = new PluginContext(
        this.proxy,
        id,
        `remote:${id}`,
        this.gameData,
        this.worldState,
        this.projectileTracker,
        this.sessionStateResolver,
      );
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
      module.register(context);

      this.loadedPlugins.set(id, {
        id,
        name: context.name || id,
        filePath: `remote:${id}`,
        source: 'bundled',
        hotkey: '',
        context,
        userCleanup: null,
      });

      Logger.log('PluginManager', `Loaded remote plugin: ${context.name || id}`);
    } catch (err) {
      Logger.error('PluginManager', `Failed to load remote plugin ${id}`, err as Error);
    }
  }

  /**
   * Fetch the plugin bundle from the API and load all plugins in-memory.
   * Called after the user logs in.
   */
  async loadFromApi(apiBaseUrl: string, accessToken: string): Promise<number> {
    try {
      const res = await fetch(`${apiBaseUrl}/api/plugins/bundle`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        Logger.warn('PluginManager', `Plugin bundle fetch failed: HTTP ${res.status}`);
        return 0;
      }

      const data = await res.json() as { bundle?: unknown; plugins?: Array<{ id: string; code: string }> };

      // Secure bundle path (required in production).
      const secureBundle = this.parseSecureBundle(data.bundle);
      if (secureBundle) {
        const payload = this.verifyBundleSignature(secureBundle);
        if (!payload) {
          Logger.warn('PluginManager', 'Secure plugin bundle rejected.');
          return 0;
        }
        let loaded = 0;
        for (const plugin of payload.plugins) {
          const code = this.decryptPluginCode(plugin);
          if (!code) continue;
          await this.loadPluginFromCode(plugin.id, code);
          loaded++;
        }
        Logger.log('PluginManager', `Loaded ${loaded} signed+encrypted plugins from API`);
        return loaded;
      }

      // Legacy plaintext fallback (dev only).
      if (IS_PROD) {
        Logger.warn('PluginManager', 'Unsigned plugin bundle blocked in production.');
        return 0;
      }
      if (!data.plugins || !Array.isArray(data.plugins)) {
        Logger.warn('PluginManager', 'Plugin bundle response invalid');
        return 0;
      }
      for (const plugin of data.plugins) {
        await this.loadPluginFromCode(plugin.id, plugin.code);
      }
      Logger.log('PluginManager', `Loaded ${data.plugins.length} legacy plugins from API`);
      return data.plugins.length;
    } catch (err) {
      Logger.error('PluginManager', 'Failed to fetch plugin bundle', err as Error);
      return 0;
    }
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
