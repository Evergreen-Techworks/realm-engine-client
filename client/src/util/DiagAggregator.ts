import { Logger } from './Logger.js';

/**
 * LatencyAggregator — count/p50/p95/max over a rolling window, flushed as one
 * `Logger.log` line per window. Used by item 4b's [Diag/Bridge], [Diag/Loop]
 * and [Diag/ScriptTick] channels so each stays to one summary line per 5s
 * regardless of how many samples were recorded (ground-rule F).
 */
export class LatencyAggregator {
  private samples: number[] = [];
  private windowStart = 0;

  constructor(
    private readonly tag: string,
    private readonly windowMs: number = 5000,
    /** Optional extra context prepended to each flush line, e.g. `id=farmer`. */
    private readonly context?: () => string,
  ) {}

  record(ms: number, now: number = Date.now()): void {
    // Flush the PRIOR window first if it has elapsed, so this sample starts
    // the next window rather than being folded into the one just closed.
    this.maybeFlush(now);
    this.samples.push(ms);
  }

  /** Force a flush regardless of window age — used by tests. */
  flush(now: number = Date.now()): void {
    this.maybeFlush(now, true);
  }

  private maybeFlush(now: number, force = false): void {
    if (this.windowStart === 0) this.windowStart = now;
    if (!force && now - this.windowStart < this.windowMs) return;
    this.windowStart = now;
    if (this.samples.length === 0) return;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    this.samples = [];
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const prefix = this.context ? `${this.context()} ` : '';
    Logger.log(
      this.tag,
      `${prefix}n=${sorted.length} p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms`,
    );
  }
}
