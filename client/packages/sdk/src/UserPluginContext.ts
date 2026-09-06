/**
 * Type definition for the restricted plugin context passed to the `register()`
 * function of a community `.mjs` plugin. The runtime implementation lives in
 * the RealmEngine client; this module only exists so plugin authors can get
 * IntelliSense via a JSDoc annotation:
 *
 *   /\*\* @param {import('@realmengine/sdk').UserPluginContext} ctx *\/
 *   export function register(ctx) { ... }
 *
 * Plugins reach the game world exclusively through the rest of the SDK
 * (`chat`, `events`, `RealmEngine.self`, etc.). `ctx` only covers
 * plugin-runtime concerns the SDK cannot scope to an individual plugin:
 * identity, dashboard-driven state (`enabled`), per-plugin settings, and
 * per-plugin chat commands.
 *
 * Teardown is done by returning a cleanup function from `register(ctx)`:
 *
 *   export function register(ctx) {
 *     const unsub = events.onEnemySpawned(handler);
 *     return () => unsub();
 *   }
 */

/** Primary category for Plugins hub (sidebar filter + grouping). */
export type PluginCategory =
  | 'combat'
  | 'movement'
  | 'automation'
  | 'visual'
  | 'network'
  | 'utility'
  | 'admin';

/** A single user-editable setting shown in the dashboard under a plugin's toggle. */
export interface PluginSettingDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  value: any;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  /** If set on a text setting, its current value is used as a single-key hotkey that fires the named button key. */
  hotkeyFor?: string;
  /** If true, the setting is hidden from the dashboard UI (value can still be set programmatically). */
  hidden?: boolean;
}

/** Handler signature for a `/command` registered via `ctx.registerCommand`. */
export type PluginCommandHandler = (args: string[]) => void;

/** Cleanup callback a plugin may return from `register(ctx)`. */
export type PluginCleanup = () => void;

/**
 * Restricted plugin context handed to community `.mjs` plugins.
 *
 * Note: full packet-level access, dashboard log routing and structured
 * dashboard broadcasts are reserved for bundled first-party plugins shipped
 * with the RealmEngine client. User plugins compose behaviour out of the
 * rest of `@realmengine/sdk` (`chat`, `events`, `RealmEngine.*`, ...).
 *
 * This interface is the single authored declaration of the community context
 * shape. The client's runtime `UserPluginContext` class
 * (`src/plugins/UserPluginContext.ts`) `implements` it, so the compiler fails
 * the build if the runtime ever stops satisfying this surface — the two can no
 * longer be hand-copied out of sync.
 */
export interface UserPluginContext {
  /** The plugin id — derived from the file name, without `.mjs`. Read-only. */
  readonly pluginId: string;
  /** Absolute path to the `.mjs` file RealmEngine loaded this plugin from. Read-only. */
  readonly pluginFile: string;

  /** Dashboard display name. Defaults to `pluginId` if unset. */
  name: string;
  /** Plugins hub category (default `'utility'`). */
  category: PluginCategory;
  /**
   * Whether the plugin is currently enabled. Driven by the dashboard toggle.
   * `ctx.registerCommand` handlers are automatically gated by this flag;
   * SDK subscriptions (e.g. `events.onEnemySpawned`) fire regardless — check
   * `ctx.enabled` inside the handler yourself if you want them to respect it.
   */
  readonly enabled: boolean;

  /** Register a user-editable setting shown in the dashboard. */
  registerSetting(
    key: string,
    config: Omit<PluginSettingDef, 'key'>,
    onChange?: (value: any) => void,
  ): void;

  /** Read the current value of a setting. */
  getSetting<T = any>(key: string): T;

  /**
   * Register a chat command (e.g. `'greet'` → `/greet`).
   * The handler receives the parsed argument list. To reply, call
   * `chat.notify(...)` or `chat.say(...)` from `@realmengine/sdk`.
   */
  registerCommand(command: string, handler: PluginCommandHandler): void;
}
