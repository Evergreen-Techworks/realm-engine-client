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
  /** The Auto Dodge setting key being interleaved, e.g. 'udodgeEnemyStandoff'. */
  key: string;
  valueA: string;
  valueB: string;
  /** Minutes per block; the caller is responsible for clamping to >= 1. */
  blockMinutes: number;
  /** Recording start time, used to seed the schedule PRNG. Log it. */
  seed: number;
}

export interface StartResult {
  ok: true;
  arm: Arm;
  value: string;
  block: number;
}

export interface StartRefusal {
  ok: false;
  reason: string;
}

export type StartOutcome = StartResult | StartRefusal;

export interface FlipEvent {
  arm: Arm;
  value: string;
  block: number;
}

export interface RestoreEvent {
  value: string;
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
  private originalValue: string | null = null;
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
  start(now: number, currentValue: string): StartOutcome {
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

  private valueForArm(arm: Arm): string {
    return arm === 'A' ? this.config.valueA : this.config.valueB;
  }
}
