// ── Crash tracer ──────────────────────────────────────────────────────────────
// Write uncaught errors to the proxy log before Node exits, so silent crashes
// during the HELLO/reconnect flow stop vanishing.
import { appendFileSync as _crashAppend } from 'fs';
import { join as _crashJoin } from 'path';
import { tmpdir as _crashTmpdir } from 'os';
const _CRASH_LOG_PATH = _crashJoin(_crashTmpdir(), 'realm-engine-proxy.log');
function _logCrash(tag: string, err: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  const e = err instanceof Error ? err : new Error(String(err));
  const line = `[${ts}] [CRASH] ${tag}: ${e.message}\n${e.stack ?? ''}\n`;
  try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
  try { console.error(line); } catch {}
}
process.on('uncaughtException', (err) => _logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => _logCrash('unhandledRejection', reason));
process.on('exit', (code) => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] [EXIT] process.on('exit') code=${code}\n`;
  try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGABRT'] as const) {
  try {
    process.on(sig as NodeJS.Signals, () => {
      const ts = new Date().toISOString().slice(11, 23);
      const line = `[${ts}] [EXIT] received signal ${sig}\n`;
      try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
    });
  } catch {}
}
if (process.send) {
  process.on('disconnect', () => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [EXIT] IPC channel disconnected from parent\n`;
    try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
  });
}
// ──────────────────────────────────────────────────────────────────────────────


import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { GAME_PORT } from './constants/GameId.js';
import { existsSync, readFileSync, readdirSync, copyFileSync } from 'fs';
import { Proxy } from './proxy/Proxy.js';
import { PacketFactory } from './packets/PacketFactory.js';
import { ReconnectHandler } from './proxy/ReconnectHandler.js';
import { attachCoreCommands } from './core/CoreCommands.js';
import { StateManager } from './state/StateManager.js';
import { PartyRosterState } from './state/PartyRosterState.js';
import { ScriptHost } from './scripts/ScriptHost.js';
import type { BridgeClientRef } from './scripts/bridge/BridgeDeps.js';
import { GameWorldState } from './state/GameWorldState.js';
import { ProjectileTracker } from './state/ProjectileTracker.js';
import { GameDataLoader } from './game-data/GameDataLoader.js';
import { PluginManager } from './plugins/PluginManager.js';
import { PacketInspector } from './dashboard/server/PacketInspector.js';
import { DevServer } from './dashboard/server/DevServer.js';
import { GameHooker } from './hooker/GameHooker.js';
import { ExaltFinder } from './hooker/ExaltFinder.js';
import { InternalBridge } from './bridge/InternalBridge.js';
import { setDllFeatureSender } from './bridge/DllFeatureBus.js';
import { attachHiddenHelperTypeSync } from './bridge/HiddenHelperTypes.js';
import { Logger } from './util/Logger.js';
import { ensureRotmgMetadataXml } from './util/ensureRotmgMetadataXml.js';
import { startServices } from './startup/startServices.js';
import { startMetadataEnrichment, type MetadataStatus } from './startup/metadataEnrichment.js';
import type { PluginLoadReport } from './plugins/PluginManager.js';
import { getRealmengineDataDir } from './util/rotmgAssetExtractor.js';
import { ensureSdkDeployed } from './util/ensureSdkDeployed.js';
import { getBakedPacketDefinitions, getBakedServers, getBakedStatTypes } from './config/BakedData.js';
import {
  readMergedClientConfigRaw,
  getClientConfigWritePath,
  getUserClientConfigPath,
  truthyConfigFlag,
} from './util/clientConfigStore.js';

const IS_PROD = process.env.REALM_ENGINE_PROD === '1';
// In packaged builds, main.cjs passes REALM_ENGINE_ROOT = process.resourcesPath so
// that data/ and assets/ (extraResources) are found at the real on-disk location.
// In dev (tsx), fall back to computing from import.meta.url.
const ROOT = process.env.REALM_ENGINE_ROOT
  ? resolve(process.env.REALM_ENGINE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = process.env.REALM_ENGINE_APP_ROOT
  ? resolve(process.env.REALM_ENGINE_APP_ROOT)
  : ROOT;

/** Single path for data/config.json — must match DevServer’s persisted settings file. */
const DATA_CONFIG_PATH = resolve(ROOT, 'data', 'config.json');

type ClientDataConfig = {
  rotmgPath: string | null;
  /** Debug: skip copying winhttp.dll (same as REALM_ENGINE_SKIP_WINHTTP_INSTALL=1). */
  skipWinhttpInstall: boolean;
};


function loadClientDataConfig(): ClientDataConfig {
  const empty: ClientDataConfig = {
    rotmgPath: null,
    skipWinhttpInstall: false,
  };
  try {
    const raw = readMergedClientConfigRaw(ROOT);
    const rotmgPath = String(raw?.rotmgPath || '').trim() || null;
    return {
      rotmgPath,
      skipWinhttpInstall: truthyConfigFlag(raw?.skipWinhttpInstall),
    };
  } catch (err) {
    Logger.warn('Main', `Failed to read config.json: ${(err as Error).message}`);
    return empty;
  }
}

async function main() {
  const devMode = true; // Dashboard always runs — there is no headless mode.

  Logger.log('Main', 'RotMG MITM Proxy starting...');

  // 0. Install game hook (DLL injection for connection redirect)
  const clientDataConfig = loadClientDataConfig();
  const configWritePath = getClientConfigWritePath(ROOT);
  const userOverlayPath = getUserClientConfigPath();
  Logger.log(
    'Main',
    `config write: ${configWritePath}${userOverlayPath ? ` (overlay merges on ${userOverlayPath})` : ''}; bundled defaults: ${DATA_CONFIG_PATH}; skipWinhttp=${clientDataConfig.skipWinhttpInstall}`,
  );
  if (clientDataConfig.skipWinhttpInstall) {
    process.env.REALM_ENGINE_SKIP_WINHTTP_INSTALL = '1';
  } else {
    delete process.env.REALM_ENGINE_SKIP_WINHTTP_INSTALL;
  }
  const configuredRotmgPath = clientDataConfig.rotmgPath;
  const assetsDir = resolve(ROOT, 'assets');
  const hooker = new GameHooker(configuredRotmgPath, assetsDir);
  const hookInstalled = await hooker.install();
  // #region agent log
  // #endregion
  if (!hookInstalled) {
    Logger.warn('Main', 'Game hook not installed - see warnings above.');
    Logger.warn('Main', `Proxy will still run, but game must be manually pointed to 127.0.0.1:${GAME_PORT}.`);
  }

  // 0b. Resolve DLL + injector paths for external injection.
  // The DLL is injected into the running game process on first NewTick packet
  // (handled by DevServer), not pre-deployed to the game folder.
  const dllPath = resolve(assetsDir, 'realm-engine.dll');
  const injectorPath = resolve(assetsDir, 'injector.exe');
  if (!existsSync(dllPath)) {
    Logger.warn('Main', `Internal DLL not found at ${dllPath}. DLL features unavailable until built.`);
  }
  if (!existsSync(injectorPath)) {
    Logger.warn('Main', `Injector not found at ${injectorPath}. DLL injection unavailable until built.`);
  }

  // 0c. Hands-off Steam coverage. Mirror winhttp.dll (connection redirect) into
  // every detected Exalt install so launching from Steam or Deca launcher both
  // redirect to the proxy. Skipped when the user pinned a custom path.
  const primaryInstall = hooker.gameDirectory;
  if (!configuredRotmgPath && primaryInstall) {
    try {
      const primary = primaryInstall;
      const others = ExaltFinder.findAll().filter((d) => d && d !== primary);
      for (const dir of others) {
        const src = resolve(primary, 'winhttp.dll');
        if (!existsSync(src)) continue;
        try {
          copyFileSync(src, resolve(dir, 'winhttp.dll'));
        } catch (err) {
          Logger.warn('Main', `Could not mirror winhttp.dll into ${dir}: ${(err as Error).message} (is the game running there?)`);
        }
        Logger.log('Main', `Mirrored winhttp.dll into additional install${ExaltFinder.isSteamInstall(dir) ? ' (Steam)' : ''}: ${dir}`);
      }
      if (others.length === 0) {
        Logger.log('Main', `One Exalt install detected${ExaltFinder.isSteamInstall(primary) ? ' (Steam)' : ''}: ${primary}`);
      }
    } catch (err) {
      Logger.warn('Main', `Hook mirror step failed: ${(err as Error).message}`);
    }
  }

  // 1. Load packet definitions
  const bakedPacketDefinitions = getBakedPacketDefinitions();
  const bakedStatTypes = getBakedStatTypes();
  const defsPath = resolve(ROOT, 'data', 'packet-definitions.json');
  const statTypesPath = resolve(ROOT, 'data', 'stat-types.json');
  const packetFactory = new PacketFactory(
    bakedPacketDefinitions ?? defsPath,
    bakedStatTypes ?? statTypesPath,
  );

  // 2. Create proxy
  const proxy = new Proxy(packetFactory);

  const dataDir = resolve(ROOT, 'data');
  // Generated game XML belongs in the persistent user cache. In dev mode the
  // WSL -> Windows mirror removes files that exist only under ROOT/data.
  const gameDataDir = getRealmengineDataDir();

  // 3. Load game data (objects.xml for projectile definitions, tiles.xml for tile damage)
  const objectsPath = resolve(gameDataDir, 'objects.xml');
  const tilesPath = resolve(gameDataDir, 'tiles.xml');
  const gameData = new GameDataLoader();
  try {
    gameData.load(objectsPath);
  } catch (err) {
    Logger.warn('Main', `Failed to load objects.xml: ${(err as Error).message}`);
  }
  try {
    gameData.loadTiles(tilesPath);
  } catch (err) {
    Logger.warn('Main', `Failed to load tiles.xml: ${(err as Error).message} (run: npm run download-game-xml -- --dir ./data)`);
  }

  // 4. Attach core handlers (built-in, not plugins)
  const stateManager = new StateManager();
  stateManager.attach(proxy);

  const worldState = new GameWorldState();
  worldState.attach(proxy);

  const projectileTracker = new ProjectileTracker(gameData, worldState);
  projectileTracker.attach(proxy);

  const partyRoster = new PartyRosterState();
  partyRoster.attach(proxy);

  const reconnectHandler = new ReconnectHandler();
  reconnectHandler.attach(proxy);

  attachCoreCommands(proxy, dataDir, getBakedServers());

  if (Logger.isPacketDebugEnabled()) {
    proxy.on('serverPacket', (_client: any, packet: any) => {
      if (!['NEWTICK', 'PING', 'UNKNOWN_11'].includes(packet.name) && !packet.name.startsWith('UNKNOWN_')) {
        Logger.log('Debug', `S->C: ${packet.name} (id=${packet.id}, size=${packet.rawBytes.length}, defined=${packet.isDefined})`);
      }
      if (packet.name.startsWith('UNKNOWN_')) {
        Logger.log('Debug', `S->C: ${packet.name} (size=${packet.rawBytes.length})`);
      }
    });
    proxy.on('clientPacket', (_client: any, packet: any) => {
      if (!['MOVE'].includes(packet.name)) {
        Logger.log('Debug', `C->S: ${packet.name} (id=${packet.id}, size=${packet.rawBytes.length}, defined=${packet.isDefined})`);
      }
    });
  }

  // 5. Plugin manager (load after dashboard is listening — see below)
  const pluginDir = IS_PROD ? resolve(APP_ROOT, 'dist', 'plugins') : resolve(ROOT, 'plugins');
  // In packaged builds, bundled plugins live in APP_ROOT/dist/plugins.
  // Keep loading those by default so portable can function even if API bundle is empty.
  const allowLocalDiskPlugins = !IS_PROD
    || existsSync(pluginDir)
    || process.env.REALM_ENGINE_ALLOW_DISK_PLUGINS === '1';
  // #region agent log
  // #endregion
  if (existsSync(pluginDir)) {
    const bundledPlugins = readdirSync(pluginDir).filter((file) => file.endsWith('.js') || file.endsWith('.ts'));
    Logger.log('Main', `Plugin directory: ${pluginDir} (${bundledPlugins.length} files)`);
  } else {
    Logger.warn('Main', `Plugin directory not found: ${pluginDir}`);
  }
  if (!allowLocalDiskPlugins) {
    Logger.warn('Main', 'Local disk plugins disabled in production (set REALM_ENGINE_ALLOW_DISK_PLUGINS=1 to override).');
  }
  // User plugin dir matches Latest's PluginManager signature — loose `.mjs` files
  // dropped into Documents/Realmengine/Plugins are loaded alongside the bundled set.
  const userPluginDir = join(
    process.env.USERPROFILE || homedir(),
    'Documents',
    'Realmengine',
    'Plugins',
  );
  const pluginManager = new PluginManager(
    proxy,
    pluginDir,
    userPluginDir,
    allowLocalDiskPlugins,
    gameData,
    worldState,
    projectileTracker,
    () => ({ worldState, projectileTracker }),
  );


  // 6. Dev dashboard FIRST — Electron only waits ~10s for http://localhost:3000; metadata fetch can be slow
  let devServer: DevServer | undefined;
  let scriptHost: ScriptHost | undefined;
  if (devMode) {
    const inspector = new PacketInspector();
    inspector.attach(proxy);

    const bridgeClientRef: BridgeClientRef = { current: undefined };

    const publicDir = resolve(ROOT, 'src', 'dashboard', 'public');
    // Latest's DevServer derives configPath/ROOT internally from publicDir.
    devServer = new DevServer(inspector, pluginManager, publicDir, worldState, gameData);
    devServer.setDetectedGamePath(hooker.gameDirectory);
    devServer.setBridgeClientRef(bridgeClientRef);
    devServer.attachProxy(proxy);

    // SDK script runtime — patch @realmengine/sdk in-process so user scripts in
    // Documents/Realmengine/Scripts can talk to the live proxy/state/party.
    const scriptSession = { scriptId: undefined as string | undefined };
    scriptHost = new ScriptHost(scriptSession);
    scriptHost.onLog((id, line, level) => {
      devServer?.broadcastScriptLog(id, line, level);
    });
    devServer.setScriptHost(scriptHost);
    scriptHost.installBridge({
      stateManager,
      clientRef: bridgeClientRef,
      worldState,
      getWorldStateForClient: () => worldState,
      partyRoster,
      gameData,
      proxy,
      scriptSession,
      emitScriptLog: (scriptId, line, level) => {
        devServer?.broadcastScriptLog(scriptId, line, level);
      },
      emitScriptPanelMessage: (msg) => {
        devServer?.broadcastScriptPanelMessage(msg);
      },
    });
    ensureSdkDeployed();
    scriptHost.setScriptsStateNotify(() => {
      devServer?.broadcastScriptsState();
    });
    devServer.start(4440);
  }

  const internalBridge = new InternalBridge('admin-dev');
  setDllFeatureSender((key, value) => internalBridge.setFeature(key, value));
  // objects.xml hidden helpers (invisible spawners/triggers) for the native enemy
  // lock and auto-aim: sent now, on every DLL (re)connect, and on game-data reload.
  attachHiddenHelperTypeSync(gameData, internalBridge);

  const startupController = new AbortController();
  let metadataStatus: MetadataStatus = { state: 'loading', failed: [] };
  let pluginReport: PluginLoadReport | null = null;
  const publishStartup = () => {
    if (!startupController.signal.aborted) devServer?.setStartupStatus({ metadata: metadataStatus, plugins: pluginReport });
  };
  const markReady = (stage: string) => {
    if (!startupController.signal.aborted) Logger.log('Startup', `launch=${process.env.REALM_ENGINE_LAUNCH_ID ?? process.pid} process=proxy stage=${stage} elapsedMs=${performance.now().toFixed(1)}`);
  };
  proxy.once('listenStarted', () => markReady('proxy-listening'));
  internalBridge.once('listening', () => markReady('pipe-listening'));
  /**
   * `exitCode` defaults to 0 (the normal clean shutdown every existing
   * caller gets) — SIGINT/SIGTERM below always call this with no argument,
   * deliberately, so nothing the signal event itself might pass through
   * could ever change the exit code.
   */
  const shutdown = async (exitCode = 0) => {
    if (startupController.signal.aborted) return;
    startupController.abort();
    devServer?.stop();
    Logger.log('Main', 'Shutting down...');
    scriptHost?.stopAll();
    internalBridge.stop();
    setDllFeatureSender(null);
    proxy.stop();
    pluginManager.stopWatching();
    await hooker.uninstall();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  void startMetadataEnrichment({
    signal: startupController.signal,
    publish: status => {
      metadataStatus = status;
      publishStartup();
      if (status.state === 'unavailable') Logger.warn('Metadata', `Optional metadata unavailable: ${status.failed.join(', ')}`);
    },
    run: signal => ensureRotmgMetadataXml(gameDataDir, {
      signal,
      log(level, message) {
        if (level === 'error') Logger.error('Metadata', message);
        else if (level === 'warn') Logger.warn('Metadata', message);
        else Logger.log('Metadata', message);
      },
    }),
  });

  // 8. Start proxy

  if (hookInstalled) {
    Logger.log('Main', `Game hook active - Exalt at ${hooker.gameDirectory}`);
  }
  if (devMode) {
    Logger.log('Main', 'Dev dashboard: http://localhost:4440');
  }

  // 9. Start the internal DLL bridge (named pipe to injected DLL). Node.js is the
  //    pipe server; the injected DLL connects to us. listen() starts the server
  //    once at startup and it stays open — no reconnect hammering needed.
  // Feed the DLL's authoritative memory defense into StateManager so it can
  // self-check the wire defense model on each character load (DefenseCheck log).
  stateManager.setDllDefenseSource(() => internalBridge.getDllDefense());
  if (devServer) {
    devServer.setInternalBridge(internalBridge);
    devServer.setInjectorPaths(dllPath, injectorPath);
  }
  // Start the pipe server — the injected DLL connects to us.
  // No reconnect hammering; server just listens until DLL injects.
  await startServices({
    signal: startupController.signal,
    loadPlugins: () => pluginManager.loadAll(),
    applyProfile: () => { devServer?.tryAutoLoadDefaultPluginConfig(); },
    startWatching: () => pluginManager.startWatching(),
    publish: report => {
      pluginReport = report;
      publishStartup();
      markReady('plugin-profile-ready');
      if (report.failed.length) Logger.warn('Main', `Plugin initialization degraded: ${report.failed.join(', ')}`);
      devServer?.broadcastPluginState();
    },
    startProxy: () => proxy.start('127.0.0.1', GAME_PORT),
    startPipe: () => internalBridge.listen(),
  });
  // Forward DLL state/player messages to any listeners
  internalBridge.on('message', (msg: any) => {
    devServer?.broadcastDllMessage(msg);
  });

}

main().catch((err) => {
  Logger.error('Main', 'Fatal error', err);
  process.exit(1);
});
