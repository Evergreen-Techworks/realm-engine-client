import { describe, it, expect } from 'vitest';
import {
  TESTLAB_PRIVATE_ONLY,
  runnerCoreMarker,
  MAX_REQUEST_RAW_CHARS,
  MAX_REQUEST_AGE_MS,
  MAX_RUN_MINUTES,
  SCRIPT_START_SETTLE_MS,
  NATIVE_BRIDGE_TIMEOUT_MS,
  NO_MOVEMENT_TIMEOUT_MS,
  NO_MOVEMENT_MIN_TILE_DELTA,
  RECONNECT_GRACE_MS,
  RECONNECT_RESET_MS,
  parseRunRequest,
  extractRunIdForConsumedName,
  consumedRequestFileName,
  resultFileName,
  throwawayConfigId,
  isSafeId,
  buildThrowawayConfigSnapshot,
  buildRejectedResult,
  formatAccountMatchDetail,
  RunnerStateMachine,
  ReconnectClassifier,
  type RunRequest,
  type PluginConfigSnapshot,
  type WorldPosition,
} from '../runnerCore.js';

describe('TESTLAB_PRIVATE_ONLY marker', () => {
  it('is the literal string and the accessor returns it', () => {
    expect(TESTLAB_PRIVATE_ONLY).toBe('TESTLAB_PRIVATE_ONLY');
    expect(runnerCoreMarker()).toBe('TESTLAB_PRIVATE_ONLY');
  });
});

const NOW = Date.parse('2026-09-20T03:20:00Z');

function validRequestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    runId: '20260920T031500Z-ab12',
    createdUtc: '2026-09-20T03:15:00Z',
    accountLabel: 'lab-1',
    minutes: 60,
    ...overrides,
  });
}

describe('parseRunRequest — acceptance', () => {
  it('accepts a minimal valid request', () => {
    const result = parseRunRequest(validRequestJson(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.runId).toBe('20260920T031500Z-ab12');
      expect(result.request.accountLabel).toBe('lab-1');
      expect(result.request.minutes).toBe(60);
      expect(result.request.serverName).toBeUndefined();
      expect(result.request.scriptId).toBeUndefined();
      expect(result.request.plugins).toBeUndefined();
      expect(result.request.stopOn).toBeUndefined();
    }
  });

  it('carries optional fields through, and normalizes stopOn.death default', () => {
    const raw = validRequestJson({
      serverName: 'USEast',
      scriptId: 'farmer',
      plugins: {
        'testlab-recorder': { enabled: true },
        'auto-dodge': { settings: { udodgePlanner: 'classic' } },
      },
      stopOn: { maxReconnects: 5 },
    });
    const result = parseRunRequest(raw, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.serverName).toBe('USEast');
      expect(result.request.scriptId).toBe('farmer');
      expect(result.request.plugins).toEqual({
        'testlab-recorder': { enabled: true },
        'auto-dodge': { settings: { udodgePlanner: 'classic' } },
      });
      // death omitted -> defaults true.
      expect(result.request.stopOn).toEqual({ death: true, maxReconnects: 5 });
    }
  });

  it('ignores unknown top-level fields', () => {
    const raw = validRequestJson({ somethingElse: 'ignored', extra: 42 });
    const result = parseRunRequest(raw, NOW);
    expect(result.ok).toBe(true);
  });

  it('an explicit stopOn.death === false is preserved', () => {
    const raw = validRequestJson({ stopOn: { death: false } });
    const result = parseRunRequest(raw, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.stopOn).toEqual({ death: false, maxReconnects: undefined });
  });
});

describe('parseRunRequest — minutes cap', () => {
  it('clamps minutes above 240 down to 240', () => {
    const result = parseRunRequest(validRequestJson({ minutes: 10000 }), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.minutes).toBe(MAX_RUN_MINUTES);
  });

  it('clamps minutes below 1 up to 1', () => {
    const result = parseRunRequest(validRequestJson({ minutes: 0.2 }), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.minutes).toBe(1);
  });

  it('rejects a non-positive/non-numeric minutes as a missing field', () => {
    for (const bad of [0, -5, 'soon', null]) {
      const result = parseRunRequest(validRequestJson({ minutes: bad }), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('missing-field');
    }
  });
});

describe('parseRunRequest — rejections', () => {
  it('rejects an oversized payload without attempting to parse it', () => {
    const huge = 'x'.repeat(MAX_REQUEST_RAW_CHARS + 1);
    const result = parseRunRequest(huge, NOW);
    expect(result).toEqual({ ok: false, reason: 'oversized', detail: `${huge.length} chars` });
  });

  it('rejects invalid JSON', () => {
    const result = parseRunRequest('{not json', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-json');
  });

  it('rejects a JSON array or primitive (not an object)', () => {
    expect(parseRunRequest('[1,2,3]', NOW)).toMatchObject({ ok: false, reason: 'invalid-json' });
    expect(parseRunRequest('"hello"', NOW)).toMatchObject({ ok: false, reason: 'invalid-json' });
  });

  it('rejects a wrong schema version', () => {
    const result = parseRunRequest(validRequestJson({ v: 2 }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'wrong-version' });
  });

  it('rejects a missing/blank runId, createdUtc, or accountLabel', () => {
    expect(parseRunRequest(validRequestJson({ runId: '' }), NOW)).toMatchObject({ ok: false, reason: 'missing-field', detail: 'runId' });
    expect(parseRunRequest(validRequestJson({ createdUtc: 'not-a-date' }), NOW)).toMatchObject({ ok: false, reason: 'missing-field', detail: 'createdUtc' });
    expect(parseRunRequest(validRequestJson({ accountLabel: '   ' }), NOW)).toMatchObject({ ok: false, reason: 'missing-field', detail: 'accountLabel' });
  });

  it('rejects a request older than 10 minutes (stale)', () => {
    const staleCreated = new Date(NOW - MAX_REQUEST_AGE_MS - 1000).toISOString();
    const result = parseRunRequest(validRequestJson({ createdUtc: staleCreated }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('accepts a request exactly at the 10-minute boundary', () => {
    const created = new Date(NOW - MAX_REQUEST_AGE_MS).toISOString();
    const result = parseRunRequest(validRequestJson({ createdUtc: created }), NOW);
    expect(result.ok).toBe(true);
  });
});

describe('extractRunIdForConsumedName / file naming', () => {
  it('extracts a safe runId from otherwise-valid JSON', () => {
    expect(extractRunIdForConsumedName(validRequestJson())).toBe('20260920T031500Z-ab12');
  });

  it('falls back to "invalid" for garbage JSON', () => {
    expect(extractRunIdForConsumedName('{not json')).toBe('invalid');
    expect(extractRunIdForConsumedName('[]')).toBe('invalid');
    expect(extractRunIdForConsumedName('{}')).toBe('invalid');
  });

  it('falls back to "invalid" for a runId containing path-unsafe characters', () => {
    expect(extractRunIdForConsumedName(JSON.stringify({ runId: '../../etc/passwd' }))).toBe('invalid');
    expect(extractRunIdForConsumedName(JSON.stringify({ runId: 'a/b' }))).toBe('invalid');
  });

  it('builds the documented consumed/result file names', () => {
    expect(consumedRequestFileName('abc123')).toBe('run-request.abc123.consumed.json');
    expect(resultFileName('abc123')).toBe('run-result.abc123.json');
    expect(throwawayConfigId('abc123')).toBe('testlab-run-abc123');
  });
});

describe('parseRunRequest — path-unsafe ids are rejected outright', () => {
  it('rejects a runId containing a path separator or traversal segment', () => {
    for (const bad of ['../../etc/passwd', '..', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65)]) {
      const result = parseRunRequest(validRequestJson({ runId: bad }), NOW);
      expect(result).toMatchObject({ ok: false, reason: 'unsafe-id', detail: 'runId' });
    }
  });

  it('rejects an unsafe scriptId', () => {
    const result = parseRunRequest(validRequestJson({ scriptId: '../../evil' }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'unsafe-id', detail: 'scriptId' });
  });

  it('accepts a safe scriptId', () => {
    const result = parseRunRequest(validRequestJson({ scriptId: 'dead-church-farmer' }), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.scriptId).toBe('dead-church-farmer');
  });

  it('rejects an unsafe plugin id in the overrides map', () => {
    const result = parseRunRequest(validRequestJson({ plugins: { '../../evil': { enabled: true } } }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'unsafe-id' });
  });

  it('a runId that would escape testlabDir once wrapped into a result/consumed filename is caught before any file naming happens', () => {
    // Regression for the exact vector: a runId containing real path
    // separators, embedded inside "run-result.<runId>.json", used to escape
    // the testlab directory once passed through path.join/normalize.
    const result = parseRunRequest(validRequestJson({ runId: '../../../../Windows/System32/evil' }), NOW);
    expect(result.ok).toBe(false);
  });
});

describe('isSafeId', () => {
  it('accepts realistic ids', () => {
    for (const id of ['20260920T031500Z-ab12', 'farmer', 'dead-church-farmer', 'testlab-recorder', 'a', '1']) {
      expect(isSafeId(id)).toBe(true);
    }
  });

  it('rejects traversal, absolute-ish, leading-dot, oversized, and non-string values', () => {
    expect(isSafeId('..')).toBe(false);
    expect(isSafeId('../x')).toBe(false);
    expect(isSafeId('a/../b')).toBe(false);
    expect(isSafeId('/etc/passwd')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
    expect(isSafeId('a\\b')).toBe(false);
    expect(isSafeId('.hidden')).toBe(false);
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('x'.repeat(65))).toBe(false);
    expect(isSafeId(undefined)).toBe(false);
    expect(isSafeId(123)).toBe(false);
    expect(isSafeId(null)).toBe(false);
  });

  it('accepts exactly 64 characters', () => {
    expect(isSafeId('x'.repeat(64))).toBe(true);
  });
});

function baseSnapshot(): PluginConfigSnapshot {
  return {
    id: 'default',
    name: 'default',
    createdAt: 1,
    updatedAt: 1,
    plugins: [
      { id: 'auto-dodge', enabled: true, hotkey: '', settings: { udodgePlanner: 'auto', dodgeMode: 'unified' } },
      { id: 'testlab-recorder', enabled: false, hotkey: '', settings: {} },
      { id: 'testlab-interleaver', enabled: false, hotkey: '', settings: { target: 'udodgeEnemyStandoff' } },
      { id: 'auto-loot', enabled: true, hotkey: '', settings: { threshold: 3 } },
    ],
  };
}

describe('buildThrowawayConfigSnapshot', () => {
  it('applies enabled/settings overrides and leaves everything else untouched', () => {
    const snap = buildThrowawayConfigSnapshot(
      baseSnapshot(),
      'r1',
      {
        'testlab-recorder': { enabled: true },
        'testlab-interleaver': { enabled: true, settings: { blockMinutes: 3 } },
        'auto-dodge': { settings: { udodgePlanner: 'classic' } },
      },
      12345,
    );
    expect(snap.id).toBe('testlab-run-r1');
    expect(snap.name).toBe('testlab-run-r1');
    expect(snap.createdAt).toBe(12345);
    expect(snap.updatedAt).toBe(12345);

    const byId = Object.fromEntries(snap.plugins.map((p) => [p.id, p]));
    expect(byId['testlab-recorder'].enabled).toBe(true);
    expect(byId['testlab-interleaver'].enabled).toBe(true);
    expect(byId['testlab-interleaver'].settings).toEqual({ target: 'udodgeEnemyStandoff', blockMinutes: 3 });
    // auto-dodge: enabled untouched, settings merged (dodgeMode survives).
    expect(byId['auto-dodge'].enabled).toBe(true);
    expect(byId['auto-dodge'].settings).toEqual({ udodgePlanner: 'classic', dodgeMode: 'unified' });
    // auto-loot: not named in overrides at all -> byte-identical settings/enabled.
    expect(byId['auto-loot']).toEqual({ id: 'auto-loot', enabled: true, hotkey: '', settings: { threshold: 3 } });
  });

  it('is a no-op copy when overrides is undefined', () => {
    const snap = buildThrowawayConfigSnapshot(baseSnapshot(), 'r1', undefined, 1);
    expect(snap.plugins).toEqual(baseSnapshot().plugins);
  });

  it('never mutates the base snapshot object', () => {
    const base = baseSnapshot();
    const beforeJson = JSON.stringify(base);
    buildThrowawayConfigSnapshot(base, 'r1', { 'auto-dodge': { enabled: false } }, 1);
    expect(JSON.stringify(base)).toBe(beforeJson);
  });
});

function req(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    v: 1,
    runId: 'r1',
    createdUtc: '2026-09-20T03:15:00Z',
    accountLabel: 'lab-1',
    serverName: undefined,
    scriptId: 'farmer',
    minutes: 10,
    plugins: undefined,
    stopOn: undefined,
    ...overrides,
  };
}

/**
 * Drives a machine already in waiting-world (after a successful
 * onLaunchResult) all the way to running, exactly as the settled
 * both-signals path requires: enter waiting-bridge at `inWorldAtMs`, one
 * poll tick establishing the bridge as connected (arming the settle
 * window), then a second tick after the full settle delay observing
 * 'ready' — `checkBridgeReady` only starts the settle clock on the tick
 * that FIRST observes the bridge connected, so a single call can never by
 * itself report 'ready' (this mirrors the real poll loop, which ticks every
 * few seconds).
 */
function toRunning(m: RunnerStateMachine, inWorldAtMs: number): void {
  m.enterWaitingBridge(inWorldAtMs);
  m.checkBridgeReady(inWorldAtMs, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS);
  const outcome = m.checkBridgeReady(inWorldAtMs + SCRIPT_START_SETTLE_MS, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS);
  if (outcome !== 'ready') throw new Error(`toRunning: expected 'ready', got '${outcome}'`);
  m.enterRunning();
}

describe('RunnerStateMachine — every transition', () => {
  it('idle -> launching via begin(); refuses a second begin()', () => {
    const m = new RunnerStateMachine();
    expect(m.getPhase()).toBe('idle');
    expect(m.begin(0, req())).toBe(true);
    expect(m.getPhase()).toBe('launching');
    expect(m.begin(100, req())).toBe(false);
    expect(m.getPhase()).toBe('launching');
  });

  it('launching -> waiting-world on a successful launch, recording the game pid', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 4321);
    expect(m.getPhase()).toBe('waiting-world');
    expect(m.getGamePid()).toBe(4321);
  });

  it('launching -> stopping -> done on account-not-found', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(false, 'account-not-found', null);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(1000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('account-not-found');
    expect(result.gamePid).toBeNull();
  });

  it('launching -> stopping -> done on account-not-found, with a counts-only detail when accountMatch is provided', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ accountLabel: 'lab-1' }));
    m.onLaunchResult(false, 'account-not-found', null, { matchCount: 0, totalAccounts: 2 });
    const result = m.finish(1000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('account-not-found');
    expect(result.detail).toBe(
      `account-not-found: 0 of 2 saved accounts have the label "lab-1" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });

  it('launching -> stopping -> done on account-ambiguous, never guessing', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ accountLabel: 'lab-1' }));
    m.onLaunchResult(false, 'account-ambiguous', null, { matchCount: 2, totalAccounts: 4 });
    const result = m.finish(1000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('account-ambiguous');
    expect(result.detail).toBe(
      `account-ambiguous: 2 of 4 saved accounts have the label "lab-1" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });

  it('launching -> stopping -> done on launch-failed (unrecognized error code maps to launch-failed)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(false, 'boom', null);
    const result = m.finish(1000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('launch-failed');
    expect(result.detail).toBe('boom');
  });

  it('waiting-world -> waiting-bridge -> running, stamping inWorldUtc at waiting-bridge entry', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    expect(m.hasEnteredWorld()).toBe(false);
    m.enterWaitingBridge(500);
    expect(m.getPhase()).toBe('waiting-bridge');
    expect(m.hasEnteredWorld()).toBe(true); // true once in world, independent of the bridge.
    expect(m.checkBridgeReady(500, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
    expect(m.checkBridgeReady(500 + SCRIPT_START_SETTLE_MS, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('ready');
    m.enterRunning();
    expect(m.getPhase()).toBe('running');
    const result = m.finish(600, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.inWorldUtc).toBe(new Date(500).toISOString());
  });

  it('enterRunning() is a no-op outside waiting-bridge (e.g. still waiting-world)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    m.enterRunning();
    expect(m.getPhase()).toBe('waiting-world');
  });

  it('checkBridgeReady is a no-op outside waiting-bridge', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    expect(m.checkBridgeReady(0, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
    expect(m.getPhase()).toBe('launching'); // begin() alone hasn't reached waiting-bridge yet.
  });

  it('hasEnteredWorld stays false for a run that never got past waiting-world', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    m.checkNeverInWorld(180_000);
    expect(m.hasEnteredWorld()).toBe(false);
  });

  it('waiting-world -> stopping -> done on never-in-world after the timeout', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    expect(m.checkNeverInWorld(179_999)).toBe(false);
    expect(m.getPhase()).toBe('waiting-world');
    expect(m.checkNeverInWorld(180_000)).toBe(true);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(180_100, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('never-in-world');
  });

  describe('waiting-bridge -> running via checkBridgeReady (script-start gate)', () => {
    it('stays "waiting" before the settle delay elapses, even with the bridge connected the whole time', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      m.enterWaitingBridge(0);
      expect(m.checkBridgeReady(SCRIPT_START_SETTLE_MS - 1, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
      expect(m.getPhase()).toBe('waiting-bridge');
    });

    it('becomes "ready" exactly at the settle boundary', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      m.enterWaitingBridge(0);
      expect(m.checkBridgeReady(0, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting'); // first observation arms the settle clock at t=0
      expect(m.checkBridgeReady(SCRIPT_START_SETTLE_MS, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('ready');
      expect(m.getPhase()).toBe('waiting-bridge'); // caller transitions explicitly with enterRunning().
    });

    it('a bridge that disconnects before the settle delay resets the settle window', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      m.enterWaitingBridge(0);
      expect(m.checkBridgeReady(1000, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting'); // arms settle clock at t=1000
      expect(m.checkBridgeReady(2000, false, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting'); // dropped before it elapsed
      // Reconnects at 2500; settle now measured from 2500, not the original 1000.
      expect(m.checkBridgeReady(2500, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting'); // re-arms at t=2500
      expect(m.checkBridgeReady(2500 + SCRIPT_START_SETTLE_MS - 1, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
      expect(m.checkBridgeReady(2500 + SCRIPT_START_SETTLE_MS, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('ready');
    });

    it('times out with reason native-not-connected when the bridge never connects within NATIVE_BRIDGE_TIMEOUT_MS of entering world', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      m.enterWaitingBridge(0);
      expect(m.checkBridgeReady(NATIVE_BRIDGE_TIMEOUT_MS - 1, false, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
      expect(m.getPhase()).toBe('waiting-bridge');
      expect(m.checkBridgeReady(NATIVE_BRIDGE_TIMEOUT_MS, false, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('timeout');
      expect(m.getPhase()).toBe('stopping');
      // The character is genuinely in the world when this fires -- hasEnteredWorld must stay true.
      expect(m.hasEnteredWorld()).toBe(true);
      const result = m.finish(NATIVE_BRIDGE_TIMEOUT_MS + 50, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
      expect(result.reason).toBe('native-not-connected');
      expect(result.inWorldUtc).toBe(new Date(0).toISOString());
    });

    it('a bridge that connects just before the timeout still needs its own full settle window, which can push past the timeout', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      m.enterWaitingBridge(0);
      // Connects with only 1ms of settle room left before the timeout would fire.
      const almostTimeout = NATIVE_BRIDGE_TIMEOUT_MS - 1;
      expect(m.checkBridgeReady(almostTimeout, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS)).toBe('waiting');
      // One tick later the settle window hasn't elapsed yet, but neither has the overall timeout been re-armed --
      // the very next check, past the timeout mark, must NOT report 'ready' just because the bridge is connected.
      const stillWithinSettle = almostTimeout + SCRIPT_START_SETTLE_MS - 1;
      const outcome = m.checkBridgeReady(stillWithinSettle, true, SCRIPT_START_SETTLE_MS, NATIVE_BRIDGE_TIMEOUT_MS);
      expect(outcome).toBe('timeout');
      expect(m.getPhase()).toBe('stopping');
    });
  });

  describe('movement watchdog (running only)', () => {
    const pos = (x: number, y: number, mapKey: string | number = 'realm'): WorldPosition => ({ x, y, mapKey });

    it('stays "waiting" before the timeout, and arms on the first call', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      expect(m.checkMovement(1000, pos(0, 0), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting');
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS + 1000 - 1, pos(0, 0), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting');
    });

    it('"moved" once distance reaches the tile threshold, and resets the window', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      m.checkMovement(0, pos(100, 100), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA); // arm baseline
      expect(m.checkMovement(1000, pos(100.5, 100), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting'); // < 1 tile
      expect(m.checkMovement(2000, pos(101, 100), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('moved'); // exactly 1 tile
      // Window reset at t=2000 -- no restart even after another full timeout with no further movement, until it re-elapses.
      expect(m.checkMovement(2000 + NO_MOVEMENT_TIMEOUT_MS - 1, pos(101, 100), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting');
    });

    it('a map change counts as movement even at the identical x/y', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      m.checkMovement(0, pos(50, 50, 'nexus'), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA);
      expect(m.checkMovement(1000, pos(50, 50, 'realm-42'), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('moved');
    });

    it('"restart" once after NO_MOVEMENT_TIMEOUT_MS with no movement, then "stopped" after another full window with still none', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      m.checkMovement(0, pos(10, 10), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA); // arm
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS - 1, pos(10, 10), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting');
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS, pos(10, 10), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('restart');
      expect(m.getPhase()).toBe('running'); // restart doesn't stop the run itself.
      // Second window starts fresh from the restart tick.
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS + NO_MOVEMENT_TIMEOUT_MS - 1, pos(10, 10), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe(
        'waiting',
      );
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS * 2, pos(10, 10), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('stopped');
      expect(m.getPhase()).toBe('stopping');
      const result = m.finish(NO_MOVEMENT_TIMEOUT_MS * 2 + 10, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
      expect(result.reason).toBe('no-movement');
    });

    it('movement after a restart refreshes the one-restart budget for a later stall', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      m.checkMovement(0, pos(0, 0), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA);
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS, pos(0, 0), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('restart'); // restart #1 used
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS + 1000, pos(5, 5), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('moved'); // real movement
      // A SECOND stall, long after, gets its own restart -- the budget isn't "used up" for the whole run.
      const t2 = NO_MOVEMENT_TIMEOUT_MS + 1000 + NO_MOVEMENT_TIMEOUT_MS;
      expect(m.checkMovement(t2, pos(5, 5), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('restart');
    });

    it('is a no-op outside running', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      expect(m.checkMovement(0, pos(0, 0), NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('waiting');
      expect(m.getPhase()).toBe('launching');
    });

    it('missing position data on both sides never proves movement -- still escalates to restart/stopped as a safety net', () => {
      const m = new RunnerStateMachine();
      m.begin(0, req());
      m.onLaunchResult(true, null, 1);
      toRunning(m, 0);
      m.checkMovement(0, null, NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA);
      expect(m.checkMovement(NO_MOVEMENT_TIMEOUT_MS, null, NO_MOVEMENT_TIMEOUT_MS, NO_MOVEMENT_MIN_TILE_DELTA)).toBe('restart');
    });
  });

  it('running -> stopping -> done on completed after the requested minutes elapse', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ minutes: 10 }));
    m.onLaunchResult(true, null, 1);
    toRunning(m, 1000);
    const base = 1000; // inWorldAtMs, and checkMinutesElapsed's epoch.
    expect(m.checkMinutesElapsed(base + 10 * 60_000 - 1)).toBe(false);
    expect(m.checkMinutesElapsed(base + 10 * 60_000)).toBe(true);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(base + 10 * 60_000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('completed');
  });

  it('running -> stopping -> done on DEATH (default stopOn.death=true when stopOn is absent)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    expect(m.onDeath()).toBe(true);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(10, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('death');
  });

  it('DEATH is ignored when stopOn.death === false', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ stopOn: { death: false, maxReconnects: undefined } }));
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    expect(m.onDeath()).toBe(false);
    expect(m.getPhase()).toBe('running');
  });

  it('running -> stopping -> done on reconnect-limit once count exceeds stopOn.maxReconnects', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ stopOn: { death: true, maxReconnects: 2 } }));
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    expect(m.onReconnect(100)).toBe(false); // 1
    expect(m.onReconnect(200)).toBe(false); // 2
    expect(m.onReconnect(300)).toBe(true); // 3 > 2
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(310, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('reconnect-limit');
    expect(m.getReconnectCount()).toBe(3);
  });

  it('reconnects never stop the run when maxReconnects is undefined', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    for (let i = 0; i < 50; i++) expect(m.onReconnect(1000 + i * 1000)).toBe(false);
    expect(m.getPhase()).toBe('running');
  });

  it('the abnormal-reconnect count resets after RECONNECT_RESET_MS of healthy play', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ stopOn: { death: true, maxReconnects: 1 } }));
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    expect(m.onReconnect(1000)).toBe(false); // count=1, under the limit
    // A long healthy stretch passes -- the next one starts counting from zero again.
    expect(m.onReconnect(1000 + RECONNECT_RESET_MS)).toBe(false); // reset to 0, then count=1
    expect(m.getReconnectCount()).toBe(1);
    // But two close together after the reset DOES trip it.
    expect(m.onReconnect(1000 + RECONNECT_RESET_MS + 1000)).toBe(true); // count=2 > 1
  });

  it('requestStop keeps the FIRST reason when called twice (idempotent)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    m.requestStop('death', 'first');
    m.requestStop('error', 'second');
    const result = m.finish(10, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('death');
    expect(result.detail).toBe('first');
  });

  it('an exception-path caller can force reason "error" via requestStop then finish', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    toRunning(m, 0);
    m.requestStop('error', 'unexpected exception: boom');
    const result = m.finish(20, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('error');
    expect(result.detail).toBe('unexpected exception: boom');
  });

  it('finish() without ever calling requestStop defaults to reason "error"', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    // Force phase to stopping without a reason by calling finish anyway —
    // guards the "never left in an ambiguous state" property.
    const result = m.finish(5, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('error');
  });

  it('result carries runId, build, logFile, recording, gamePid, gameTerminated through untouched', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ runId: 'r-xyz' }));
    m.onLaunchResult(true, null, 999);
    toRunning(m, 0);
    m.requestStop('completed', 'done');
    const result = m.finish(30, {
      build: { version: '1.2.3', commit: 'deadbeef' },
      logFile: 'C:\\x\\realm-engine-proxy.log',
      recording: 'C:\\x\\testlab\\packets-1.jsonl',
      gameTerminated: true,
    });
    expect(result).toMatchObject({
      v: 1,
      runId: 'r-xyz',
      reason: 'completed',
      detail: 'done',
      build: { version: '1.2.3', commit: 'deadbeef' },
      logFile: 'C:\\x\\realm-engine-proxy.log',
      recording: 'C:\\x\\testlab\\packets-1.jsonl',
      gamePid: 999,
      gameTerminated: true,
    });
  });
});

describe('formatAccountMatchDetail', () => {
  it('formats the documented account-not-found example exactly', () => {
    expect(formatAccountMatchDetail('account-not-found', 0, 2, 'lab-1')).toBe(
      `account-not-found: 0 of 2 saved accounts have the label "lab-1" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });

  it('singularizes "account" for exactly one saved account', () => {
    expect(formatAccountMatchDetail('account-not-found', 0, 1, 'x')).toBe(
      `account-not-found: 0 of 1 saved account have the label "x" (labels are compared case-insensitively, ignoring spaces, '-' and '_')`,
    );
  });

  it('never contains anything but the reason, counts, and the queried label', () => {
    const detail = formatAccountMatchDetail('account-ambiguous', 2, 5, 'twin-1');
    expect(detail).not.toMatch(/@/); // no e-mail shape ever sneaks in
    expect(detail).toContain('2 of 5');
  });
});

describe('ReconnectClassifier', () => {
  it('replays the real 2026-09-20 sequence (6 server-driven map hops in 9 minutes) and trips on NONE of them', () => {
    const c = new ReconnectClassifier();
    // 06:17:56 already in Realm, already loaded.
    c.onAdmissionLoaded();

    // 06:18:54 RECONNECT "Nexus" -> 06:18:55 connected -> Map: Nexus (loaded shortly after).
    c.onReconnectPacket(58_000);
    expect(c.classify(59_000)).toBe(false);
    c.onAdmissionLoaded();

    // 06:19:02 RECONNECT "NexusPortal.Zephyr" -> connected -> Map: Realm (loaded).
    c.onReconnectPacket(66_000);
    expect(c.classify(66_500)).toBe(false);
    c.onAdmissionLoaded();

    // 06:20:21 RECONNECT "Nexus" -> connected -> Map: Nexus (loaded).
    c.onReconnectPacket(145_000);
    expect(c.classify(145_600)).toBe(false);
    c.onAdmissionLoaded();

    // 06:20:30 RECONNECT "NexusPortal.Zephyr" -> 06:20:31 connected (the 6th hop, run stopped here in the old code).
    c.onReconnectPacket(154_000);
    expect(c.classify(155_000)).toBe(false);
  });

  it('an abnormal reconnect: no RECONNECT packet observed at all', () => {
    const c = new ReconnectClassifier();
    c.onAdmissionLoaded();
    expect(c.classify(100_000)).toBe(true);
  });

  it('an abnormal reconnect: the last RECONNECT packet is stale (older than RECONNECT_GRACE_MS)', () => {
    const c = new ReconnectClassifier();
    c.onAdmissionLoaded();
    c.onReconnectPacket(0);
    expect(c.classify(RECONNECT_GRACE_MS + 1)).toBe(true);
  });

  it('a RECONNECT packet exactly at the grace boundary still counts as normal', () => {
    const c = new ReconnectClassifier();
    c.onAdmissionLoaded();
    c.onReconnectPacket(0);
    expect(c.classify(RECONNECT_GRACE_MS)).toBe(false);
  });

  it('an abnormal reconnect: the connection that just ended never reached "loaded" (a failed reconnect attempt), even with a fresh RECONNECT packet', () => {
    const c = new ReconnectClassifier();
    // First connection reached loaded.
    c.onAdmissionLoaded();
    c.onReconnectPacket(1000);
    expect(c.classify(1100)).toBe(false); // normal hop -- but this new connection...
    // ...never itself reaches 'loaded' before the NEXT reconnect (crashed mid-load).
    c.onReconnectPacket(2000);
    expect(c.classify(2100)).toBe(true); // abnormal: previous connection never loaded.
  });

  it('classify() resets loaded-tracking for the new connection regardless of the verdict', () => {
    const c = new ReconnectClassifier();
    c.onAdmissionLoaded();
    c.onReconnectPacket(0);
    expect(c.classify(100)).toBe(false);
    // The new connection (post-classify) hasn't reached loaded yet -- a reconnect
    // right now, even with a fresh packet, is abnormal because THIS one never loaded.
    c.onReconnectPacket(200);
    expect(c.classify(300)).toBe(true);
  });
});

describe('buildRejectedResult (stale/invalid/oversized — never reached begin())', () => {
  it('builds a well-formed result with no gamePid and gameTerminated=false', () => {
    const result = buildRejectedResult('invalid', 1000, 'error', 'stale: age=700s', {
      build: { version: '1.0.0', commit: 'abc' },
      logFile: 'log.log',
    });
    expect(result).toEqual({
      v: 1,
      runId: 'invalid',
      startedUtc: new Date(1000).toISOString(),
      inWorldUtc: null,
      endedUtc: new Date(1000).toISOString(),
      reason: 'error',
      detail: 'stale: age=700s',
      build: { version: '1.0.0', commit: 'abc' },
      logFile: 'log.log',
      recording: null,
      gamePid: null,
      gameTerminated: false,
    });
  });
});

describe('no request -> inert (documented at the plugin level; core-level guarantee)', () => {
  it('a freshly constructed machine does nothing until begin() is called', () => {
    const m = new RunnerStateMachine();
    expect(m.getPhase()).toBe('idle');
    expect(m.checkNeverInWorld(1_000_000)).toBe(false);
    expect(m.checkMinutesElapsed(1_000_000)).toBe(false);
    expect(m.onDeath()).toBe(false);
    expect(m.onReconnect(0)).toBe(false);
    expect(m.getPhase()).toBe('idle');
  });
});
