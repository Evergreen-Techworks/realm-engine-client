import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { GameWorldState } from '../state/GameWorldState.js';
import type { ProjectileTracker } from '../state/ProjectileTracker.js';
import { Logger } from '../util/Logger.js';

type SessionStateResolver = (client: ClientConnection) => {
  worldState: GameWorldState | null;
  projectileTracker: ProjectileTracker | null;
};

/** Primary category for Plugins hub (sidebar filter + grouping). */
export type PluginCategory =
  | 'combat'
  | 'movement'
  | 'automation'
  | 'visual'
  | 'network'
  | 'utility'
  | 'admin';

export interface SettingDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  value: any;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  /** If set, this setting is rendered only when another setting has the requested value. */
  visibleWhen?: { key: string; value?: any; values?: any[] };
  /** If set on a text setting, its current value is used as a single-key hotkey that fires the named button key. */
  hotkeyFor?: string;
  /** If true, the setting is not rendered in the dashboard UI (value can still be set via updateSetting). */
  hidden?: boolean;
  /** If true, the setting is only shown when the plugin's "Advanced settings"
   *  toggle is on. Default (simple) mode hides it. Use for deep tuning knobs
   *  most users never touch, to keep the panel uncluttered. */
  advanced?: boolean;
  /**
   * Show a red warning on this setting (label turns red + an inline alert, plus a
   * ⚠ icon on the plugin's enable/disable row) when another setting's value
   * conflicts with this one. Generic: any plugin can declare this; the dashboard
   * evaluates it from live plugin data, so it stays reactive to changes in either
   * setting without the plugin pushing updates. Numeric comparison only
   * (booleans coerce to 0/1).
   */
  warnWhen?: {
    /** Plugin id to read the compared setting from. Defaults to this plugin,
     *  so a plugin can compare two of its own settings. */
    pluginId?: string;
    /** The compared setting's key (e.g. `'threshold'`). */
    key: string;
    /** Warn when `other <cmp> this`, where `other` is the compared value and
     *  `this` is this setting's value. */
    cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
    /** Warning text shown in red. */
    message: string;
  };
}

/**
 * API surface provided to each plugin.
 * Plugins receive this in their `register()` function.
 */
export class PluginContext {
  private _enabled = true;
  private _name: string;
  private _category: PluginCategory | undefined;
  private _settings = new Map<string, SettingDef>();
  private _settingCallbacks = new Map<string, (value: any) => void>();
  /** Snapshot of each setting's value at registration time — never mutated
   *  by updateSetting. Powers the dashboard "Reset to defaults" button. */
  private _settingDefaults = new Map<string, any>();
  private _enabledChangeCallbacks: ((enabled: boolean) => void)[] = [];
  private _data = new Map<string, any>();
  private _cleanupFns: (() => void)[] = [];

  /** Callback set by PluginManager to route logs to the dashboard (not console). */
  public onDashboardLog: ((pluginName: string, message: string) => void) | null = null;

  /** Callback set by PluginManager to broadcast structured data to dashboard clients. */
  public onBroadcastData: ((pluginId: string, type: string, data: any) => void) | null = null;

  /** Game data (objects.xml parsed). Available after proxy startup. */
  public readonly gameData: GameDataLoader | null;
  /** Live entity tracker. Available after proxy startup. */
  public readonly worldState: GameWorldState | null;
  /** Active projectile tracker. Available after proxy startup. */
  public readonly projectileTracker: ProjectileTracker | null;
  private readonly sessionStateResolver: SessionStateResolver | null;

  /**
   * Player position for pathfinding/display. Returns client packet pos.
   */
  getEffectivePlayerPos(client: ClientConnection): { x: number; y: number } | null {
    return client.playerData?.pos ?? null;
  }

  constructor(
    private proxy: Proxy,
    public readonly pluginId: string,
    public readonly pluginFile: string,
    gameData?: GameDataLoader,
    worldState?: GameWorldState,
    projectileTracker?: ProjectileTracker,
    sessionStateResolver?: SessionStateResolver,
  ) {
    this._name = pluginId;
    this.gameData = gameData ?? null;
    this.worldState = worldState ?? null;
    this.projectileTracker = projectileTracker ?? null;
    this.sessionStateResolver = sessionStateResolver ?? null;
  }

  /**
   * Session-aware world state resolver.
   * Falls back to shared world state when per-client routing is unavailable.
   */
  getWorldState(client: ClientConnection): GameWorldState | null {
    return this.sessionStateResolver?.(client).worldState ?? this.worldState;
  }

  /**
   * Session-aware projectile tracker resolver.
   * Falls back to shared tracker when per-client routing is unavailable.
   */
  getProjectileTracker(client: ClientConnection): ProjectileTracker | null {
    return this.sessionStateResolver?.(client).projectileTracker ?? this.projectileTracker;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(val: boolean) {
    this._enabled = val;
    Logger.debug('plugin-config', 'Plugin', `${this._name} ${val ? 'enabled' : 'disabled'}`);
    for (const cb of this._enabledChangeCallbacks) {
      try { cb(val); } catch {}
    }
  }

  /** Register a callback that fires whenever the plugin is enabled or disabled. */
  onEnabledChange(cb: (enabled: boolean) => void): void {
    this._enabledChangeCallbacks.push(cb);
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

  // ─── Settings ────────────────────────────────────────

  /** Register a configurable setting (shown in dashboard). */
  registerSetting(
    key: string,
    config: Omit<SettingDef, 'key'>,
    onChange?: (value: any) => void,
  ): void {
    this._settings.set(key, { key, ...config });
    if (onChange) this._settingCallbacks.set(key, onChange);
    // Capture the registration-time value as the canonical default. Buttons
    // don't store a value, so skip them.
    if (config.type !== 'button') {
      this._settingDefaults.set(key, config.value);
    }
  }

  /**
   * Reset every setting to the value it was originally registered with.
   * Drives each through updateSetting() so the change callback fires and
   * the DLL / dashboard stay in sync. Buttons are skipped (no defaults).
   * Returns the keys that were actually reset (i.e. value differed).
   */
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

  /** Get current value of a setting. */
  getSetting<T = any>(key: string): T {
    return this._settings.get(key)?.value;
  }

  /** Update a setting value (called by dashboard). */
  updateSetting(key: string, value: any): boolean {
    const setting = this._settings.get(key);
    if (!setting) return false;

    // Type coercion
    if (setting.type === 'number' || setting.type === 'range') {
      value = Number(value);
      if (isNaN(value)) return false;
      if (setting.min !== undefined) value = Math.max(setting.min, value);
      if (setting.max !== undefined) value = Math.min(setting.max, value);
    } else if (setting.type === 'boolean') {
      value = !!value;
    } else if (setting.type === 'button') {
      // Buttons don't store a value — just fire the callback
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

  /** Get all settings for dashboard rendering. */
  getSettings(): SettingDef[] {
    return [...this._settings.values()];
  }

  // ─── Plugin Data (runtime, accessible by PluginManager) ──

  /** Store plugin runtime data accessible by PluginManager/DevServer. */
  setData(key: string, value: any): void {
    this._data.set(key, value);
  }

  /** Read plugin runtime data. */
  getData<T = any>(key: string): T | undefined {
    return this._data.get(key) as T | undefined;
  }

  /** Broadcast structured data to all dashboard clients via WebSocket. */
  broadcastData(type: string, data: any): void {
    if (this.onBroadcastData) {
      this.onBroadcastData(this.pluginId, type, data);
    }
  }

  /**
   * Hook a packet by name. Handler fires only when plugin is enabled.
   * @param options.prepend — run before all other plugins’ hooks for this packet (use for autonexus‑class latency).
   */
  hookPacket(
    packetName: string,
    handler: (client: ClientConnection, packet: Packet) => void,
    options?: { prepend?: boolean },
  ): void {
    const prepend = options?.prepend === true;
    this.proxy.hookPacket(
      packetName,
      (client, packet) => { if (this._enabled) handler(client, packet); },
      this.pluginId,
      prepend,
    );
  }

  /**
   * Hook ALL packets in both directions via the proxy EventEmitter.
   * fromClient=true  → packet originated from the game client (C→S direction).
   * fromClient=false → packet originated from the game server (S→C direction).
   *
   * Runs before named hookPacket handlers.  Set packet.send = false to block.
   * Used by the lagswitch to intercept every packet regardless of type.
   */
  hookAllPackets(handler: (client: ClientConnection, packet: Packet, fromClient: boolean) => void): void {
    const onServer = (client: ClientConnection, packet: Packet) => {
      if (this._enabled) handler(client, packet, false);
    };
    const onClient = (client: ClientConnection, packet: Packet) => {
      if (this._enabled) handler(client, packet, true);
    };
    this.proxy.on('serverPacket', onServer as any);
    this.proxy.on('clientPacket', onClient as any);
    // Register for cleanup so the listener is removed when the plugin is unloaded.
    this._cleanupFns.push(() => {
      this.proxy.off('serverPacket', onServer as any);
      this.proxy.off('clientPacket', onClient as any);
    });
  }

  /** Hook a chat command (e.g., "/autonexus"). */
  hookCommand(command: string, handler: (client: ClientConnection, command: string, args: string[]) => void): void {
    this.proxy.hookCommand(command, (client, cmd, args) => {
      handler(client, cmd, args);
      return true;
    }, this.pluginId);
  }

  /** Listen for proxy-level events. */
  on(event: 'clientConnected' | 'clientDisconnected', handler: (client: ClientConnection) => void): void {
    this.proxy.on(event, (client: ClientConnection) => {
      if (this._enabled) handler(client);
    });
  }

  /** Create an empty packet by name for sending. */
  createPacket(name: string): Packet {
    return this.proxy.packetFactory.createByName(name);
  }

  /** Serialize a packet to raw bytes (for inspection/debugging). */
  serializePacket(packet: Packet): Buffer {
    return this.proxy.packetFactory.serialize(packet);
  }

  /** Send a text notification to the client (appears as server message). */
  sendNotification(client: ClientConnection, sender: string, message: string): void {
    const textPacket = this.createPacket('TEXT');
    textPacket.data = {
      name: sender,
      objectId: -1,
      numStars: -1,
      bubbleTime: 0,
      recipient: '',
      text: message,
      cleanText: message,
      isSupporter: false,
      starBg: 0,
    };
    client.sendToClient(textPacket);
  }

  /** Log a message with the plugin name (prints to console). */
  log(message: string): void {
    Logger.log(this._name, message);
  }

  /** Log a message to the dashboard only (no console output). */
  dashboardLog(message: string): void {
    if (this.onDashboardLog) {
      this.onDashboardLog(this._name, message);
    }
  }

  /** Register a cleanup function to be called when the plugin is unloaded (e.g., clear intervals). */
  registerCleanup(fn: () => void): void {
    this._cleanupFns.push(fn);
  }

  /** Called by PluginManager when the plugin is unloaded or hot-reloaded. */
  runCleanup(): void {
    for (const fn of this._cleanupFns) { try { fn(); } catch {} }
    this._cleanupFns = [];
  }
}
