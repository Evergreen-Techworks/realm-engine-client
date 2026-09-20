import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable holders the mock factories below close over (vi.mock factories are
// hoisted above normal imports, so they can't reference plain outer-scope
// `let`s declared after them — vi.hoisted() is the escape hatch).
const state = vi.hoisted(() => ({ testDir: '' }));
const fakes = vi.hoisted(() => ({
  terminateGameProcessByPid: vi.fn(() => ({ ok: true })),
  getLatestCredentialLaunchByAccountLabel: vi.fn(() => undefined as { pidLauncher: number } | undefined),
}));

vi.mock('../../util/Logger.js', () => ({
  loggerDirectory: () => state.testDir,
}));
vi.mock('../../util/buildInfo.js', () => ({
  readBuildInfoFile: () => null,
}));
vi.mock('../../dashboard/server/GameLauncher.js', () => ({
  terminateGameProcessByPid: (...args: unknown[]) => fakes.terminateGameProcessByPid(...(args as [number])),
}));
vi.mock('../../dashboard/process/credentialLaunchRegistry.js', () => ({
  getLatestCredentialLaunchByAccountLabel: (...args: unknown[]) =>
    fakes.getLatestCredentialLaunchByAccountLabel(...(args as [string])),
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
    ...overrides,
  };
}

function makeCtx(hostAccess: HostAccessFake | null) {
  const logs: string[] = [];
  const broadcasts: Array<{ type: string; data: unknown }> = [];
  const clientMessageHandlers = new Map<string, (msg: unknown) => void>();
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
    onClientMessage: vi.fn((type: string, cb: (msg: unknown) => void) => clientMessageHandlers.set(type, cb)),
    broadcastData: vi.fn((type: string, data: unknown) => broadcasts.push({ type, data })),
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
    broadcasts,
    clientMessageHandlers,
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
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'testlab-runner-'));
    state.testDir = testDir;
    testlabDir = join(testDir, 'testlab');
    fakes.terminateGameProcessByPid.mockReset().mockReturnValue({ ok: true });
    fakes.getLatestCredentialLaunchByAccountLabel.mockReset().mockReturnValue(undefined);
    // Never let the plugin's quit path actually signal the real test process.
    emitSpy = vi.spyOn(process, 'emit').mockImplementation(() => true);
    // The plugin waits a real 5s before terminating the game process after a
    // nexus attempt; fake timers let tests that reach that path advance
    // virtual time instead of actually waiting.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    emitSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Flushes the post-stop nexus-wait (a real 5s delay) plus any downstream microtasks. */
  async function advancePastNexusWait(): Promise<void> {
    await vi.advanceTimersByTimeAsync(6000);
  }

  it('does nothing at all when no request file exists (inert)', () => {
    const { ctx, broadcasts, logs } = makeCtx(makeHostAccess());
    register(ctx);
    expect(broadcasts).toEqual([]);
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

  it('launch-by-label broadcast contains no credential-shaped fields', () => {
    writeRequest(testlabDir, { runId: 'run-cred', accountLabel: 'lab-1', serverName: 'USEast' });
    const { ctx, broadcasts } = makeCtx(makeHostAccess());
    register(ctx);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe('testlabLaunch');
    const data = broadcasts[0].data as Record<string, unknown>;
    expect(data).toEqual({ runId: 'run-cred', accountLabel: 'lab-1', serverName: 'USEast' });
    const keys = Object.keys(data);
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('password');
    expect(keys.sort()).toEqual(['accountLabel', 'runId', 'serverName']);
  });

  it('account-not-found: writes a result with that reason and never touches the game process', async () => {
    writeRequest(testlabDir, { runId: 'run-anf', accountLabel: 'nobody' });
    const { ctx, clientMessageHandlers } = makeCtx(makeHostAccess());
    register(ctx);

    const reply = clientMessageHandlers.get('testlabLaunchResult');
    expect(reply).toBeTruthy();
    reply!({ runId: 'run-anf', ok: false, error: 'account-not-found' });
    await flushAsync();

    const result = readResult(testlabDir, 'run-anf');
    expect(result.reason).toBe('account-not-found');
    expect(result.gamePid).toBeNull();
    expect(result.gameTerminated).toBe(false);
    expect(fakes.terminateGameProcessByPid).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('default.json is never written: the throwaway config id is always used, never "default"', async () => {
    const hostAccess = makeHostAccess();
    writeRequest(testlabDir, {
      runId: 'run-cfg',
      accountLabel: 'lab-1',
      scriptId: 'farmer',
      plugins: { 'auto-dodge': { enabled: true } },
    });
    const { ctx, clientMessageHandlers, connectClient, packetHooks } = makeCtx(hostAccess);
    register(ctx);

    connectClient('loaded'); // world already loaded by the time the launch reply lands
    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-cfg', ok: true });
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

  it('PID-scoped termination: refuses a PID whose image name is not the game, and reports gameTerminated:false', async () => {
    fakes.getLatestCredentialLaunchByAccountLabel.mockReturnValue({ pidLauncher: 4321, pidUnity: null } as any);
    fakes.terminateGameProcessByPid.mockReturnValue({ ok: false, error: 'pid 4321 is "notepad.exe", not "RotMG Exalt.exe" — refusing to kill it' });

    writeRequest(testlabDir, { runId: 'run-pid', accountLabel: 'lab-1' });
    const { ctx, clientMessageHandlers, connectClient, packetHooks } = makeCtx(makeHostAccess());
    register(ctx);

    connectClient('loaded');
    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-pid', ok: true });
    await flushAsync();

    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    expect(fakes.terminateGameProcessByPid).toHaveBeenCalledWith(4321);
    const result = readResult(testlabDir, 'run-pid');
    expect(result.gamePid).toBe(4321);
    expect(result.gameTerminated).toBe(false);
    expect(result.reason).toBe('death');
  });

  it('PID-scoped termination succeeds and reports gameTerminated:true for a matching image', async () => {
    fakes.getLatestCredentialLaunchByAccountLabel.mockReturnValue({ pidLauncher: 555, pidUnity: null } as any);
    fakes.terminateGameProcessByPid.mockReturnValue({ ok: true });

    writeRequest(testlabDir, { runId: 'run-pid-ok', accountLabel: 'lab-1' });
    const { ctx, clientMessageHandlers, connectClient, packetHooks } = makeCtx(makeHostAccess());
    register(ctx);

    connectClient('loaded');
    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-pid-ok', ok: true });
    await flushAsync();
    packetHooks.get('DEATH')!({}, {});
    await advancePastNexusWait();

    const result = readResult(testlabDir, 'run-pid-ok');
    expect(result.gameTerminated).toBe(true);
  });

  it('result file is written even on an exception path mid-run', async () => {
    // Throw from inside runRequest's try block (right after a successful launch).
    fakes.getLatestCredentialLaunchByAccountLabel.mockImplementation(() => {
      throw new Error('boom');
    });

    writeRequest(testlabDir, { runId: 'run-boom', accountLabel: 'lab-1' });
    const { ctx, clientMessageHandlers } = makeCtx(makeHostAccess());
    register(ctx);

    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-boom', ok: true });
    await flushAsync();

    const result = readResult(testlabDir, 'run-boom');
    expect(result.reason).toBe('error');
    expect(result.detail).toMatch(/boom/);
  });

  it('a stale request (older than 10 minutes) is rejected and never broadcasts a launch', () => {
    writeRequest(testlabDir, {
      runId: 'run-stale',
      createdUtc: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    const { ctx, broadcasts } = makeCtx(makeHostAccess());
    register(ctx);

    expect(broadcasts).toEqual([]);
    const result = readResult(testlabDir, 'run-stale');
    expect(result.reason).toBe('error');
    expect(result.detail).toMatch(/stale/);
  });

  it('script-not-installed ends the run with reason error and the documented detail text', async () => {
    const hostAccess = makeHostAccess({ startScript: vi.fn(async () => ({ ok: false, error: 'Script package not found: farmer' })) });
    writeRequest(testlabDir, { runId: 'run-noscript', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, clientMessageHandlers, connectClient } = makeCtx(hostAccess);
    register(ctx);

    connectClient('loaded');
    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-noscript', ok: true });
    await flushAsync();

    const result = readResult(testlabDir, 'run-noscript');
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('script not installed');
  });

  it('a different script-start failure (not "not found") keeps its own detail text', async () => {
    const hostAccess = makeHostAccess({ startScript: vi.fn(async () => ({ ok: false, error: 'Already running' })) });
    writeRequest(testlabDir, { runId: 'run-already', accountLabel: 'lab-1', scriptId: 'farmer' });
    const { ctx, clientMessageHandlers, connectClient } = makeCtx(hostAccess);
    register(ctx);

    connectClient('loaded');
    clientMessageHandlers.get('testlabLaunchResult')!({ runId: 'run-already', ok: true });
    await flushAsync();

    const result = readResult(testlabDir, 'run-already');
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('Already running');
  });
});
