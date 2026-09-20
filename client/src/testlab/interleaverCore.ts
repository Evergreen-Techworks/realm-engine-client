/**
 * Test Lab A/B switch interleaver — pure core.
 *
 * TESTLAB_PRIVATE_ONLY: this file is listed in `client/private-only.json` and
 * must be deletable from customer builds. It imports nothing from `fs`,
 * `os`, `PluginContext`, timers, or the DLL/dashboard — every external fact
 * (the current wall-clock time, the switch's pre-flip value) is passed in by
 * the caller (the thin plugin, `plugins/testlab-interleaver.ts`), and every
 * effect (applying a value, writing a mark, logging) is left to that caller.
 * That split is what makes this file runnable under `vitest` with plain
 * numbers instead of a live proxy/dashboard session.
 *
 * Purpose: one dodge switch is flipped between two values every few minutes
 * during a play session, so hits can be attributed to whichever arm (A or B)
 * was active at the time — see the recorder's `arm` record
 * (`src/testlab/recorderCore.ts`'s `ArmRecord`), which this plugin writes to
 * via `mark()`.
 */

/**
 * Survives compilation on purpose: a future release-pipeline step greps the
 * *built* output for this exact string and refuses to ship a build where the
 * Test Lab A/B interleaver is still present (see client/private-only.json).
 * Each private-only file defines its own copy (not a re-export) so none of
 * them can be tree-shaken as unreachable dead code independently of the
 * others — same convention as recorderCore.ts / recorderWriter.ts.
 */
export const TESTLAB_PRIVATE_ONLY = 'TESTLAB_PRIVATE_ONLY';

/** See {@link TESTLAB_PRIVATE_ONLY}. */
export function interleaverCoreMarker(): string {
  return TESTLAB_PRIVATE_ONLY;
}

export type Arm = 'A' | 'B';

/** A setting's live value, as read/written through the cross-plugin hooks
 *  (`PluginContext.getOtherPluginSetting` / `updateOtherPluginSetting`). */
export type SettingValue = string | number | boolean;

/**
 * How long to wait after flipping `dodgeMode` before writing the arm mark,
 * so the mark's timestamp reflects when the new dodge engine is actually
 * live rather than the instant the setting was written. Only `dodgeMode`
 * flips get this treatment — see `applyFlip` in the thin plugin. Exported so
 * the plugin and its tests share one number.
 */
export const SETTLE_MS = 2000;

/** idle: never started (or fully restored). running: actively flipping on a
 *  schedule. restoring: `stop()` has computed the value to restore but the
 *  caller hasn't yet confirmed it applied that side effect (`finishStop()`). */
export type InterleaverPhase = 'idle' | 'running' | 'restoring';

/**
 * mulberry32 — small, fast, deterministic 32-bit PRNG. Same seed -> the same
 * sequence forever, which is the point: the seed is logged (`ab.start`'s
 * mark and the `[TestLabAB] ... seed=<seed>` log line) so a schedule can be
 * reproduced from the log alone.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates `count` arms as randomized AB/BA pairs: each pair is
 * independently drawn from the seeded PRNG (< 0.5 -> ['A','B'], else
 * ['B','A']). Properties this guarantees, for any seed:
 *  - any EVEN-length prefix has an exactly equal A/B split (each pair
 *    contributes exactly one of each, regardless of orientation).
 *  - no run of the same arm ever exceeds 2: a pair never repeats internally
 *    (AB and BA both alternate), so the only possible repeat is the last arm
 *    of one pair matching the first arm of the next pair — at most one extra
 *    repetition, never two.
 * Deterministic and prefix-stable: `generateSchedule(seed, n)` is always a
 * prefix of `generateSchedule(seed, m)` for `m > n`, since both draw from a
 * fresh `mulberry32(seed)` and consume draws in the same order regardless of
 * `count` (an odd `count` simply stops mid-pair, without affecting earlier
 * arms).
 */
export function generateSchedule(seed: number, count: number): Arm[] {
  const rand = mulberry32(seed);
  const arms: Arm[] = [];
  while (arms.length < count) {
    const pair: Arm[] = rand() < 0.5 ? ['A', 'B'] : ['B', 'A'];
    for (const arm of pair) {
      if (arms.length >= count) break;
      arms.push(arm);
    }
  }
  return arms;
}

/**
 * Which block index `now` falls in, given a start time and block length.
 * Clamps to block 0 for a `now` before `startTime` (clock skew / the very
 * first call) rather than returning a negative index.
 */
export function blockIndexFor(startTime: number, blockMinutes: number, now: number): number {
  const blockMs = Math.max(1, blockMinutes) * 60_000;
  const elapsed = Math.max(0, now - startTime);
  return Math.floor(elapsed / blockMs);
}

export interface InterleaverConfig {
  /** The Auto Dodge setting key being interleaved, e.g. 'udodgeEnemyStandoff'
   *  or 'dodgeMode' itself. */
  key: string;
  valueA: SettingValue;
  valueB: SettingValue;
  /** Minutes per block; the caller is responsible for clamping to >= 1. */
  blockMinutes: number;
  /** Recording start time, used to seed the schedule PRNG. Log it. */
  seed: number;
}

export interface StartResult {
  ok: true;
  arm: Arm;
  value: SettingValue;
  block: number;
}

export interface StartRefusal {
  ok: false;
  reason: string;
}

export type StartOutcome = StartResult | StartRefusal;

export interface FlipEvent {
  arm: Arm;
  value: SettingValue;
  block: number;
}

export interface RestoreEvent {
  value: SettingValue;
}

/**
 * idle -> running -> restoring -> idle. Holds no timers and touches nothing
 * outside its own fields — the caller drives time via `now` and applies the
 * `value` each method hands back through its own settings-path / mark / log
 * calls (this class only decides *when* and *what*, never *how*).
 */
export class InterleaverStateMachine {
  private phase: InterleaverPhase = 'idle';
  private startTime = 0;
  private currentBlock = -1;
  private originalValue: SettingValue | null = null;
  private schedule: Arm[] = [];

  constructor(private readonly config: InterleaverConfig) {}

  getPhase(): InterleaverPhase {
    return this.phase;
  }

  /**
   * Begin the schedule. Refuses (returns `ok:false`, no state change) when
   * `valueA === valueB` (nothing to compare) or a run is already in
   * progress. `currentValue` is captured as the value to restore on stop.
   */
  start(now: number, currentValue: SettingValue): StartOutcome {
    if (this.phase !== 'idle') {
      return { ok: false, reason: 'already running' };
    }
    if (this.config.valueA === this.config.valueB) {
      return { ok: false, reason: 'valueA equals valueB' };
    }
    this.originalValue = currentValue;
    this.startTime = now;
    this.currentBlock = 0;
    this.phase = 'running';
    const arm = this.armForBlock(0);
    return { ok: true, arm, value: this.valueForArm(arm), block: 0 };
  }

  /**
   * Call periodically with the current time. Returns a {@link FlipEvent}
   * only when the block boundary has actually been crossed since `start()`
   * or the last flip — a no-op call (same block, or not running) returns
   * `null` and changes nothing.
   */
  tick(now: number): FlipEvent | null {
    if (this.phase !== 'running') return null;
    const block = blockIndexFor(this.startTime, this.config.blockMinutes, now);
    if (block === this.currentBlock) return null;
    this.currentBlock = block;
    const arm = this.armForBlock(block);
    return { arm, value: this.valueForArm(arm), block };
  }

  /**
   * Safe to call from ANY phase (idle, running, or an already-pending
   * restore) — never throws. Returns `null` when there is nothing to
   * restore (never started, or a previous `stop()` already consumed the
   * captured value). Otherwise moves to `restoring` and hands back the
   * value to restore; call {@link finishStop} once that value has actually
   * been applied.
   */
  stop(): RestoreEvent | null {
    if (this.originalValue === null) {
      this.phase = 'idle';
      return null;
    }
    const value = this.originalValue;
    this.originalValue = null;
    this.phase = 'restoring';
    return { value };
  }

  /** Confirms the restore side effect from `stop()` was applied. Idempotent. */
  finishStop(): void {
    this.phase = 'idle';
  }

  private armForBlock(block: number): Arm {
    if (block >= this.schedule.length) {
      this.schedule = generateSchedule(this.config.seed, block + 1);
    }
    return this.schedule[block];
  }

  private valueForArm(arm: Arm): SettingValue {
    return arm === 'A' ? this.config.valueA : this.config.valueB;
  }
}

// ── Free-text target validation (ANY Auto Dodge setting, incl. dodgeMode) ──
//
// The thin plugin no longer hardcodes which switches can be A/B'd. Instead it
// reads a live setting's shape through the general cross-plugin "describe"
// hook (`PluginContext.describeOtherPluginSetting`) and hands the result to
// the pure functions below, which do the actual refuse-or-coerce decision so
// it stays unit-testable against a fake description (no live plugin needed).

/**
 * Minimal shape of a live setting's definition, as returned by
 * `describeOtherPluginSetting`. Deliberately structurally compatible with
 * `SettingDef`/`SettingOption` (a superset) so the thin plugin can pass what
 * that hook returns straight through without remapping.
 */
export interface SettingDescription {
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  options?: { value: string }[];
  min?: number;
  max?: number;
  /** Same shape `SettingDef.visibleWhen` uses for dashboard rendering: this
   *  setting only applies when another setting (usually `dodgeMode`) has one
   *  of these values. Absent means always active — e.g. `dodgeMode` itself
   *  has no `visibleWhen`, so it is always a legal target. */
  visibleWhen?: { key: string; value?: unknown; values?: unknown[] };
}

export interface CoerceOk {
  ok: true;
  value: SettingValue;
}
export interface CoerceRefusal {
  ok: false;
  reason: string;
}
export type CoerceOutcome = CoerceOk | CoerceRefusal;

/**
 * Coerces a raw string request value (as arrives in a per-run plugin config
 * or a dashboard text field) to the type `description` declares, validating
 * legality along the way: a `select` value must be one of the registered
 * options, a `number`/`range` value must parse and fall within `min`/`max`,
 * and a `boolean` value must be the literal string "true" or "false" (never
 * JS truthiness — `Boolean("false")` is `true`, which would silently invert
 * the request). `text` accepts anything. `button` can't hold a value at all.
 */
export function coerceSettingValue(description: SettingDescription, raw: string, label: string): CoerceOutcome {
  switch (description.type) {
    case 'select': {
      const legal = (description.options ?? []).map((o) => o.value);
      if (!legal.includes(raw)) {
        return {
          ok: false,
          reason: `${label} "${raw}" is not a legal value (expected one of: ${legal.join(', ') || '(none registered)'}).`,
        };
      }
      return { ok: true, value: raw };
    }
    case 'text':
      return { ok: true, value: raw };
    case 'number':
    case 'range': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: `${label} "${raw}" is not a number.` };
      if (description.min !== undefined && n < description.min) {
        return { ok: false, reason: `${label} ${n} is below the minimum (${description.min}).` };
      }
      if (description.max !== undefined && n > description.max) {
        return { ok: false, reason: `${label} ${n} is above the maximum (${description.max}).` };
      }
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, reason: `${label} "${raw}" is not "true" or "false".` };
    }
    case 'button':
    default:
      return { ok: false, reason: 'That setting is a button, not a value that can be A/B\'d.' };
  }
}

/**
 * Whether `description`'s setting is even active given the live value of the
 * OTHER setting it is gated on (`visibleWhen.key`, usually `dodgeMode`) —
 * mirrors the dashboard's own `visibleWhen` rendering rule exactly. A setting
 * with no `visibleWhen` (e.g. `dodgeMode` itself) is always active, in any
 * mode — the "unless the target IS dodgeMode, which is always allowed" rule
 * falls out of this for free, since `dodgeMode`'s own definition never
 * carries a `visibleWhen`.
 */
export function isTargetGateSatisfied(description: SettingDescription, gatingValue: unknown): boolean {
  const gate = description.visibleWhen;
  if (!gate) return true;
  const allowed = gate.values ?? (gate.value !== undefined ? [gate.value] : undefined);
  if (!allowed) return true;
  return allowed.includes(gatingValue);
}

export interface TargetValidationInput {
  targetKey: string;
  /** `undefined` when the key does not exist on the live plugin. */
  description: SettingDescription | undefined;
  rawValueA: string;
  rawValueB: string;
  /** Current live value of `description.visibleWhen.key`, read by the caller
   *  through the same cross-plugin hook. Ignored when there is no gate. */
  gatingValue?: unknown;
}

export interface TargetValidationOk {
  ok: true;
  valueA: SettingValue;
  valueB: SettingValue;
}
export interface TargetValidationRefusal {
  ok: false;
  reason: string;
}
export type TargetValidationOutcome = TargetValidationOk | TargetValidationRefusal;

/**
 * The full refuse-to-start decision for a free-text target: unknown key,
 * mode-gated-out, illegal/out-of-range value, or A === B. Pure and
 * synchronous — the caller resolves `description`/`gatingValue` from the live
 * plugin first (dashboard + log-worthy side effects stay in the thin plugin).
 */
export function validateTarget(input: TargetValidationInput): TargetValidationOutcome {
  const { targetKey, description, rawValueA, rawValueB, gatingValue } = input;
  if (!description) {
    return { ok: false, reason: `Unknown Auto Dodge setting "${targetKey}".` };
  }
  if (!isTargetGateSatisfied(description, gatingValue)) {
    const gate = description.visibleWhen!;
    const allowed = gate.values ?? (gate.value !== undefined ? [gate.value] : []);
    return {
      ok: false,
      reason: `"${targetKey}" only applies when ${gate.key}=${allowed.join('/')} (currently "${String(gatingValue ?? 'unknown')}").`,
    };
  }
  const a = coerceSettingValue(description, rawValueA, 'Value A');
  if (!a.ok) return a;
  const b = coerceSettingValue(description, rawValueB, 'Value B');
  if (!b.ok) return b;
  if (a.value === b.value) {
    return { ok: false, reason: `Value A and Value B are both "${rawValueA}" — nothing to compare.` };
  }
  return { ok: true, valueA: a.value, valueB: b.value };
}
