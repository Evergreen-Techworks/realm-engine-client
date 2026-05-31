import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { SDKBridge } from './bridge/index.js';
import type { BridgeDeps, ScriptLogLevel, ScriptPanelInboundEvent } from './bridge/BridgeDeps.js';

export interface ScriptInfo {
  id: string;
  name: string;
  developer: string;
  version: string;
  path: string;
  rootPath: string;
  entry: string;
  status: 'idle' | 'running' | 'error';
  error?: string;
  /** User-facing status from the running script (“Killing gods”, “Trading”), via ScriptUi.setActivity */
  activity?: string;
  /** Epoch milliseconds for the current run, only present while running. */
  startedAt?: number;
  /** Current run duration in milliseconds, only present while running. */
  runtimeMs?: number;
}

interface ScriptManifest {
  name?: unknown;
  developer?: unknown;
  version?: unknown;
  entry?: unknown;
}

interface ScriptInstance {
  onStart(): void;
  onLoop(): number;
  onStop(): void;
}

const SCRIPT_MANIFEST = 'realmengine.script.json';

export class ScriptHost {
  private scriptsDir: string;
  private running: Map<string, { instance: ScriptInstance; timer: NodeJS.Timeout; startedAt: number }> = new Map();
  private logCallback?: (id: string, line: string, level: ScriptLogLevel) => void;
  private bridgeInstalled = false;
  private readonly scriptSession: { scriptId: string | undefined };
  /** Latest activity line per script id for dashboard cards. */
  private scriptActivityById = new Map<string, string>();
  /** DevServer notifies dashboard WS clients when activity or runnable state changes (optional). */
  private scriptsStateNotify?: () => void;

  constructor(scriptSession: { scriptId: string | undefined }) {
    this.scriptSession = scriptSession;
    this.scriptsDir = join(
      process.env.USERPROFILE || homedir(),
      'Documents',
      'Realmengine',
      'Scripts'
    );
  }

  /** DevServer pushes updated script list (`activity`, status) to dashboard sockets when set. */
  setScriptsStateNotify(cb?: () => void): void {
    this.scriptsStateNotify = cb;
  }

  private emitScriptsStateChanged(): void {
    try {
      this.scriptsStateNotify?.();
    } catch {
      /* ignore broadcaster errors */
    }
  }

  /**
   * Bridge calls (chat, async timers, etc.) often run outside `withScriptId`, so
   * `scriptSession.scriptId` is cleared. Use the session id when set; otherwise
   * attribute to the only running script when unambiguous.
   */
  private resolveActivityScriptId(deps: BridgeDeps): string | undefined {
    const sid = deps.scriptSession.scriptId;
    if (sid && String(sid).trim()) return String(sid).trim();
    if (this.running.size === 1) {
      return this.running.keys().next().value as string;
    }
    return undefined;
  }

  /** Patch @realmengine/sdk stubs with host implementations (`chat`, `party`, `events`, ...). Call once at startup. */
  installBridge(deps: BridgeDeps): void {
    if (this.bridgeInstalled) return;
    deps.setScriptActivityLabel = (label) => {
      const id = this.resolveActivityScriptId(deps);
      if (!id) return;
      if (label == null || String(label).trim() === '') {
        this.scriptActivityById.delete(id);
      } else {
        this.scriptActivityById.set(id, String(label).trim());
      }
      this.emitScriptsStateChanged();
    };
    SDKBridge.install(deps);
    this.bridgeInstalled = true;
  }

  /** Called by DevServer to forward logs to WebSocket */
  onLog(cb: (id: string, line: string, level: ScriptLogLevel) => void) {
    this.logCallback = cb;
  }

  private withScriptId<T>(id: string, fn: () => T): T {
    const prev = this.scriptSession.scriptId;
    this.scriptSession.scriptId = id;
    try {
      return fn();
    } finally {
      this.scriptSession.scriptId = prev;
    }
  }

  private log(id: string, line: string, level: ScriptLogLevel = 'info') {
    const msg = `[${id}] ${line}`;
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
    this.logCallback?.(id, msg, level);
  }

  private isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  }

  private parseManifest(scriptRoot: string): ScriptInfo {
    const manifestPath = join(scriptRoot, SCRIPT_MANIFEST);
    const folderName = basename(scriptRoot);

    if (!existsSync(manifestPath)) {
      throw new Error(`Missing ${SCRIPT_MANIFEST}`);
    }

    let manifest: ScriptManifest;
    try {
      const manifestText = readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
      manifest = JSON.parse(manifestText) as ScriptManifest;
    } catch (err: any) {
      throw new Error(`Invalid ${SCRIPT_MANIFEST}: ${err.message}`);
    }

    const name = String(manifest.name ?? '').trim();
    const developer = String(manifest.developer ?? '').trim();
    const version = String(manifest.version ?? '').trim();
    const entry = String(manifest.entry ?? '').trim();

    if (!name) throw new Error(`${SCRIPT_MANIFEST} is missing "name"`);
    if (!developer) throw new Error(`${SCRIPT_MANIFEST} is missing "developer"`);
    if (!version) throw new Error(`${SCRIPT_MANIFEST} is missing "version"`);
    if (!entry) throw new Error(`${SCRIPT_MANIFEST} is missing "entry"`);
    if (entry.includes('\\')) throw new Error(`${SCRIPT_MANIFEST} entry must use forward slashes`);
    if (!entry.endsWith('.mjs')) throw new Error(`${SCRIPT_MANIFEST} entry must point to a .mjs file`);

    const rootPath = resolve(scriptRoot);
    const entryPath = resolve(scriptRoot, entry);
    if (!this.isInside(rootPath, entryPath)) {
      throw new Error(`${SCRIPT_MANIFEST} entry must stay inside the script folder`);
    }
    if (!existsSync(entryPath)) {
      throw new Error(`Entry file not found: ${entry}`);
    }
    if (!statSync(entryPath).isFile()) {
      throw new Error(`Entry is not a file: ${entry}`);
    }

    const runningEntry = this.running.get(folderName);

    return {
      id: folderName,
      name,
      developer,
      version,
      path: entryPath,
      rootPath,
      entry,
      status: runningEntry ? 'running' : 'idle',
      activity: this.scriptActivityById.get(folderName),
      startedAt: runningEntry?.startedAt,
      runtimeMs: runningEntry ? Math.max(0, Date.now() - runningEntry.startedAt) : undefined,
    };
  }

  private getScript(id: string): ScriptInfo | undefined {
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.') || id === 'node_modules') {
      return undefined;
    }
    const scriptRoot = join(this.scriptsDir, id);
    if (!existsSync(scriptRoot)) return undefined;
    try {
      if (!statSync(scriptRoot).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    try {
      return this.parseManifest(scriptRoot);
    } catch (err: any) {
      return {
        id,
        name: id,
        developer: 'Unknown',
        version: 'Unknown',
        path: scriptRoot,
        rootPath: scriptRoot,
        entry: '',
        status: 'error',
        error: err.message,
      };
    }
  }

  /** Scans the Scripts folder for script package folders with .mjs entries. */
  list(): ScriptInfo[] {
    if (!existsSync(this.scriptsDir)) {
      return [];
    }

    return readdirSync(this.scriptsDir)
      .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
      .map((name) => join(this.scriptsDir, name))
      .filter((entryPath) => {
        try {
          return statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      })
      .map((scriptRoot) => {
        try {
          return this.parseManifest(scriptRoot);
        } catch (err: any) {
          const id = basename(scriptRoot);
          return {
            id,
            name: id,
            developer: 'Unknown',
            version: 'Unknown',
            path: scriptRoot,
            rootPath: scriptRoot,
            entry: '',
            status: 'error',
            error: err.message,
          } as ScriptInfo;
        }
      });
  }

  /** Loads and starts a script package by folder id. */
  async start(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.running.has(id)) {
      return { ok: false, error: 'Already running' };
    }

    this.scriptActivityById.delete(id);
    this.emitScriptsStateChanged();

    const script = this.getScript(id);
    if (!script) {
      return { ok: false, error: `Script package not found: ${id}` };
    }
    if (script.status === 'error') {
      return { ok: false, error: script.error ?? 'Script package is invalid' };
    }
    if (!script.path.endsWith('.mjs')) {
      return { ok: false, error: 'Only .mjs script entries are supported' };
    }

    try {
      const fileUrl = pathToFileURL(script.path).href;
      const mod = await import(`${fileUrl}?t=${Date.now()}`);

      const ScriptClass = mod.default;
      if (!ScriptClass) {
        return { ok: false, error: 'Script has no default export' };
      }

      const instance = new ScriptClass() as ScriptInstance;
      if (
        typeof instance.onStart !== 'function' ||
        typeof instance.onLoop !== 'function' ||
        typeof instance.onStop !== 'function'
      ) {
        return { ok: false, error: 'Script must implement onStart(), onLoop(), and onStop()' };
      }

      {
        const diagBag = (globalThis as unknown as { __realmengineSDK?: { RealmEngine?: { ui?: { status?: unknown; panel?: { define?: unknown } } } } }).__realmengineSDK;
        const diagUi = diagBag?.RealmEngine?.ui;
        const diagStatusSrc = typeof diagUi?.status === 'function' ? Function.prototype.toString.call(diagUi.status).slice(0, 60) : String(diagUi?.status);
        console.error('[ScriptHost] DIAG pre-onStart: bag=%s RealmEngine=%s ui=%s status=%s panel.define=%s\n  status.src=%s',
          !!diagBag, !!diagBag?.RealmEngine, !!diagUi, typeof diagUi?.status, typeof diagUi?.panel?.define, diagStatusSrc);
      }

      this.withScriptId(id, () => {
        this.log(id, `Starting ${script.name} v${script.version} by ${script.developer}...`);
        instance.onStart();
      });

      const startedAt = Date.now();
      const schedule = () => {
        if (!this.running.has(id)) return;
        this.withScriptId(id, () => {
          try {
            const delay = instance.onLoop();
            if (typeof delay === 'number' && delay < 0) {
              this.log(id, 'Script requested stop (onLoop returned < 0).');
              this.stop(id);
              return;
            }
            const timer = setTimeout(schedule, typeof delay === 'number' ? delay : 600);
            this.running.set(id, { instance, timer, startedAt });
          } catch (err: any) {
            this.log(id, `Error in onLoop: ${err.message}`, 'error');
            this.stop(id);
          }
        });
      };

      const timer = setTimeout(schedule, 0);
      this.running.set(id, { instance, timer, startedAt });
      this.withScriptId(id, () => this.log(id, `Running ${script.name} v${script.version} by ${script.developer}.`));

      this.emitScriptsStateChanged();

      return { ok: true };
    } catch (err: any) {
      console.error('[ScriptHost] start() caught error for', id, ':\n', err?.stack || err?.message || String(err));
      return { ok: false, error: err.message };
    }
  }

  /** Stops a running script by id */
  stop(id: string): { ok: boolean; error?: string } {
    const entry = this.running.get(id);
    if (!entry) {
      return { ok: false, error: 'Not running' };
    }

    clearTimeout(entry.timer);
    this.running.delete(id);
    this.scriptActivityById.delete(id);
    try {
      SDKBridge.panelRegistry?.destroyForScript(id);
    } catch {
      /* registry teardown errors shouldn't block script stop */
    }
    this.emitScriptsStateChanged();

    this.withScriptId(id, () => {
      try {
        entry.instance.onStop();
        this.log(id, 'Stopped.');
      } catch (err: any) {
        this.log(id, `Error in onStop: ${err.message}`, 'error');
      }
    });

    return { ok: true };
  }

  /** Stops all running scripts */
  stopAll() {
    for (const id of this.running.keys()) {
      this.stop(id);
    }
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  getScriptsDir(): string {
    return this.scriptsDir;
  }

  /**
   * DevServer calls this for dashboard widget events (button clicks, slider
   * changes, user-closed-popout). Routes into the script's handler with the
   * right scriptId pushed onto the bridge session.
   */
  dispatchPanelEvent(evt: ScriptPanelInboundEvent): void {
    SDKBridge.panelRegistry?.dispatchEvent(evt, (id, fn) => this.withScriptId(id, fn));
  }

  /** Snapshot of a script's panel (so dashboards joining late can hydrate). */
  getPanelSnapshot(scriptId: string): { def: unknown; isOpen: boolean } | undefined {
    return SDKBridge.panelRegistry?.snapshot(scriptId);
  }

  /** All script ids with a registered panel — used to bootstrap dashboard state. */
  panelScriptIds(): string[] {
    return SDKBridge.panelRegistry?.scriptIds() ?? [];
  }
}
