/**
 * Test Lab unattended run — TESTLAB_PRIVATE_ONLY.
 *
 * Private-build-only feature: on startup, if a fresh `run-request.json` is
 * waiting beside the client log, this plugin launches the named saved
 * account by label, waits until in world, applies per-run plugin overrides
 * through a throwaway config (never the saved default), starts a script,
 * runs for the requested number of minutes, stops safely, writes a result
 * file, and quits the app. With no request file present it does nothing at
 * all beyond the one existence check below — no timers, no further file
 * access, ever, for the rest of the session.
 *
 * This file, its pure core (`src/testlab/runnerCore.ts`) and their tests are
 * listed in `client/private-only.json` and must be removable from customer
 * builds by deleting exactly those paths (plus the small general hooks
 * documented inline where they're added, which stay behind and are inert
 * without this file).
 *
 * Thin by design: this file sequences real side effects (read/rename the
 * request file, launch by label, poll admission/packets, call host access
 * for scripts/config, terminate the game process tree, write the result
 * file, quit) and hands every decision — validation, phase transitions,
 * stop reasons, the result shape — to `runnerCore.ts`, which is why that
 * module carries the state-machine tests.
 *
 * Credentials never appear here, anywhere: the account is identified only
 * by its dashboard label, and the actual lookup + launch happens entirely
 * inside `ctx.hostAccess.launchSavedAccountByLabel` (DevServer, server-side)
 * — this file only ever sees a label string in, and an ok/error/pid result
 * out.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import type { PluginContext, ClientConnection } from './api.js';
import { RuntimeScheduler } from './api.js';
import { readBuildInfoFile } from '../src/util/buildInfo.js';
import { loggerDirectory } from '../src/util/Logger.js';
import { terminateGameProcessTree, type TerminatePidSpec } from '../src/dashboard/server/GameLauncher.js';
import { getLatestCredentialLaunchByAccountLabel } from '../src/dashboard/process/credentialLaunchRegistry.js';
import { ROTMG_EXALT_IMAGE, ROTMG_EXALT_CHILD_IMAGE } from '../src/dashboard/process/rotmgWindowsClientTune.js';
import { PROXY_EXIT_QUIT_APP } from '../electron/proxyExitCodes.cjs';
import {
  TESTLAB_PRIVATE_ONLY,
  runnerCoreMarker,
  parseRunRequest,
  extractRunIdForConsumedName,
  consumedRequestFileName,
  resultFileName,
  throwawayConfigId,
  buildThrowawayConfigSnapshot,
  buildRejectedResult,
  RunnerStateMachine,
  ReconnectClassifier,
  SCRIPT_START_SETTLE_MS,
  NATIVE_BRIDGE_TIMEOUT_MS,
  NO_MOVEMENT_TIMEOUT_MS,
  NO_MOVEMENT_MIN_TILE_DELTA,
  type RunRequest,
  type RunResultFile,
  type PluginConfigSnapshot,
  type WorldPosition,
} from '../src/testlab/runnerCore.js';

export { TESTLAB_PRIVATE_ONLY };

// Same ROOT resolution as src/index.ts / testlab-recorder.ts — used only to
// find data/build-info.json for the result file's build stamp.
const ROOT = process.env.REALM_ENGINE_ROOT
  ? resolve(process.env.REALM_ENGINE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUEST_FILE_NAME = 'run-request.json';
const TESTLAB_DIR_NAME = 'testlab';
const RECORDER_BUS_SLOT_KEY = '__realmengine_testlabRecorderBus_v1';

const POLL_MS = 2000;
const NEVER_IN_WORLD_TIMEOUT_MS = 3 * 60_000;
const NEXUS_WAIT_MS = 5000;

export function register(ctx: PluginContext) {
  ctx.name = 'Test Lab Runner';
  ctx.category = 'utility';
  // The one-shot request-file check below runs unconditionally, right here
  // at registration, regardless of this flag — it is what makes "enabled"
  // irrelevant. Defaulting to enabled just avoids showing a feature that
  // looks like it needs to be turned on to work.
  ctx.enabled = true;

  ctx.setData('testlabPrivateOnlyMarkers', [TESTLAB_PRIVATE_ONLY, runnerCoreMarker()]);

  const testlabDir = join(loggerDirectory(), TESTLAB_DIR_NAME);
  const requestFilePath = join(testlabDir, REQUEST_FILE_NAME);
  const proxyLogFilePath = join(loggerDirectory(), 'realm-engine-proxy.log');

  const scheduler = new RuntimeScheduler();
  let machine: RunnerStateMachine | null = null;
  let reconnectClassifier: ReconnectClassifier | null = null;
  let currentClient: ClientConnection | null = null;
  let seenFirstConnect = false;
  let stopPolling: (() => void) | null = null;
  let finishing = false;
  let originalConfigId: string | null = null;
  // Only true once applyThrowawayPluginConfig() actually switched the live
  // config away from originalConfigId — every early-exit path (account not
  // found, launch failed, never reached the world) leaves this false, so
  // restorePluginConfig() correctly leaves live plugin state alone instead
  // of "restoring" a switch that never happened.
  let throwawayConfigApplied = false;

  function log(message: string): void {
    ctx.log(`[TestLabRun] ${message}`);
  }

  function buildInfoStamp(): { version: string | null; commit: string | null } {
    const info = readBuildInfoFile(ROOT);
    return {
      version: process.env.REALM_ENGINE_VERSION || null,
      commit: info ? (info.dirty ? `${info.commit}-dirty` : info.commit) : null,
    };
  }

  function recordingPath(): string | null {
    const slot = (globalThis as unknown as Record<string, unknown>)[RECORDER_BUS_SLOT_KEY] as
      | { enabled?: boolean; filePath?: string | null }
      | undefined;
    return slot?.enabled ? slot.filePath ?? null : null;
  }

  function writeResultFile(result: RunResultFile): void {
    try {
      if (!existsSync(testlabDir)) mkdirSync(testlabDir, { recursive: true });
      writeFileSync(join(testlabDir, resultFileName(result.runId)), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      log(`failed to write result file: ${(err as Error).message}`);
    }
  }

  // ── Inbound wiring (cheap; registered once, no-ops while machine is null) ──

  ctx.on('clientConnected', (client) => {
    const isReconnect = seenFirstConnect;
    seenFirstConnect = true;
    currentClient = client;
    if (isReconnect && machine && reconnectClassifier) {
      const abnormal = reconnectClassifier.classify(Date.now());
      if (abnormal && machine.onReconnect(Date.now())) {
        void finishRun();
      }
    }
  });

  ctx.on('clientDisconnected', () => {
    currentClient = null;
  });

  ctx.hookPacket('DEATH', () => {
    if (machine?.onDeath()) void finishRun();
  });

  // A farming session hops maps constantly (portal, Auto Nexus, a dungeon
  // teleport) — the server always answers with RECONNECT first. Recording
  // every one here is what lets ReconnectClassifier tell that apart from an
  // abnormal drop (see runnerCore.ts's ReconnectClassifier doc comment).
  ctx.hookPacket('RECONNECT', () => {
    reconnectClassifier?.onReconnectPacket(Date.now());
  });

  // ── The one-shot startup check. See this file's header. ──

  checkForRequestOnce();

  function checkForRequestOnce(): void {
    try {
      if (!existsSync(requestFilePath)) return; // inert: nothing else in this file runs this session.
      const raw = readFileSync(requestFilePath, 'utf8');
      const extractedRunId = extractRunIdForConsumedName(raw);
      const consumedPath = join(testlabDir, consumedRequestFileName(extractedRunId));
      try {
        renameSync(requestFilePath, consumedPath);
      } catch (err) {
        // Renaming is what stops a stale/invalid file from ever being
        // reconsidered — if it fails, refuse to act on the request at all
        // rather than risk running twice from the same file.
        log(`could not rename request file, refusing to act on it: ${(err as Error).message}`);
        return;
      }
      const parsed = parseRunRequest(raw, Date.now());
      if (!parsed.ok) {
        log(`request rejected: ${parsed.reason} (${parsed.detail})`);
        writeResultFile(
          buildRejectedResult(extractedRunId, Date.now(), 'error', `${parsed.reason}: ${parsed.detail}`, {
            build: buildInfoStamp(),
            logFile: proxyLogFilePath,
          }),
        );
        return;
      }
      log(`accepted runId=${parsed.request.runId} accountLabel="${parsed.request.accountLabel}" minutes=${parsed.request.minutes}`);
      void runRequest(parsed.request);
    } catch (err) {
      log(`startup check failed: ${(err as Error).message}`);
    }
  }

  // ── The run itself ──

  async function runRequest(request: RunRequest): Promise<void> {
    machine = new RunnerStateMachine();
    reconnectClassifier = new ReconnectClassifier();
    machine.begin(Date.now(), request);
    originalConfigId = ctx.hostAccess?.getActivePluginConfigId() ?? null;

    try {
      log(`launching accountLabel="${request.accountLabel}" runId=${request.runId}`);
      const launch = await (ctx.hostAccess?.launchSavedAccountByLabel(request.accountLabel, request.serverName) ??
        Promise.resolve({ ok: false as const, error: 'launch-failed' as const, matchCount: undefined, totalAccounts: undefined }));
      machine.onLaunchResult(
        launch.ok,
        launch.error ?? null,
        launch.ok ? launch.pid ?? null : null,
        !launch.ok && (launch.matchCount != null || launch.totalAccounts != null)
          ? { matchCount: launch.matchCount ?? 0, totalAccounts: launch.totalAccounts ?? 0 }
          : undefined,
      );
      if (machine.getPhase() !== 'waiting-world') {
        await finishRun();
        return;
      }

      log(`waiting for world (timeout ${Math.round(NEVER_IN_WORLD_TIMEOUT_MS / 1000)}s)`);
      const enteredWorld = await waitForWorld();
      if (!enteredWorld) {
        await finishRun();
        return;
      }

      log('in world, waiting for native bridge');
      const bridgeWaitStartedAtMs = Date.now();
      const bridgeReady = await waitForNativeBridge();
      if (!bridgeReady) {
        await finishRun();
        return;
      }
      log(`native bridge ready after ${Math.max(0, Math.round((Date.now() - bridgeWaitStartedAtMs) / 1000))}s`);

      applyThrowawayPluginConfig(request);

      if (request.scriptId) {
        const startResult = await (ctx.hostAccess?.startScript(request.scriptId) ??
          Promise.resolve({ ok: false, error: 'host access unavailable' }));
        if (!startResult.ok) {
          // ScriptHost.start() reports a missing package as "Script package
          // not found: <id>" — normalize that one case to the documented
          // detail text; any other start failure (already running, invalid
          // manifest, ...) keeps its own message rather than being
          // mislabeled as "not installed".
          const notInstalled = /^Script package not found:/.test(startResult.error ?? '');
          machine.requestStop('error', notInstalled ? 'script not installed' : startResult.error ?? 'script not installed');
          await finishRun();
          return;
        }
        log(`started script "${request.scriptId}"`);
      }

      machine.enterRunning();
      if (request.scriptId) {
        machine.armMovementWatchdog(Date.now(), currentWorldPosition());
      }
      log(`running runId=${request.runId} for ${request.minutes} minute(s)`);
      startPolling();
    } catch (err) {
      machine.requestStop('error', `unexpected exception: ${(err as Error).message}`);
      await finishRun();
    }
  }

  /** Best-effort current player position + map, for the movement watchdog and
   *  for `ReconnectClassifier`'s "did the previous connection ever load"
   *  question. `null` whenever it can't be read (no client, not connected). */
  function currentWorldPosition(): WorldPosition | null {
    const client = currentClient;
    if (!client || !client.connected) return null;
    const pos = ctx.getEffectivePlayerPos(client);
    if (!pos) return null;
    const mapKey = `${client.state?.gameId ?? -2}|${String(client.playerData?.mapName ?? '').trim().toLowerCase()}`;
    return { x: pos.x, y: pos.y, mapKey };
  }

  function waitForWorld(): Promise<boolean> {
    return new Promise((resolveWait) => {
      const check = () => {
        if (!machine) {
          stop();
          resolveWait(false);
          return;
        }
        if (currentClient?.admission?.phase === 'loaded') {
          reconnectClassifier?.onAdmissionLoaded();
          machine.enterWaitingBridge(Date.now());
          stop();
          resolveWait(true);
          return;
        }
        if (machine.checkNeverInWorld(Date.now(), NEVER_IN_WORLD_TIMEOUT_MS)) {
          stop();
          resolveWait(false);
        }
      };
      const stop = scheduler.scheduleRepeating(POLL_MS, check);
      check();
    });
  }

  /**
   * Polls until BOTH "admission loaded" (already true on entry) and the
   * native DLL bridge report ready, continuously, for `SCRIPT_START_SETTLE_MS`
   * — see runnerCore.ts's `RunnerStateMachine.checkBridgeReady` doc comment
   * for why: the first live unattended run started the script the instant it
   * was in world, ~15s before the DLL bridge connected, and the script's
   * one-shot DLL setup + navigation goal were silently dropped.
   */
  function waitForNativeBridge(): Promise<boolean> {
    return new Promise((resolveWait) => {
      const check = () => {
        if (!machine) {
          stop();
          resolveWait(false);
          return;
        }
        if (currentClient?.admission?.phase === 'loaded') reconnectClassifier?.onAdmissionLoaded();
        const bridgeConnected = ctx.hostAccess?.isNativeBridgeReady() ?? false;
        const outcome = machine.checkBridgeReady(Date.now(), bridgeConnected, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS);
        if (outcome === 'ready') {
          stop();
          resolveWait(true);
          return;
        }
        if (outcome === 'timeout') {
          stop();
          resolveWait(false);
        }
      };
      const stop = scheduler.scheduleRepeating(POLL_MS, check);
      check();
    });
  }

  /** Best-effort restart of a stalled script: stop then start again. Failures
   *  are logged, not fatal here — if the restart itself didn't take, the
   *  movement watchdog's second window ends the run with reason
   *  `no-movement` rather than wasting the rest of it standing still. */
  async function restartScript(scriptId: string): Promise<void> {
    try {
      ctx.hostAccess?.stopScript(scriptId);
    } catch {
      /* best effort */
    }
    try {
      const result = await (ctx.hostAccess?.startScript(scriptId) ??
        Promise.resolve({ ok: false, error: 'host access unavailable' }));
      if (!result.ok) log(`restart of script "${scriptId}" failed: ${result.error ?? 'unknown error'}`);
    } catch (err) {
      log(`restart of script "${scriptId}" threw: ${(err as Error).message}`);
    }
  }

  function applyThrowawayPluginConfig(request: RunRequest): void {
    const access = ctx.hostAccess;
    if (!access) {
      log('no plugin-config host access available; per-run overrides skipped');
      return;
    }
    try {
      const base = access.buildPluginConfigSnapshot('testlab run') as PluginConfigSnapshot;
      const snapshot = buildThrowawayConfigSnapshot(base, request.runId, request.plugins, Date.now());
      const result = access.writeAndLoadPluginConfig(snapshot.id, snapshot);
      if (result.ok) {
        throwawayConfigApplied = true;
      } else {
        log(`failed to apply per-run plugin config: ${result.message}`);
      }
    } catch (err) {
      log(`per-run plugin config error: ${(err as Error).message}`);
    }
  }

  function restorePluginConfig(request: RunRequest | null): void {
    if (!throwawayConfigApplied) return; // the live config was never switched -- nothing to restore.
    const access = ctx.hostAccess;
    if (!access) return;
    try {
      if (originalConfigId) access.loadPluginConfigById(originalConfigId);
    } catch (err) {
      log(`failed to restore plugin config: ${(err as Error).message}`);
    }
    try {
      if (request) access.deletePluginConfigFile(throwawayConfigId(request.runId));
    } catch {
      /* best effort */
    }
  }

  function startPolling(): void {
    stopPolling?.();
    stopPolling = scheduler.scheduleRepeating(POLL_MS, () => {
      if (!machine) return;
      if (currentClient?.admission?.phase === 'loaded') reconnectClassifier?.onAdmissionLoaded();
      if (machine.checkMinutesElapsed(Date.now())) {
        void finishRun();
        return;
      }
      const scriptId = machine.getRequest()?.scriptId;
      if (scriptId) {
        const outcome = machine.checkMovement(Date.now(), currentWorldPosition(), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA);
        if (outcome === 'restart') {
          log('no movement for 90 s — restarting script');
          void restartScript(scriptId);
        } else if (outcome === 'stopped') {
          void finishRun();
        }
      }
    });
    // Cover the (rare) case where minutes is already effectively 0 by the
    // time polling starts.
    if (machine?.checkMinutesElapsed(Date.now())) void finishRun();
  }

  function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Every PID this run is responsible for verifying/terminating: the
   * launcher PID the launch result reported, plus — when it has since
   * resolved — the Unity child PID `credentialLaunchRegistry` tracks
   * separately (it may not be a descendant of the launcher PID at all if
   * the Steam relaunch path took over; see GameLauncher.ensureSteamAppIdFile).
   */
  function pidsToTerminate(request: RunRequest | null): TerminatePidSpec[] {
    const specs: TerminatePidSpec[] = [];
    const launcherPid = machine?.getGamePid() ?? null;
    if (launcherPid != null) specs.push({ pid: launcherPid, expectedImageName: ROTMG_EXALT_IMAGE });
    if (request) {
      const rec = getLatestCredentialLaunchByAccountLabel(request.accountLabel);
      if (rec?.pidUnity != null && rec.pidUnity !== launcherPid) {
        specs.push({ pid: rec.pidUnity, expectedImageName: ROTMG_EXALT_CHILD_IMAGE });
      }
    }
    return specs;
  }

  async function finishRun(): Promise<void> {
    if (finishing || !machine) return;
    finishing = true;
    stopPolling?.();
    stopPolling = null;

    const request = machine.getRequest();
    // Vacuously true when there is nothing this run is responsible for
    // (e.g. the account was never found, so nothing was ever launched) —
    // only a PID we tracked and failed to confirm dead makes this false.
    let gameTerminated = true;
    try {
      if (request?.scriptId) {
        try {
          ctx.hostAccess?.stopScript(request.scriptId);
        } catch {
          /* best effort — we still want the game terminated and a result written */
        }
      }

      if (machine.hasEnteredWorld() && currentClient?.connected) {
        try {
          const packet = ctx.createPacket('ESCAPE');
          currentClient.sendToServer(packet);
        } catch {
          /* void API — never let a send failure block termination */
        }
        await delay(NEXUS_WAIT_MS);
      }

      const specs = pidsToTerminate(request);
      if (specs.length > 0) {
        const term = await terminateGameProcessTree(specs);
        gameTerminated = term.ok;
        if (!term.ok) log(`did not fully terminate the game process tree: ${term.error}`);
      }
    } finally {
      const result = machine.finish(Date.now(), {
        build: buildInfoStamp(),
        logFile: proxyLogFilePath,
        recording: recordingPath(),
        gameTerminated,
      });
      writeResultFile(result);
      restorePluginConfig(request);
      log(`done reason=${result.reason} detail="${result.detail}"`);
      machine = null;
      reconnectClassifier = null;
      quitApp();
    }
  }

  function quitApp(): void {
    try {
      if (!ctx.hostAccess) {
        log('no host access available to quit the app; exiting this process only.');
        process.exit(PROXY_EXIT_QUIT_APP);
        return;
      }
      // Reuses the proxy's own graceful shutdown (src/index.ts's shutdown()):
      // stops the dashboard/script host/proxy, uninstalls the game hook,
      // then exits with PROXY_EXIT_QUIT_APP — a dedicated code, so a normal
      // clean exit (0) elsewhere is untouched. Electron's main process quits
      // the rest of the app only on that dedicated code (electron/main.cjs).
      ctx.hostAccess.requestAppShutdown(PROXY_EXIT_QUIT_APP);
    } catch (err) {
      log(`quit failed, forcing exit: ${(err as Error).message}`);
      process.exit(PROXY_EXIT_QUIT_APP);
    }
  }
}
