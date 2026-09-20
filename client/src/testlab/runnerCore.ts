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

export type RunPhase = 'idle' | 'launching' | 'waiting-world' | 'waiting-bridge' | 'running' | 'stopping' | 'done';

export type RunStopReason =
  | 'completed'
  | 'death'
  | 'reconnect-limit'
  | 'launch-failed'
  | 'never-in-world'
  | 'native-not-connected'
  | 'no-movement'
  | 'account-not-found'
  | 'account-ambiguous'
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

/** How long BOTH "in world" and "native bridge connected" must hold true,
 *  back to back, before the script is started — the first live unattended
 *  run started the script the instant admission reached 'loaded', while the
 *  native DLL bridge connected ~15s later; the script's one-shot DLL setup
 *  and navigation goal were sent while nothing was listening and were never
 *  retried (the DLL bridge replays ordinary feature toggles on reconnect,
 *  but a script's navigation goal is explicitly excluded from that replay —
 *  see InternalBridge.ts). This settle window exists so a bridge connection
 *  that flaps right at the boundary doesn't start the script into another
 *  drop. */
export const SCRIPT_START_SETTLE_MS = 3000;

/** How long to wait for the native bridge to connect after entering the
 *  world before giving up with reason `native-not-connected`. */
export const NATIVE_BRIDGE_TIMEOUT_MS = 120_000;

/** Movement watchdog: how long after the script (last) started with no
 *  observed movement/map-change before restarting it once, and again before
 *  ending the run with reason `no-movement`. */
export const NO_MOVEMENT_TIMEOUT_MS = 90_000;

/** Movement watchdog: the minimum distance (in tiles) that counts as "moved". */
export const NO_MOVEMENT_MIN_TILE_DELTA = 1;

/** A new client connection is trusted as a normal, server-driven map hop
 *  (portal, Auto Nexus, a dungeon teleport) only when a server RECONNECT
 *  packet was observed within this many ms beforehand. */
export const RECONNECT_GRACE_MS = 10_000;

/** After this much healthy play with no abnormal reconnect, the abnormal
 *  count resets — a run that occasionally blips early on should not have
 *  that count carried against it hours later. */
export const RECONNECT_RESET_MS = 300_000;

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

/** A player position tied to the map it was observed on, for the movement
 *  watchdog — a position alone can't tell "moved" from "teleported to an
 *  identical-looking spot on a new map". */
export interface WorldPosition {
  x: number;
  y: number;
  mapKey: string | number;
}

/**
 * Whether `current` counts as "moved" from `baseline` for the watchdog: a
 * map change always counts, otherwise the straight-line distance must reach
 * `minTileDelta`. Missing data (either side `null`) can never prove
 * movement, so it counts as not-moved — the watchdog is a safety net and
 * unreadable position data is exactly the kind of stall it exists to catch.
 */
function hasMoved(baseline: WorldPosition | null, current: WorldPosition | null, minTileDelta: number): boolean {
  if (!baseline || !current) return false;
  if (baseline.mapKey !== current.mapKey) return true;
  return Math.hypot(current.x - baseline.x, current.y - baseline.y) >= minTileDelta;
}

/**
 * The human-readable `detail` for `account-not-found` / `account-ambiguous` —
 * counts only, exactly as the contract requires: never a real saved label or
 * e-mail, only how many of how many accounts matched the requested label
 * (`queriedLabel` is the label the request itself asked for, already known
 * to whoever wrote the request file — not saved-account data).
 */
export function formatAccountMatchDetail(
  reason: 'account-not-found' | 'account-ambiguous',
  matchCount: number,
  totalAccounts: number,
  queriedLabel: string,
): string {
  const accountsWord = totalAccounts === 1 ? 'account' : 'accounts';
  return (
    `${reason}: ${matchCount} of ${totalAccounts} saved ${accountsWord} have the label "${queriedLabel}" ` +
    `(labels are compared case-insensitively, ignoring spaces, '-' and '_')`
  );
}

/** Extra detail passed to {@link RunnerStateMachine.onLaunchResult} only for
 *  the two account-matching failures — counts only, see {@link formatAccountMatchDetail}. */
export interface AccountMatchInfo {
  matchCount: number;
  totalAccounts: number;
}

/**
 * Classifies each client (re)connection after the run's first as a normal,
 * server-driven map hop or an abnormal one worth counting toward
 * `stopOn.maxReconnects`. A farming session hops maps constantly (portals,
 * Auto Nexus, dungeon teleports) — the server always answers with a
 * RECONNECT packet first. Measured on a real run: 6 such hops in 9 minutes,
 * all server-driven, none abnormal; the old code counted every one of them
 * and hit a false `reconnect-limit`.
 *
 * A reconnect is abnormal when EITHER:
 *  - no server RECONNECT packet was observed within `RECONNECT_GRACE_MS`
 *    before this new connection, OR
 *  - the connection that just ended never reached admission 'loaded' at all
 *    (a failed/aborted connection attempt, not a completed hop).
 *
 * Pure and clock-driven: the caller feeds it every RECONNECT packet, every
 * admission-loaded observation, and every new-connection event with `now`.
 */
export class ReconnectClassifier {
  private lastReconnectPacketAtMs: number | null = null;
  private currentConnectionReachedLoaded = false;

  /** Call whenever a server RECONNECT packet is observed, on any connection. */
  onReconnectPacket(now: number): void {
    this.lastReconnectPacketAtMs = now;
  }

  /** Call whenever the CURRENT connection's admission phase is observed at 'loaded'. Idempotent. */
  onAdmissionLoaded(): void {
    this.currentConnectionReachedLoaded = true;
  }

  /**
   * Call on every clientConnected event AFTER the run's very first
   * connection (the caller decides that — this class has no notion of
   * "first"). Returns whether this new connection is abnormal. Resets
   * loaded-tracking for the new connection either way.
   */
  classify(now: number): boolean {
    const precededByReconnectPacket =
      this.lastReconnectPacketAtMs != null && now - this.lastReconnectPacketAtMs <= RECONNECT_GRACE_MS;
    const previousReachedLoaded = this.currentConnectionReachedLoaded;
    this.currentConnectionReachedLoaded = false;
    return !precededByReconnectPacket || !previousReachedLoaded;
  }
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
 * idle -> launching -> waiting-world -> waiting-bridge -> running -> stopping
 * -> done. Holds no timers and touches nothing outside its own fields — the
 * caller drives time via `now` and performs every side effect (broadcast a
 * launch request, start a script, write a file) itself, then reports the
 * outcome back through one of these methods.
 */
export class RunnerStateMachine {
  private phase: RunPhase = 'idle';
  private request: RunRequest | null = null;
  private startedAtMs = 0;
  private inWorldAtMs: number | null = null;
  private gamePid: number | null = null;
  private reconnectCount = 0;
  private lastReconnectAtMs: number | null = null;
  private stopReason: RunStopReason | null = null;
  private stopDetail = '';

  /** Set once the settle window's "both true" condition is first observed;
   *  cleared whenever the bridge drops before the settle elapses. */
  private bridgeReadySinceMs: number | null = null;

  // Movement watchdog (running phase only).
  private movementBaselineAtMs: number | null = null;
  private movementBaselinePos: WorldPosition | null = null;
  private movementRestartUsed = false;

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
    this.lastReconnectAtMs = null;
    this.stopReason = null;
    this.stopDetail = '';
    this.bridgeReadySinceMs = null;
    this.movementBaselineAtMs = null;
    this.movementBaselinePos = null;
    this.movementRestartUsed = false;
    return true;
  }

  /**
   * launching -> waiting-world on success, or -> stopping on failure.
   * `error` is one of the renderer's documented codes (`account-not-found` |
   * `account-ambiguous` | `launch-failed`) or any other string, which maps to
   * the generic `launch-failed` reason. `accountMatch` (present only for the
   * two account-matching failures) drives the counts-only detail text — see
   * {@link formatAccountMatchDetail}.
   */
  onLaunchResult(ok: boolean, error: string | null, gamePid: number | null, accountMatch?: AccountMatchInfo): void {
    if (this.phase !== 'launching') return;
    if (ok) {
      this.gamePid = gamePid;
      this.phase = 'waiting-world';
      return;
    }
    if (error === 'account-not-found' || error === 'account-ambiguous') {
      const label = this.request?.accountLabel ?? '';
      const detail = accountMatch
        ? formatAccountMatchDetail(error, accountMatch.matchCount, accountMatch.totalAccounts, label)
        : error;
      this.requestStop(error, detail);
      return;
    }
    this.requestStop('launch-failed', error ?? 'launch failed');
  }

  /** waiting-world -> waiting-bridge, once admission reaches 'loaded'. Stamps
   *  `inWorldAtMs` — the moment the world was truly entered, independent of
   *  whether the native bridge ever connects afterward (a `never-in-world`
   *  run never gets here at all, so `hasEnteredWorld()` correctly stays
   *  false for that case, but a `native-not-connected` one does — the
   *  character really is standing in the world when that timeout fires). */
  enterWaitingBridge(now: number): void {
    if (this.phase !== 'waiting-world') return;
    this.inWorldAtMs = now;
    this.phase = 'waiting-bridge';
  }

  /**
   * waiting-bridge only: call on every poll with the current bridge-connected
   * boolean. Tracks the "both signals true" settle window (reset the instant
   * the bridge drops before it elapses) and the overall connect timeout
   * measured from `enterWaitingBridge`.
   *  - `'ready'`   the settle delay elapsed with the bridge continuously
   *                connected; phase stays at waiting-bridge — the caller
   *                transitions with `enterRunning()`.
   *  - `'timeout'` `timeoutMs` elapsed since entering the world without the
   *                settle condition ever being satisfied; transitions to
   *                stopping with reason `native-not-connected`.
   *  - `'waiting'` neither yet.
   */
  checkBridgeReady(now: number, bridgeConnected: boolean, settleMs: number, timeoutMs: number): 'waiting' | 'ready' | 'timeout' {
    if (this.phase !== 'waiting-bridge') return 'waiting';
    if (!bridgeConnected) {
      this.bridgeReadySinceMs = null;
    } else if (this.bridgeReadySinceMs == null) {
      this.bridgeReadySinceMs = now;
    }
    if (this.bridgeReadySinceMs != null && now - this.bridgeReadySinceMs >= settleMs) {
      return 'ready';
    }
    if (now - (this.inWorldAtMs ?? now) >= timeoutMs) {
      this.requestStop(
        'native-not-connected',
        `native bridge did not connect within ${Math.round(timeoutMs / 1000)}s of entering world`,
      );
      return 'timeout';
    }
    return 'waiting';
  }

  /** waiting-bridge -> running. Call only once `checkBridgeReady` has
   *  returned `'ready'`. No-op outside waiting-bridge. */
  enterRunning(): void {
    if (this.phase !== 'waiting-bridge') return;
    this.phase = 'running';
  }

  /** waiting-world only: true (and transitions to stopping) once `timeoutMs` has elapsed since `begin()`. */
  checkNeverInWorld(now: number, timeoutMs = 3 * 60_000): boolean {
    if (this.phase !== 'waiting-world') return false;
    if (now - this.startedAtMs < timeoutMs) return false;
    this.requestStop('never-in-world', `no admission "loaded" phase within ${Math.round(timeoutMs / 1000)}s`);
    return true;
  }

  /** running only: (re)arm the movement watchdog's baseline. Call once when
   *  the script (re)starts; `checkMovement` also calls this internally
   *  whenever it observes movement or performs the one allowed restart. */
  armMovementWatchdog(now: number, pos: WorldPosition | null): void {
    if (this.phase !== 'running') return;
    this.movementBaselineAtMs = now;
    this.movementBaselinePos = pos;
  }

  /**
   * running only: call on every poll with the current position. Once
   * `timeoutMs` has elapsed since the armed baseline with no movement
   * (`>= minTileDelta`) and no map change:
   *  - `'waiting'` the current window hasn't elapsed yet.
   *  - `'moved'`   movement/a map change was observed; baseline re-armed,
   *                restart budget refreshed.
   *  - `'restart'` the window elapsed with no movement and the one allowed
   *                restart hadn't been used yet; baseline re-armed at
   *                `now`/`pos` so the post-restart window starts fresh — the
   *                CALLER is responsible for actually restarting the script.
   *  - `'stopped'` the window elapsed with no movement after the restart was
   *                already used; transitions to stopping, reason `no-movement`.
   */
  checkMovement(
    now: number,
    pos: WorldPosition | null,
    timeoutMs: number,
    minTileDelta: number,
  ): 'waiting' | 'moved' | 'restart' | 'stopped' {
    if (this.phase !== 'running') return 'waiting';
    if (this.movementBaselineAtMs == null) {
      this.armMovementWatchdog(now, pos);
      return 'waiting';
    }
    if (hasMoved(this.movementBaselinePos, pos, minTileDelta)) {
      this.armMovementWatchdog(now, pos);
      this.movementRestartUsed = false;
      return 'moved';
    }
    if (now - this.movementBaselineAtMs < timeoutMs) return 'waiting';
    if (!this.movementRestartUsed) {
      this.movementRestartUsed = true;
      this.armMovementWatchdog(now, pos);
      return 'restart';
    }
    this.requestStop('no-movement', `no movement for ${Math.round(timeoutMs / 1000)}s after a restart`);
    return 'stopped';
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
   * waiting-world, waiting-bridge, or running: one more ABNORMAL reconnect
   * happened — the caller must filter out normal, server-driven map hops
   * (portal, Auto Nexus, a dungeon teleport) with `ReconnectClassifier`
   * before ever calling this. The count resets to zero first if
   * `RECONNECT_RESET_MS` of healthy play passed since the last one, so an
   * early blip is never held against an otherwise-long healthy run. Stops
   * once the count exceeds `stopOn.maxReconnects` (undefined = never stop on
   * this alone). Returns whether this call triggered a stop.
   */
  onReconnect(now: number): boolean {
    if (this.phase !== 'waiting-world' && this.phase !== 'waiting-bridge' && this.phase !== 'running') return false;
    if (this.lastReconnectAtMs != null && now - this.lastReconnectAtMs >= RECONNECT_RESET_MS) {
      this.reconnectCount = 0;
    }
    this.lastReconnectAtMs = now;
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
