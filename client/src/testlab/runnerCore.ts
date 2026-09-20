/**
 * Test Lab unattended run — pure core.
 *
 * TESTLAB_PRIVATE_ONLY: this file is listed in `client/private-only.json` and
 * must be deletable from customer builds. Like `interleaverCore.ts` /
 * `recorderCore.ts`, it imports nothing from `fs`, `os`, timers, the proxy,
 * or the dashboard: every external fact (the current wall-clock time, a
 * launch result, an admission phase, a script-start result) is passed in by
 * the caller (the thin plugin, `plugins/testlab-runner.ts`), and every effect
 * (writing a file, broadcasting to the dashboard, starting a script) is left
 * to that caller. That split is what makes this file runnable under `vitest`
 * with plain values instead of a live proxy/dashboard session.
 *
 * Contract this implements: `.superpowers/sdd/2026-09-19-testlab-core/
 * contract-run-request.md` — request/result file shapes are fixed there.
 */

/** See interleaverCore.ts's identical doc comment — same purpose, same string. */
export const TESTLAB_PRIVATE_ONLY = 'TESTLAB_PRIVATE_ONLY';

export function runnerCoreMarker(): string {
  return TESTLAB_PRIVATE_ONLY;
}

export type RunPhase = 'idle' | 'launching' | 'waiting-world' | 'running' | 'stopping' | 'done';

export type RunStopReason =
  | 'completed'
  | 'death'
  | 'reconnect-limit'
  | 'launch-failed'
  | 'never-in-world'
  | 'account-not-found'
  | 'aborted'
  | 'error';

export interface RunStopOn {
  /** Defaults to true when `stopOn` is present but `death` is omitted. */
  death: boolean;
  /** `undefined` means "never stop on reconnect count alone". */
  maxReconnects: number | undefined;
}

export interface RunRequest {
  v: 1;
  runId: string;
  createdUtc: string;
  /** Label of an account already saved in this copy's dashboard — never an email/password. */
  accountLabel: string;
  serverName: string | undefined;
  scriptId: string | undefined;
  /** Clamped to [1, 240] by {@link parseRunRequest}. */
  minutes: number;
  /** Per-plugin overrides applied for this run only — see contract. */
  plugins: Record<string, { enabled?: boolean; settings?: Record<string, unknown> }> | undefined;
  stopOn: RunStopOn | undefined;
}

export type RequestRejectReason = 'oversized' | 'invalid-json' | 'wrong-version' | 'missing-field' | 'unsafe-id' | 'stale';

export type RequestParseResult =
  | { ok: true; request: RunRequest }
  | { ok: false; reason: RequestRejectReason; detail: string };

/** A request file larger than this is rejected without being parsed. */
export const MAX_REQUEST_RAW_CHARS = 64 * 1024;

/** A request older than this (relative to the caller's `nowMs`) is ignored — see contract. */
export const MAX_REQUEST_AGE_MS = 10 * 60_000;

export const MAX_RUN_MINUTES = 240;

/** Every id that can reach a filesystem path (`runId`, `scriptId`, a plugin
 *  id) must satisfy this: 1-64 chars from a safe charset, no leading dot, no
 *  `..` anywhere — so it can never be used to escape the directory it gets
 *  joined into, however it's wrapped into a larger file name. */
const SAFE_ID_CHARS = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!SAFE_ID_CHARS.test(value)) return false;
  if (value.startsWith('.')) return false;
  if (value.includes('..')) return false;
  return true;
}

/**
 * Best-effort `runId` extraction for the consumed-rename target name,
 * tolerant of a request that will later fail full validation (garbage JSON,
 * missing fields, or a stale timestamp) — the caller must rename the file off
 * its live name before doing anything else, so it can never be reconsidered
 * at a later launch, valid or not. Falls back to `'invalid'` when no safe id
 * can be recovered — the SAME safe-charset check `parseRunRequest` uses, so
 * an id this function accepts can never later turn out to be a path-unsafe
 * `runId` once full validation runs.
 */
export function extractRunIdForConsumedName(raw: string): string {
  try {
    const data: unknown = JSON.parse(raw);
    const id = data && typeof data === 'object' ? (data as Record<string, unknown>).runId : undefined;
    if (isSafeId(id)) return id;
  } catch {
    /* fall through to 'invalid' */
  }
  return 'invalid';
}

/** `run-request.<runId>.consumed.json` — see contract. */
export function consumedRequestFileName(runId: string): string {
  return `run-request.${runId}.consumed.json`;
}

/** `run-result.<runId>.json` — see contract. */
export function resultFileName(runId: string): string {
  return `run-result.${runId}.json`;
}

/** `testlab-run-<runId>` — the throwaway plugin-config id for one run. */
export function throwawayConfigId(runId: string): string {
  return `testlab-run-${runId}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse and validate raw request JSON text. Never throws. `nowMs` is the
 * caller's clock — age is measured as `nowMs - Date.parse(createdUtc)`.
 * Unknown top-level fields are ignored. `minutes` is clamped to
 * [1, {@link MAX_RUN_MINUTES}] on a valid request; an out-of-range value is
 * never by itself a rejection reason.
 */
export function parseRunRequest(raw: string, nowMs: number): RequestParseResult {
  if (typeof raw !== 'string' || raw.length > MAX_REQUEST_RAW_CHARS) {
    return { ok: false, reason: 'oversized', detail: `${raw?.length ?? 0} chars` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid-json', detail: (err as Error).message };
  }
  if (!isPlainObject(data)) {
    return { ok: false, reason: 'invalid-json', detail: 'not a JSON object' };
  }

  if (data.v !== 1) {
    return { ok: false, reason: 'wrong-version', detail: `v=${JSON.stringify(data.v)}` };
  }

  const runId = typeof data.runId === 'string' ? data.runId.trim() : '';
  if (!runId) return { ok: false, reason: 'missing-field', detail: 'runId' };
  if (!isSafeId(runId)) return { ok: false, reason: 'unsafe-id', detail: 'runId' };

  const createdUtc = typeof data.createdUtc === 'string' ? data.createdUtc : '';
  const createdMs = createdUtc ? Date.parse(createdUtc) : NaN;
  if (!createdUtc || Number.isNaN(createdMs)) {
    return { ok: false, reason: 'missing-field', detail: 'createdUtc' };
  }

  const accountLabel = typeof data.accountLabel === 'string' ? data.accountLabel.trim() : '';
  if (!accountLabel) return { ok: false, reason: 'missing-field', detail: 'accountLabel' };

  const minutesRaw = Number(data.minutes);
  if (!Number.isFinite(minutesRaw) || minutesRaw <= 0) {
    return { ok: false, reason: 'missing-field', detail: 'minutes' };
  }

  const ageMs = nowMs - createdMs;
  if (ageMs > MAX_REQUEST_AGE_MS) {
    return { ok: false, reason: 'stale', detail: `age=${Math.round(ageMs / 1000)}s` };
  }

  const minutes = Math.min(MAX_RUN_MINUTES, Math.max(1, Math.round(minutesRaw)));

  const serverName = typeof data.serverName === 'string' && data.serverName.trim() ? data.serverName.trim() : undefined;

  const scriptIdRaw = typeof data.scriptId === 'string' ? data.scriptId.trim() : '';
  let scriptId: string | undefined;
  if (scriptIdRaw) {
    if (!isSafeId(scriptIdRaw)) return { ok: false, reason: 'unsafe-id', detail: 'scriptId' };
    scriptId = scriptIdRaw;
  }

  let plugins: RunRequest['plugins'];
  if (isPlainObject(data.plugins)) {
    plugins = {};
    for (const [pluginId, override] of Object.entries(data.plugins)) {
      if (!isPlainObject(override)) continue;
      // A plugin id never reaches a path today, but it's exactly the kind of
      // caller-supplied id this file treats uniformly as unsafe-until-proven.
      if (!isSafeId(pluginId)) return { ok: false, reason: 'unsafe-id', detail: `plugins.${pluginId}` };
      const entry: { enabled?: boolean; settings?: Record<string, unknown> } = {};
      if (typeof override.enabled === 'boolean') entry.enabled = override.enabled;
      if (isPlainObject(override.settings)) entry.settings = { ...override.settings };
      plugins[pluginId] = entry;
    }
  }

  let stopOn: RunStopOn | undefined;
  if (isPlainObject(data.stopOn)) {
    const maxReconnectsRaw = Number((data.stopOn as Record<string, unknown>).maxReconnects);
    stopOn = {
      death: (data.stopOn as Record<string, unknown>).death !== false,
      maxReconnects: Number.isFinite(maxReconnectsRaw) && maxReconnectsRaw >= 0 ? Math.floor(maxReconnectsRaw) : undefined,
    };
  }

  return {
    ok: true,
    request: { v: 1, runId, createdUtc, accountLabel, serverName, scriptId, minutes, plugins, stopOn },
  };
}

/** Shape saved to / loaded from `<configs dir>/<id>.json` — matches PluginConfigService's snapshot shape. */
export interface PluginConfigSnapshot {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  plugins: Array<{ id: string; enabled: boolean; hotkey: string; settings: Record<string, unknown> }>;
}

/**
 * Build the throwaway snapshot for one run: start from the CURRENT live
 * state (`base`, e.g. from `PluginConfigService.buildPluginConfigSnapshot`)
 * and apply the request's `plugins` overrides on top — `enabled` replaced
 * when specified, `settings` merged key-by-key when specified. Plugins not
 * named in `overrides` are carried over unchanged; a named plugin absent
 * from `base` is dropped (this run can't apply settings to a plugin that
 * doesn't exist in this copy). Pure — never touches disk.
 */
export function buildThrowawayConfigSnapshot(
  base: PluginConfigSnapshot,
  runId: string,
  overrides: RunRequest['plugins'],
  nowMs: number,
): PluginConfigSnapshot {
  const id = throwawayConfigId(runId);
  const plugins = base.plugins.map((p) => {
    const override = overrides?.[p.id];
    if (!override) return { ...p, settings: { ...p.settings } };
    return {
      ...p,
      enabled: typeof override.enabled === 'boolean' ? override.enabled : p.enabled,
      settings: override.settings ? { ...p.settings, ...override.settings } : { ...p.settings },
    };
  });
  return { id, name: id, createdAt: nowMs, updatedAt: nowMs, plugins };
}

export interface RunResultFile {
  v: 1;
  runId: string;
  startedUtc: string;
  inWorldUtc: string | null;
  endedUtc: string;
  reason: RunStopReason;
  detail: string;
  build: { version: string | null; commit: string | null };
  logFile: string;
  recording: string | null;
  gamePid: number | null;
  gameTerminated: boolean;
}

export interface RunResultExtras {
  build: { version: string | null; commit: string | null };
  logFile: string;
  recording: string | null;
  gameTerminated: boolean;
  /** Overrides the reason/detail captured by `requestStop` — used by callers
   *  that build the result directly without going through the state machine. */
  detail?: string;
}

/**
 * idle -> launching -> waiting-world -> running -> stopping -> done.
 * Holds no timers and touches nothing outside its own fields — the caller
 * drives time via `now` and performs every side effect (broadcast a launch
 * request, start a script, write a file) itself, then reports the outcome
 * back through one of these methods.
 */
export class RunnerStateMachine {
  private phase: RunPhase = 'idle';
  private request: RunRequest | null = null;
  private startedAtMs = 0;
  private inWorldAtMs: number | null = null;
  private gamePid: number | null = null;
  private reconnectCount = 0;
  private stopReason: RunStopReason | null = null;
  private stopDetail = '';

  getPhase(): RunPhase {
    return this.phase;
  }

  getRequest(): RunRequest | null {
    return this.request;
  }

  getGamePid(): number | null {
    return this.gamePid;
  }

  /** Whether `enterRunning()` ever fired for this run — used to decide whether a nexus attempt makes sense before termination. */
  hasEnteredWorld(): boolean {
    return this.inWorldAtMs != null;
  }

  getReconnectCount(): number {
    return this.reconnectCount;
  }

  /** idle -> launching. Refuses (returns false, no state change) unless idle. */
  begin(now: number, request: RunRequest): boolean {
    if (this.phase !== 'idle') return false;
    this.phase = 'launching';
    this.request = request;
    this.startedAtMs = now;
    this.inWorldAtMs = null;
    this.gamePid = null;
    this.reconnectCount = 0;
    this.stopReason = null;
    this.stopDetail = '';
    return true;
  }

  /**
   * launching -> waiting-world on success, or -> stopping on failure.
   * `error` is one of the renderer's two documented codes
   * (`account-not-found` | `launch-failed`) or any other string, which maps
   * to the generic `launch-failed` reason.
   */
  onLaunchResult(ok: boolean, error: string | null, gamePid: number | null): void {
    if (this.phase !== 'launching') return;
    if (ok) {
      this.gamePid = gamePid;
      this.phase = 'waiting-world';
      return;
    }
    const reason: RunStopReason = error === 'account-not-found' ? 'account-not-found' : 'launch-failed';
    this.requestStop(reason, error ?? 'launch failed');
  }

  /** waiting-world -> running. No-op outside waiting-world. */
  enterRunning(now: number): void {
    if (this.phase !== 'waiting-world') return;
    this.inWorldAtMs = now;
    this.phase = 'running';
  }

  /** waiting-world only: true (and transitions to stopping) once `timeoutMs` has elapsed since `begin()`. */
  checkNeverInWorld(now: number, timeoutMs = 3 * 60_000): boolean {
    if (this.phase !== 'waiting-world') return false;
    if (now - this.startedAtMs < timeoutMs) return false;
    this.requestStop('never-in-world', `no admission "loaded" phase within ${Math.round(timeoutMs / 1000)}s`);
    return true;
  }

  /** running only: true (and transitions to stopping) once the request's minutes have elapsed since `enterRunning`. */
  checkMinutesElapsed(now: number): boolean {
    if (this.phase !== 'running' || !this.request || this.inWorldAtMs == null) return false;
    const elapsedMs = now - this.inWorldAtMs;
    if (elapsedMs < this.request.minutes * 60_000) return false;
    this.requestStop('completed', `${this.request.minutes} minute(s) elapsed`);
    return true;
  }

  /** running only: DEATH observed. Honors `stopOn.death === false` (default true). */
  onDeath(): boolean {
    if (this.phase !== 'running') return false;
    if (this.request?.stopOn && this.request.stopOn.death === false) return false;
    this.requestStop('death', 'DEATH packet observed');
    return true;
  }

  /**
   * waiting-world or running: one more reconnect happened. Stops once the
   * count exceeds `stopOn.maxReconnects` (undefined = never stop on this
   * alone). Returns whether this call triggered a stop.
   */
  onReconnect(): boolean {
    if (this.phase !== 'waiting-world' && this.phase !== 'running') return false;
    this.reconnectCount++;
    const max = this.request?.stopOn?.maxReconnects;
    if (typeof max === 'number' && this.reconnectCount > max) {
      this.requestStop('reconnect-limit', `reconnects=${this.reconnectCount} max=${max}`);
      return true;
    }
    return false;
  }

  /**
   * Any non-terminal phase -> stopping. Idempotent: once stopping/done, the
   * FIRST reason wins and later calls are ignored, so two near-simultaneous
   * triggers (e.g. death and a reconnect) never overwrite each other.
   */
  requestStop(reason: RunStopReason, detail: string): void {
    if (this.phase === 'stopping' || this.phase === 'done') return;
    this.phase = 'stopping';
    this.stopReason = reason;
    this.stopDetail = detail;
  }

  /** stopping -> done. Builds the final result object — see contract. */
  finish(now: number, extras: RunResultExtras): RunResultFile {
    this.phase = 'done';
    return {
      v: 1,
      runId: this.request?.runId ?? '',
      startedUtc: new Date(this.startedAtMs || now).toISOString(),
      inWorldUtc: this.inWorldAtMs != null ? new Date(this.inWorldAtMs).toISOString() : null,
      endedUtc: new Date(now).toISOString(),
      reason: this.stopReason ?? 'error',
      detail: extras.detail ?? this.stopDetail,
      build: extras.build,
      logFile: extras.logFile,
      recording: extras.recording,
      gamePid: this.gamePid,
      gameTerminated: extras.gameTerminated,
    };
  }
}

/**
 * Build a result file directly, for a request that never reached `begin()`
 * (stale/invalid/oversized, or the request file couldn't even be read) — no
 * state machine involved, since nothing was ever started.
 */
export function buildRejectedResult(
  runId: string,
  now: number,
  reason: RunStopReason,
  detail: string,
  extras: Pick<RunResultExtras, 'build' | 'logFile'>,
): RunResultFile {
  return {
    v: 1,
    runId,
    startedUtc: new Date(now).toISOString(),
    inWorldUtc: null,
    endedUtc: new Date(now).toISOString(),
    reason,
    detail,
    build: extras.build,
    logFile: extras.logFile,
    recording: null,
    gamePid: null,
    gameTerminated: false,
  };
}
