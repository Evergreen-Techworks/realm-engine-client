import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * DiagGate — client-side mirror of the native DiagTiming flag (item 4b,
 * measurement only). The DLL turns its own [Diag/*] instrumentation on/off by
 * polling for `diag-timing.flag` next to its trace log every 2s
 * (internal/src/core/logging/DiagTiming.h). The client needs the same signal
 * so its own [Diag/Bridge] / [Diag/Loop] / [Diag/ScriptTick] / [Diag/Nexus]
 * lines share one on/off switch with no new dashboard setting.
 *
 * `Logger.ts`'s own log file resolves to `join(tmpdir(), 'realm-engine-proxy.log')`
 * — in the portable build this directory IS RE_ASSETS (see CLAUDE.md's build
 * procedure: "RE_ASSETS\realm-engine-proxy.log"). So checking
 * `join(tmpdir(), 'diag-timing.flag')` is the same "same folder as the trace
 * log" rule DiagTiming.h uses, expressed with the path helper this codebase
 * already relies on for that resolution (see Proxy.ts's TARGET_FILE).
 *
 * Cost when off: one `Date.now()` comparison per call; the filesystem is only
 * touched at most once every POLL_MS.
 */
const FLAG_PATH = join(tmpdir(), 'diag-timing.flag');
const POLL_MS = 2000;

let cachedOn = false;
let nextCheckAt = 0;

export const DiagGate = {
  on(): boolean {
    const now = Date.now();
    if (now >= nextCheckAt) {
      nextCheckAt = now + POLL_MS;
      try {
        cachedOn = existsSync(FLAG_PATH);
      } catch {
        cachedOn = false;
      }
    }
    return cachedOn;
  },

  /** Test-only: force the next `on()` call to re-check the filesystem. */
  _resetPollForTests(): void {
    nextCheckAt = 0;
  },
};
