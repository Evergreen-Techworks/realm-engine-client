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
 * This file, its pure core (`src/testlab/runnerCore.ts`), the renderer
 * helper it talks to (`src/dashboard/public/js/testlab-runner.js`) and their
 * tests are listed in `client/private-only.json` and must be removable from
 * customer builds by deleting exactly those paths (plus the small general
 * hooks documented inline where they're added, which stay behind and are
 * inert without this file).
 *
 * Thin by design: this file sequences real side effects (read/rename the
 * request file, broadcast a launch request, poll admission/packets, call
 * host access for scripts/config, terminate the game process, write the
 * result file, quit) and hands every decision — validation, phase
 * transitions, stop reasons, the result shape — to `runnerCore.ts`, which is
 * why that module carries the state-machine tests.
 *
 * Credentials never appear here: the account is identified only by its
 * dashboard label, and the actual launch happens in the renderer
 * (`src/dashboard/public/js/testlab-runner.js`), through the exact same
 * function its own Launch button uses. This file only ever sees a label
 * string and an ok/error result.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { PluginContext, ClientConnection } from './api.js';
import { RuntimeScheduler } from './api.js';
import { readBuildInfoFile } from '../src/util/buildInfo.js';
import { loggerDirectory } from '../src/util/Logger.js';
import { terminateGameProcessByPid } from '../src/dashboard/server/GameLauncher.js';
import { getLatestCredentialLaunchByAccountLabel } from '../src/dashboard/process/credentialLaunchRegistry.js';
import {
  TESTLAB_PRIVATE_ONLY,
  runnerCoreMarker,
  parseRunRequest,
  extractRunIdForConsumedName,
  consumedRequestFileName,
  resultFileName,
  throwawayConfigId,
  buildLaunchBroadcast,
  buildThrowawayConfigSnapshot,
  buildRejectedResult,
  RunnerStateMachine,
  type RunRequest,
  type RunResultFile,
  type PluginConfigSnapshot,
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
const LAUNCH_TIMEOUT_MS = 90_000;
const LAUNCH_RETRY_MS = 4000;
const NEXUS_WAIT_MS = 5000;

interface LaunchOutcome {
  ok: boolean;
  error: string | null;
}

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
  let currentClient: ClientConnection | null = null;
  let seenFirstConnect = false;
  let stopPolling: (() => void) | null = null;
  let finishing = false;
  let originalConfigId: string | null = null;
  let pendingLaunchRunId: string | null = null;
  let pendingLaunchResolve: ((outcome: LaunchOutcome) => void) | null = null;

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
    if (isReconnect && machine && machine.onReconnect()) {
      void finishRun();
    }
  });

  ctx.on('clientDisconnected', () => {
    currentClient = null;
  });

  ctx.hookPacket('DEATH', () => {
    if (machine?.onDeath()) void finishRun();
  });

  ctx.onClientMessage('testlabLaunchResult', (msg: unknown) => {
    if (!pendingLaunchResolve) return;
    const m = msg as { runId?: unknown; ok?: unknown; error?: unknown };
    if (String(m?.runId ?? '') !== pendingLaunchRunId) return; // a stale reply from a previous run
    const resolve = pendingLaunchResolve;
    pendingLaunchResolve = null;
    resolve({ ok: m?.ok === true, error: typeof m?.error === 'string' ? m.error : null });
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
    machine.begin(Date.now(), request);
    originalConfigId = ctx.hostAccess?.getActivePluginConfigId() ?? null;

    try {
      log(`launching accountLabel="${request.accountLabel}" runId=${request.runId}`);
      const launch = await requestLaunch(request);
      const gamePid = launch.ok ? getGamePidForLabel(request.accountLabel) : null;
      machine.onLaunchResult(launch.ok, launch.error, gamePid);
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

      applyThrowawayPluginConfig(request);

      if (request.scriptId) {
        const startResult = await (ctx.hostAccess?.startScript(request.scriptId) ??
          Promise.resolve({ ok: false, error: 'host access unavailable' }));
        if (!startResult.ok) {
          machine.requestStop('error', startResult.error ?? 'script not installed');
          await finishRun();
          return;
        }
        log(`started script "${request.scriptId}"`);
      }

      machine.enterRunning(Date.now());
      log(`running runId=${request.runId} for ${request.minutes} minute(s)`);
      startPolling();
    } catch (err) {
      machine.requestStop('error', `unexpected exception: ${(err as Error).message}`);
      await finishRun();
    }
  }

  function getGamePidForLabel(accountLabel: string): number | null {
    const rec = getLatestCredentialLaunchByAccountLabel(accountLabel);
    return rec ? rec.pidLauncher : null;
  }

  function requestLaunch(request: RunRequest): Promise<LaunchOutcome> {
    return new Promise((resolvePromise) => {
      pendingLaunchRunId = request.runId;
      pendingLaunchResolve = resolvePromise;
      const broadcast = buildLaunchBroadcast(request);
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;

      const send = () => {
        try {
          ctx.broadcastData(broadcast.type, {
            runId: broadcast.runId,
            accountLabel: broadcast.accountLabel,
            serverName: broadcast.serverName,
          });
        } catch {
          /* best effort — the retry loop below will try again */
        }
      };

      send();
      const stopRetrying = scheduler.scheduleRepeating(LAUNCH_RETRY_MS, () => {
        if (pendingLaunchResolve !== resolvePromise) {
          stopRetrying();
          return;
        }
        if (Date.now() >= deadline) {
          stopRetrying();
          pendingLaunchResolve = null;
          resolvePromise({ ok: false, error: 'launch-failed' });
          return;
        }
        send();
      });
    });
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
      if (!result.ok) log(`failed to apply per-run plugin config: ${result.message}`);
    } catch (err) {
      log(`per-run plugin config error: ${(err as Error).message}`);
    }
  }

  function restorePluginConfig(request: RunRequest | null): void {
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
      if (machine.checkMinutesElapsed(Date.now())) {
        void finishRun();
      }
    });
    // Cover the (rare) case where minutes is already effectively 0 by the
    // time polling starts.
    if (machine?.checkMinutesElapsed(Date.now())) void finishRun();
  }

  function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function finishRun(): Promise<void> {
    if (finishing || !machine) return;
    finishing = true;
    stopPolling?.();
    stopPolling = null;

    const request = machine.getRequest();
    let gameTerminated = false;
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

      const pid = machine.getGamePid();
      if (pid != null) {
        const term = terminateGameProcessByPid(pid);
        gameTerminated = term.ok;
        if (!term.ok) log(`did not terminate game pid=${pid}: ${term.error}`);
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
      quitApp();
    }
  }

  function quitApp(): void {
    try {
      // Reuses the proxy's own graceful shutdown (src/index.ts's SIGTERM
      // handler: stops the dashboard/script host/proxy, uninstalls the game
      // hook, then exits 0) rather than duplicating any of that here.
      // Electron's main process quits the rest of the app on that clean
      // exit — see electron/main.cjs's proxy exit handler.
      process.emit('SIGTERM');
    } catch (err) {
      log(`quit signal failed, forcing exit: ${(err as Error).message}`);
      process.exit(0);
    }
  }
}
