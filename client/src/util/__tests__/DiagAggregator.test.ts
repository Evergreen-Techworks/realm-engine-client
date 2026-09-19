import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../Logger.js';
import { LatencyAggregator } from '../DiagAggregator.js';

// item 4b: the [Diag/Bridge] / [Diag/Loop] / [Diag/ScriptTick] channels all
// flush through this one aggregator. These tests cover the percentile math,
// the per-window flush cadence, and that an empty window logs nothing —
// the "off = no output" case for this piece (the caller-side DiagGate check
// is what keeps `record()` from ever being invoked when diagnostics are off;
// see DiagGate.test.ts).

describe('LatencyAggregator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes p50/p95/max on a sorted sample set and flushes once per window', () => {
    const logSpy = vi.spyOn(Logger, 'log').mockImplementation(() => {});
    const agg = new LatencyAggregator('Diag/Test', 5000);
    let t = 1000;
    // 1..10 ms, in a deliberately unsorted order.
    for (const ms of [5, 1, 9, 2, 8, 3, 7, 4, 10, 6]) {
      agg.record(ms, t);
    }
    // Still inside the window — no flush yet.
    expect(logSpy).not.toHaveBeenCalled();

    t += 5000; // window elapsed
    agg.record(1, t); // triggers the flush of the PREVIOUS window's 10 samples
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [tag, message] = logSpy.mock.calls[0];
    expect(tag).toBe('Diag/Test');
    // n=10, sorted [1..10]; p50 index = floor(0.5*9)=4 -> value 5; p95 index = floor(0.95*9)=8 -> value 9; max=10.
    expect(message).toBe('n=10 p50=5.0ms p95=9.0ms max=10.0ms');
  });

  it('does not log when a window has no samples', () => {
    const logSpy = vi.spyOn(Logger, 'log').mockImplementation(() => {});
    const agg = new LatencyAggregator('Diag/Empty', 5000);
    agg.flush(1000); // first call only seeds windowStart
    agg.flush(6000); // window elapsed, but nothing was ever recorded
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prepends optional context to the flush line', () => {
    const logSpy = vi.spyOn(Logger, 'log').mockImplementation(() => {});
    const agg = new LatencyAggregator('Diag/ScriptTick', 5000, () => 'id=farmer');
    agg.record(10, 0);
    agg.flush(5000);
    expect(logSpy).toHaveBeenCalledWith('Diag/ScriptTick', expect.stringMatching(/^id=farmer n=1 /));
  });
});
