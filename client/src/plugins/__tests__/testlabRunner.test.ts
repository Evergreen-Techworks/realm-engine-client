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
    requestAppShutdown: vi.fn(),
    ...overrides,
  };
}

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
  } as unknown as PluginContext;

  function connectClient(admissionPhase: string): { admission: { phase: string }; connected: boolean; sendToServer: ReturnType<typeof vi.fn> } {
    const client = {
      admission: { phase: admissionPhase },
      connected: true,
      sendToServer: vi.fn((p: unknown) => sentPackets.push(p)),
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
    connectClient('loaded'); // world already loaded by the time the launch resolves
    await flushAsync();

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
    connectClient('loaded');
    await flushAsync();

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
    connectClient('loaded');
    await flushAsync();
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
    connectClient('loaded');
    await flushAsync();
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
    connectClient('loaded');
    await flushAsync();

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
    connectClient('loaded');
    await flushAsync();

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
});
