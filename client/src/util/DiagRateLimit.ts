/**
 * RateLimiter — caps how many times a one-off diagnostic line may be emitted
 * within a rolling window. Item 4b / ground-rule F: new [Diag/*] lines must
 * stay to "at most a handful per 5s" even when the condition they report on
 * (e.g. a >100ms bridge command) fires far more often than that — the
 * periodic p50/p95/max summary line already covers the aggregate, so the
 * per-event lines only need to sample, not enumerate.
 */
export class RateLimiter {
  private count = 0;
  private windowStart = 0;

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Returns true if this event may be logged, false if it should be dropped. */
  allow(now: number = Date.now()): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }
}
