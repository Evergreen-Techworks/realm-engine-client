import { describe, it, expect } from 'vitest';
import {
  TESTLAB_PRIVATE_ONLY,
  runnerCoreMarker,
  MAX_REQUEST_RAW_CHARS,
  MAX_REQUEST_AGE_MS,
  MAX_RUN_MINUTES,
  parseRunRequest,
  extractRunIdForConsumedName,
  consumedRequestFileName,
  resultFileName,
  throwawayConfigId,
  isSafeId,
  buildThrowawayConfigSnapshot,
  buildRejectedResult,
  RunnerStateMachine,
  type RunRequest,
  type PluginConfigSnapshot,
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

  it('launching -> stopping -> done on launch-failed (unrecognized error code maps to launch-failed)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(false, 'boom', null);
    const result = m.finish(1000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: false });
    expect(result.reason).toBe('launch-failed');
    expect(result.detail).toBe('boom');
  });

  it('waiting-world -> running via enterRunning(), stamping inWorldUtc', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    expect(m.hasEnteredWorld()).toBe(false);
    m.enterRunning(500);
    expect(m.getPhase()).toBe('running');
    expect(m.hasEnteredWorld()).toBe(true);
    const result = m.finish(600, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.inWorldUtc).toBe(new Date(500).toISOString());
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

  it('running -> stopping -> done on completed after the requested minutes elapse', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ minutes: 10 }));
    m.onLaunchResult(true, null, 1);
    m.enterRunning(1000);
    expect(m.checkMinutesElapsed(1000 + 10 * 60_000 - 1)).toBe(false);
    expect(m.checkMinutesElapsed(1000 + 10 * 60_000)).toBe(true);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(1000 + 10 * 60_000, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('completed');
  });

  it('running -> stopping -> done on DEATH (default stopOn.death=true when stopOn is absent)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    m.enterRunning(0);
    expect(m.onDeath()).toBe(true);
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(10, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('death');
  });

  it('DEATH is ignored when stopOn.death === false', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ stopOn: { death: false, maxReconnects: undefined } }));
    m.onLaunchResult(true, null, 1);
    m.enterRunning(0);
    expect(m.onDeath()).toBe(false);
    expect(m.getPhase()).toBe('running');
  });

  it('running -> stopping -> done on reconnect-limit once count exceeds stopOn.maxReconnects', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req({ stopOn: { death: true, maxReconnects: 2 } }));
    m.onLaunchResult(true, null, 1);
    m.enterRunning(0);
    expect(m.onReconnect()).toBe(false); // 1
    expect(m.onReconnect()).toBe(false); // 2
    expect(m.onReconnect()).toBe(true); // 3 > 2
    expect(m.getPhase()).toBe('stopping');
    const result = m.finish(10, { build: { version: null, commit: null }, logFile: 'log', recording: null, gameTerminated: true });
    expect(result.reason).toBe('reconnect-limit');
    expect(m.getReconnectCount()).toBe(3);
  });

  it('reconnects never stop the run when maxReconnects is undefined', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    m.enterRunning(0);
    for (let i = 0; i < 50; i++) expect(m.onReconnect()).toBe(false);
    expect(m.getPhase()).toBe('running');
  });

  it('requestStop keeps the FIRST reason when called twice (idempotent)', () => {
    const m = new RunnerStateMachine();
    m.begin(0, req());
    m.onLaunchResult(true, null, 1);
    m.enterRunning(0);
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
    m.enterRunning(0);
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
    m.enterRunning(0);
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
    expect(m.onReconnect()).toBe(false);
    expect(m.getPhase()).toBe('idle');
  });
});
