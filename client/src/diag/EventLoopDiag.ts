import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { Logger } from '../util/Logger.js';
import { DiagGate } from '../util/DiagGate.js';
import { DiagContext } from '../util/DiagContext.js';
import { RateLimiter } from '../util/DiagRateLimit.js';

/**
 * EventLoopDiag — item 4b, part C. `perf_hooks.monitorEventLoopDelay` samples
 * the whole process's event-loop lag independent of any one packet or plugin;
 * if the owner's "delay leaking into the dodge" report is really Node-side
 * congestion (the architecture-map finding in
 * .superpowers/sdd/2026-09-18-process-stalls/investigation.md section 2 — one
 * process, one event loop, proxy/plugins/scripts/dashboard all sharing it),
 * this is the most direct measurement of it.
 *
 * Started/stopped by `pollEventLoopDiag()`, which the caller should invoke on
 * its own periodic timer (a couple of seconds is fine — DiagGate itself only
 * re-checks the flag file every 2s). Histogram + interval only exist while
 * the flag is on; off, this is a no-op DiagGate.on() check.
 */
const WINDOW_MS = 5000;
const SLOW_SAMPLE_MS = 100;
const slowLineLimiter = new RateLimiter(5, WINDOW_MS);

let histogram: IntervalHistogram | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function toMs(nsValue: number): number {
  return Number.isFinite(nsValue) ? nsValue / 1e6 : 0;
}

function flush(): void {
  if (!histogram) return;
  const p50 = toMs(histogram.percentile(50));
  const p99 = toMs(histogram.percentile(99));
  const max = toMs(histogram.max);
  histogram.reset();
  Logger.log('Diag/Loop', `p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`);
  if (max > SLOW_SAMPLE_MS && slowLineLimiter.allow()) {
    Logger.log('Diag/Loop', `sample max=${max.toFixed(1)}ms context=${DiagContext.current}`);
  }
}

function start(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  flushTimer = setInterval(flush, WINDOW_MS);
  flushTimer.unref?.();
}

function stop(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (histogram) {
    histogram.disable();
    histogram = null;
  }
}

/** Call periodically (every few seconds) from the app's own idle timer. */
export function pollEventLoopDiag(): void {
  if (DiagGate.on()) start();
  else stop();
}

/** Test-only. */
export function _stopEventLoopDiagForTests(): void {
  stop();
}
