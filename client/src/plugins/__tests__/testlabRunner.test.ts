import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable holders the mock factories below close over (vi.mock factories are
// hoisted above normal imports, so they can't reference plain outer-scope
// `let`s declared after them — vi.hoisted() is the escape hatch).
const state = vi.hoisted(() => ({ testDir: '' }));
const fakes = vi.hoisted(() => ({
  terminateGameProcessTree: vi.fn(() => ({ ok: true, terminatedPids: [], survivingPids: [] })),
  getLatestCredentialLaunchByAccountLabel: vi.fn(() => undefined as { pidLauncher: number; pidUnity: number | null } | undefined),
}));

vi.mock('../../util/Logger.js', () => ({
  loggerDirectory: () => state.testDir,
}));
vi.mock('../../util/buildInfo.js', () => ({
  readBuildInfoFile: () => null,
}));
vi.mock('../../dashboard/server/GameLauncher.js', () => ({
  terminateGameProcessTree: (...args: unknown[]) => fakes.terminateGameProcessTree(...(args as [unknown])),
}));
vi.mock('../../dashboard/process/credentialLaunchRegistry.js', () => ({
  getLatestCredentialLaunchByAccountLabel: (...args: unknown[]) =>
    fakes.getLatestCredentialLaunchByAccountLabel(...(args as [string])),
}));
vi.mock('../../dashboard/process/rotmgWindowsClientTune.js', () => ({
  ROTMG_EXALT_IMAGE: 'RotMG Exalt.exe',
  ROTMG_EXALT_CHILD_IMAGE: 'RotMGExalt.exe',
}));
vi.mock('../../../electron/proxyExitCodes.cjs', () => ({
  PROXY_EXIT_QUIT_APP: 64,
}));

const { register } = await import('../../../plugins/testlab-runner.js');
import type { PluginContext } from '../../../plugins/api.js';
import { NATIVE_BRIDGE_TIMEOUT_MS, NO_MOVEMENT_TIMEOUT_MS } from '../../testlab/runnerCore.js';

const REQUEST_FILE_NAME = 'run-request.json';

async function flushAsync(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function writeRequest(testlabDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(testlabDir, { recursive: true });
  writeFileSync(
    join(testlabDir, REQUEST_FILE_NAME),
    JSON.stringify({
      v: 1,
      runId: 'run-1',
      createdUtc: new Date().toISOString(),
      accountLabel: 'lab-1',
      minutes: 30,
      ...overrides,
    }),
  );
}

function readResult(testlabDir: string, runId: string): any {
  return JSON.parse(readFileSync(join(testlabDir, `run-result.${runId}.json`), 'utf8'));
}

interface HostAccessFake {
  getActivePluginConfigId: ReturnType<typeof vi.fn>;
  buildPluginConfigSnapshot: ReturnType<typeof vi.fn>;
  writeAndLoadPluginConfig: ReturnType<typeof vi.fn>;
  loadPluginConfigById: ReturnType<typeof vi.fn>;
  deletePluginConfigFile: ReturnType<typeof vi.fn>;
  startScript: ReturnType<typeof vi.fn>;
  stopScript: ReturnType<typeof vi.fn>;
  launchSavedAccountByLabel: ReturnType<typeof vi.fn>;
  isNativeBridgeReady: ReturnType<typeof vi.fn>;
  requestAppShutdown: ReturnType<typeof vi.fn>;
}

function makeHostAccess(overrides: Partial<HostAccessFake> = {}): HostAccessFake {
  return {
    getActivePluginConfigId: vi.fn(() => 'default'),
    buildPluginConfigSnapshot: vi.fn((name: string) => ({ id: 'default', name, createdAt: 1, updatedAt: 1, plugins: [] })),
    writeAndLoadPluginConfig: vi.fn((id: string) => ({ ok: true, message: 'ok', id })),
    loadPluginConfigById: vi.fn(() => ({ ok: true, message: 'ok' })),
    deletePluginConfigFile: vi.fn(),
    startScript: vi.fn(async () => ({ ok: true })),
    stopScript: vi.fn(() => ({ ok: true })),
    launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 4321 })),
    // Bridge already connected by default — most tests aren't exercising the
    // wait-for-bridge path itself and shouldn't need to know about it.
    isNativeBridgeReady: vi.fn(() => true),
    requestAppShutdown: vi.fn(),
    ...overrides,
  };
}

type FakeClient = {
  admission: { phase: string };
  connected: boolean;
  sendToServer: ReturnType<typeof vi.fn>;
  playerData: { pos: { x: number; y: number }; mapName: string };
  state: { gameId: number };
};

function makeCtx(hostAccess: HostAccessFake | null) {
  const logs: string[] = [];
  const packetHooks = new Map<string, (client: unknown, packet: unknown) => void>();
  const clientConnectedCbs: Array<(client: unknown) => void> = [];
  const clientDisconnectedCbs: Array<() => void> = [];
  const createdPackets: string[] = [];
  const sentPackets: unknown[] = [];

  const ctx = {
    name: '',
    category: 'utility',
    enabled: true,
    hostAccess,
    setData: vi.fn(),
    log: vi.fn((m: string) => logs.push(m)),
    dashboardLog: vi.fn(),
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      if (event === 'clientConnected') clientConnectedCbs.push(cb);
      if (event === 'clientDisconnected') clientDisconnectedCbs.push(cb);
    }),
    hookPacket: vi.fn((name: string, cb: (client: unknown, packet: unknown) => void) => packetHooks.set(name, cb)),
    createPacket: vi.fn((name: string) => {
      createdPackets.push(name);
      return { name };
    }),
    getEffectivePlayerPos: vi.fn((client: FakeClient) => client.playerData?.pos ?? null),
  } as unknown as PluginContext;

  function connectClient(admissionPhase: string, pos: { x: number; y: number } = { x: 0, y: 0 }, mapName = 'realm', gameId = 1): FakeClient {
    const client: FakeClient = {
      admission: { phase: admissionPhase },
      connected: true,
      sendToServer: vi.fn((p: unknown) => sentPackets.push(p)),
      playerData: { pos: { ...pos }, mapName },
      state: { gameId },
    };
    for (const cb of clientConnectedCbs) cb(client);
    return client;
  }

  return {
    ctx,
    logs,
    packetHooks,
    clientConnectedCbs,
    clientDisconnectedCbs,
    createdPackets,
    sentPackets,
    connectClient,
  };
}

/** How long the native-bridge settle wait can take in the worst case, in
 *  fake-timer ms: enough real elapsed time past SCRIPT_START_SETTLE_MS for
 *  at least two more POLL_MS ticks to observe 'ready' (see runnerCore.ts's
 *  checkBridgeReady: the FIRST tick that observes the bridge connected only
 *  arms the settle clock, it never itself reports ready). */
const BRIDGE_SETTLE_ADVANCE_MS = 8000;

/** Connects a client already in world with the bridge already reporting
 *  ready (the default `isNativeBridgeReady` mock), and advances fake timers
 *  far enough past the settle window for the run to actually start the
 *  script / enter running. */
async function connectAndSettle(
  connectClient: ReturnType<typeof makeCtx>['connectClient'],
  pos?: { x: number; y: number },
  mapName?: string,
): Promise<FakeClient> {
  const client = connectClient('loaded', pos, mapName);
  await flushAsync();
  await vi.advanceTimersByTimeAsync(BRIDGE_SETTLE_ADVANCE_MS);
  await flushAsync();
  return client;
}

describe('Test Lab Runner plugin', () => {
  let testDir: string;
  let testlabDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'testlab-runner-'));
    state.testDir = testDir;
    testlabDir = join(testDir, 'testlab');
    fakes.terminateGameProcessTree.mockReset().mockReturnValue({ ok: true, terminatedPids: [], survivingPids: [] });
    fakes.getLatestCredentialLaunchByAccountLabel.mockReset().mockReturnValue(undefined);
    // The plugin waits a real 5s before terminating the game process after a
    // nexus attempt; fake timers let tests that reach that path advance
    // virtual time instead of actually waiting.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Flushes the post-stop nexus-wait (a real 5s delay) plus any downstream microtasks. */
  async function advancePastNexusWait(): Promise<void> {
    await vi.advanceTimersByTimeAsync(6000);
  }

  it('does nothing at all when no request file exists (inert)', () => {
    const hostAccess = makeHostAccess();
    const { ctx, logs } = makeCtx(hostAccess);
    register(ctx);
    expect(hostAccess.launchSavedAccountByLabel).not.toHaveBeenCalled();
    expect(existsSync(testlabDir)).toBe(false);
    expect(logs.some((l) => l.includes('[TestLabRun]'))).toBe(false);
  });

  it('renames the request file off its live name immediately, even before validating it', () => {
    // Syntactically valid JSON (so runId is recoverable) but fails full
    // validation (blank accountLabel) — the rename must happen regardless.
    writeRequest(testlabDir, { runId: 'garbage-run', accountLabel: '' });
    const { ctx } = makeCtx(makeHostAccess());
    register(ctx);
    expect(existsSync(join(testlabDir, REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(testlabDir, 'run-request.garbage-run.consumed.json'))).toBe(true);
  });

  it('renames the request file off its live name even for unparseable JSON, under an "invalid" fallback name', () => {
    mkdirSync(testlabDir, { recursive: true });
    writeFileSync(join(testlabDir, REQUEST_FILE_NAME), '{"v":1,"runId":"whatever", this is not valid json');
    const { ctx } = makeCtx(makeHostAccess());
    register(ctx);
    expect(existsSync(join(testlabDir, REQUEST_FILE_NAME))).toBe(false);
    expect(existsSync(join(testlabDir, 'run-request.invalid.consumed.json'))).toBe(true);
  });

  it('launches by label only — no credential-shaped arguments ever reach the plugin or leave it', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 4321 })) });
    writeRequest(testlabDir, { runId: 'run-cred', accountLabel: 'lab-1', serverName: 'USEast' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    expect(hostAccess.launchSavedAccountByLabel).toHaveBeenCalledTimes(1);
    const args = hostAccess.launchSavedAccountByLabel.mock.calls[0];
    expect(args).toEqual(['lab-1', 'USEast']);
    // Nothing resembling a credential field is anywhere in the call.
    const flat = JSON.stringify(args).toLowerCase();
    expect(flat).not.toMatch(/password|email|secret|guid/);
  });

  it('account-not-found: writes a result with that reason and never touches the game process', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: false, error: 'account-not-found' })) });
    writeRequest(testlabDir, { runId: 'run-anf', accountLabel: 'nobody' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-anf');
    expect(result.reason).toBe('account-not-found');
    expect(result.gamePid).toBeNull();
    expect(result.gameTerminated).toBe(true); // nothing was ever launched -- vacuously nothing survives.
    expect(fakes.terminateGameProcessTree).not.toHaveBeenCalled();
    expect(hostAccess.requestAppShutdown).toHaveBeenCalledWith(64);
  });

  it('launch-failed (not account-not-found) still ends the run cleanly', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: false, error: 'launch-failed' })) });
    writeRequest(testlabDir, { runId: 'run-lf', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-lf');
    expect(result.reason).toBe('launch-failed');
  });

  it('default.json is never written: the throwaway config id is always used, never "default"', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 999 })) });
    writeRequest(testlabDir, {
      runId: 'run-cfg',
      accountLabel: 'lab-1',
      scriptId: 'farmer',
      plugins: { 'auto-dodge': { enabled: true } },
    });
    const { ctx, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient); // world already loaded by the time the launch resolves, then bridge settles

    expect(hostAccess.writeAndLoadPluginConfig).toHaveBeenCalledTimes(1);
    const [writtenId] = hostAccess.writeAndLoadPluginConfig.mock.calls[0];
    expect(writtenId).toBe('testlab-run-run-cfg');
    expect(writtenId).not.toBe('default');

    // End the run and confirm restoration goes back to the ORIGINAL id
    // (whatever getActivePluginConfigId() returned, here 'default') via a
    // read-only load — never another write.
    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    expect(hostAccess.loadPluginConfigById).toHaveBeenCalledWith('default');
    expect(hostAccess.deletePluginConfigFile).toHaveBeenCalledWith('testlab-run-run-cfg');
    // The only file-writing config call for the whole run was the throwaway one.
    expect(hostAccess.writeAndLoadPluginConfig).toHaveBeenCalledTimes(1);
  });

  it('an early-exit run (account-not-found) never applies or restores any plugin config', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: false, error: 'account-not-found' })) });
    writeRequest(testlabDir, { runId: 'run-noconfig', accountLabel: 'nobody' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    expect(hostAccess.writeAndLoadPluginConfig).not.toHaveBeenCalled();
    expect(hostAccess.loadPluginConfigById).not.toHaveBeenCalled();
    expect(hostAccess.deletePluginConfigFile).not.toHaveBeenCalled();
  });

  it('a never-in-world run never applies or restores any plugin config either', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 1 })) });
    writeRequest(testlabDir, { runId: 'run-niw', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();
    // No clientConnected fired at all -> admission phase never reaches 'loaded'.
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000);
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-niw');
    expect(result.reason).toBe('never-in-world');
    expect(hostAccess.writeAndLoadPluginConfig).not.toHaveBeenCalled();
    expect(hostAccess.loadPluginConfigById).not.toHaveBeenCalled();
  });

  it('PID-scoped termination: refuses a PID whose image name is not the game, and reports gameTerminated:false', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 4321 })) });
    fakes.terminateGameProcessTree.mockReturnValue({
      ok: false,
      error: 'pid 4321 is "notepad.exe", not "RotMG Exalt.exe" — refusing to kill it',
      terminatedPids: [],
      survivingPids: [4321],
    });

    writeRequest(testlabDir, { runId: 'run-pid', accountLabel: 'lab-1' });
    const { ctx, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);

    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    expect(fakes.terminateGameProcessTree).toHaveBeenCalledTimes(1);
    const [specs] = fakes.terminateGameProcessTree.mock.calls[0];
    expect(specs).toEqual([{ pid: 4321, expectedImageName: 'RotMG Exalt.exe' }]);
    const result = readResult(testlabDir, 'run-pid');
    expect(result.gamePid).toBe(4321);
    expect(result.gameTerminated).toBe(false);
    expect(result.reason).toBe('death');
  });

  it('PID-scoped termination succeeds and reports gameTerminated:true for a matching image', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 555 })) });
    fakes.terminateGameProcessTree.mockReturnValue({ ok: true, terminatedPids: [555], survivingPids: [] });

    writeRequest(testlabDir, { runId: 'run-pid-ok', accountLabel: 'lab-1' });
    const { ctx, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);
    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-pid-ok');
    expect(result.gameTerminated).toBe(true);
  });

  it('also verifies a separately-tracked Unity child PID, when resolved and different from the launcher', async () => {
    const hostAccess = makeHostAccess({ launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 100 })) });
    fakes.getLatestCredentialLaunchByAccountLabel.mockReturnValue({ pidLauncher: 100, pidUnity: 200 });
    fakes.terminateGameProcessTree.mockReturnValue({ ok: true, terminatedPids: [100, 200], survivingPids: [] });

    writeRequest(testlabDir, { runId: 'run-child', accountLabel: 'lab-1' });
    const { ctx, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);
    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    const [specs] = fakes.terminateGameProcessTree.mock.calls[0];
    expect(specs).toEqual([
      { pid: 100, expectedImageName: 'RotMG Exalt.exe' },
      { pid: 200, expectedImageName: 'RotMGExalt.exe' },
    ]);
  });

  it('result file is written even on an exception path mid-run', async () => {
    const hostAccess = makeHostAccess({
      launchSavedAccountByLabel: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    writeRequest(testlabDir, { runId: 'run-boom', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-boom');
    expect(result.reason).toBe('error');
    expect(result.detail).toMatch(/boom/);
    expect(hostAccess.requestAppShutdown).toHaveBeenCalledWith(64);
  });

  it('a stale request (older than 10 minutes) is rejected and never launches anything', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, {
      runId: 'run-stale',
      createdUtc: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    expect(hostAccess.launchSavedAccountByLabel).not.toHaveBeenCalled();
    const result = readResult(testlabDir, 'run-stale');
    expect(result.reason).toBe('error');
    expect(result.detail).toMatch(/stale/);
  });

  it('script-not-installed ends the run with reason error and the documented detail text', async () => {
    const hostAccess = makeHostAccess({
      launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 1 })),
      startScript: vi.fn(async () => ({ ok: false, error: 'Script package not found: farmer' })),
    });
    writeRequest(testlabDir, { runId: 'run-noscript', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);
    // Already in world by the time script-start fails, so finishRun() attempts
    // the nexus escape + its 5s wait before terminating.
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-noscript');
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('script not installed');
  });

  it('a different script-start failure (not "not found") keeps its own detail text', async () => {
    const hostAccess = makeHostAccess({
      launchSavedAccountByLabel: vi.fn(async () => ({ ok: true, pid: 1 })),
      startScript: vi.fn(async () => ({ ok: false, error: 'Already running' })),
    });
    writeRequest(testlabDir, { runId: 'run-already', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-already');
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('Already running');
  });

  it('falls back to a bare process.exit with the quit code when host access is unavailable', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    writeRequest(testlabDir, { runId: 'run-noaccess', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(null);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-noaccess');
    expect(result.reason).toBe('launch-failed');
    expect(exitSpy).toHaveBeenCalledWith(64);
    exitSpy.mockRestore();
  });

  // ── Native bridge wait (first live unattended run: the DLL connected ~15s
  // after the script started, and the script's one-shot navigation goal was
  // silently dropped; see runnerCore.ts). ──

  it('does not start the script until the native bridge reports ready and settles, even though the world loaded immediately', async () => {
    let bridgeReady = false;
    const hostAccess = makeHostAccess({ isNativeBridgeReady: vi.fn(() => bridgeReady) });
    writeRequest(testlabDir, { runId: 'run-bridge-late', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient, logs } = makeCtx(hostAccess);
    register(ctx);
    connectClient('loaded');
    await flushAsync();

    expect(logs.some((l) => l.includes('[TestLabRun] in world, waiting for native bridge'))).toBe(true);

    // The bridge stays unconnected for a while (mirrors the measured ~15s) -- the script must NOT start.
    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();
    expect(hostAccess.startScript).not.toHaveBeenCalled();

    // The DLL finally connects.
    bridgeReady = true;
    await vi.advanceTimersByTimeAsync(BRIDGE_SETTLE_ADVANCE_MS);
    await flushAsync();

    expect(hostAccess.startScript).toHaveBeenCalledWith('farmer');
    expect(logs.some((l) => /\[TestLabRun\] native bridge ready after \d+s/.test(l))).toBe(true);
  });

  it('ends the run with reason native-not-connected if the bridge never connects within NATIVE_BRIDGE_TIMEOUT_MS of entering world', async () => {
    const hostAccess = makeHostAccess({ isNativeBridgeReady: vi.fn(() => false) });
    writeRequest(testlabDir, { runId: 'run-no-bridge', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    connectClient('loaded');
    await flushAsync();

    await vi.advanceTimersByTimeAsync(NATIVE_BRIDGE_TIMEOUT_MS + 1000);
    await advancePastNexusWait(); // already "in world" -- finishRun attempts the nexus escape first.

    const result = readResult(testlabDir, 'run-no-bridge');
    expect(result.reason).toBe('native-not-connected');
    expect(hostAccess.startScript).not.toHaveBeenCalled();
  });

  // ── Movement watchdog (a second, independent safety net for this failure class). ──

  it('restarts the script once after 90s with no movement, then ends the run with reason no-movement after another 90s still with none', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, { runId: 'run-stuck', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient, logs } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient, { x: 100, y: 100 });
    expect(hostAccess.startScript).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(NO_MOVEMENT_TIMEOUT_MS);
    await flushAsync();
    expect(logs.some((l) => l.includes('[TestLabRun] no movement for 90 s — restarting script'))).toBe(true);
    expect(hostAccess.stopScript).toHaveBeenCalledTimes(1);
    expect(hostAccess.startScript).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(NO_MOVEMENT_TIMEOUT_MS);
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-stuck');
    expect(result.reason).toBe('no-movement');
  });

  it('movement resets the watchdog -- no restart, no stop', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, { runId: 'run-moving', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    const client = await connectAndSettle(connectClient, { x: 0, y: 0 });

    // Move by more than a tile comfortably before the window would otherwise
    // elapse, then advance well PAST where the un-reset window would have
    // expired -- if the reset didn't work, this would already have restarted.
    await vi.advanceTimersByTimeAsync(50_000);
    client.playerData.pos = { x: 5, y: 5 };
    await vi.advanceTimersByTimeAsync(50_000);
    await flushAsync();

    expect(hostAccess.stopScript).not.toHaveBeenCalled();
    expect(hostAccess.startScript).toHaveBeenCalledTimes(1);
    expect(existsSync(join(testlabDir, 'run-result.run-moving.json'))).toBe(false);
  });

  it('a map change alone (identical x/y) counts as movement', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, { runId: 'run-maphop', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    const client = await connectAndSettle(connectClient, { x: 10, y: 10 }, 'realm');

    await vi.advanceTimersByTimeAsync(50_000);
    client.playerData.mapName = 'nexus';
    await vi.advanceTimersByTimeAsync(50_000);
    await flushAsync();

    expect(hostAccess.stopScript).not.toHaveBeenCalled();
  });

  // ── Reconnect classification (2026-09-20: 6 normal server-driven map hops
  // in 9 minutes falsely tripped reconnect-limit; see runnerCore.ts's
  // ReconnectClassifier). ──

  it('a server-driven reconnect (RECONNECT packet within grace) never counts toward stopOn.maxReconnects', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, { runId: 'run-normal-hop', accountLabel: 'lab-1', stopOn: { maxReconnects: 0 } });
    const { ctx, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);

    packetHooks.get('RECONNECT')!({}, {});
    connectClient('loaded'); // the server-driven hop's new connection
    await flushAsync();

    // maxReconnects:0 means even a single abnormal reconnect would have stopped the run.
    expect(existsSync(join(testlabDir, 'run-result.run-normal-hop.json'))).toBe(false);
  });

  it('a reconnect with no preceding RECONNECT packet is abnormal and can trip stopOn.maxReconnects', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, { runId: 'run-bad-hop', accountLabel: 'lab-1', stopOn: { maxReconnects: 0 } });
    const { ctx, connectClient } = makeCtx(hostAccess);
    register(ctx);
    await connectAndSettle(connectClient);

    connectClient('loaded'); // reconnect with no RECONNECT packet ever observed
    await flushAsync();
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-bad-hop');
    expect(result.reason).toBe('reconnect-limit');
  });

  // ── account-not-found / account-ambiguous detail (counts only). ──

  it('account-not-found detail carries counts through from hostAccess, never a real saved label or e-mail', async () => {
    const hostAccess = makeHostAccess({
      launchSavedAccountByLabel: vi.fn(async () => ({ ok: false, error: 'account-not-found', matchCount: 0, totalAccounts: 2 })),
    });
    writeRequest(testlabDir, { runId: 'run-anf-detail', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-anf-detail');
    expect(result.reason).toBe('account-not-found');
    expect(result.detail).toBe(
      `account-not-found: 0 of 2 saved accounts have the label "lab-1" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });

  it('account-ambiguous ends the run with that reason and a counts-only detail, never guessing which account', async () => {
    const hostAccess = makeHostAccess({
      launchSavedAccountByLabel: vi.fn(async () => ({ ok: false, error: 'account-ambiguous', matchCount: 2, totalAccounts: 4 })),
    });
    writeRequest(testlabDir, { runId: 'run-ambig', accountLabel: 'lab-1' });
    const { ctx } = makeCtx(hostAccess);
    register(ctx);
    await flushAsync();

    const result = readResult(testlabDir, 'run-ambig');
    expect(result.reason).toBe('account-ambiguous');
    expect(result.detail).toBe(
      `account-ambiguous: 2 of 4 saved accounts have the label "lab-1" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });
});
