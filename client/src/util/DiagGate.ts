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
 * `Logger.ts`'s own log file resolves to `join(tmpdir(), 'realm-engine-proxy.log')`.
 * This file assumed that directory is always RE_ASSETS in the portable build
 * (see CLAUDE.md's build procedure: "RE_ASSETS\realm-engine-proxy.log") and
 * computes its own, independent `join(tmpdir(), 'diag-timing.flag')` on that
 * belief. The 2026-09-19 Test Lab session measured that belief false for a
 * second independent `tmpdir()` caller in this same process (the recorder
 * plugin landed in the real Windows temp folder while `Logger.ts` landed
 * elsewhere) — see `Logger.ts`'s `loggerDirectory()` and
 * `recorderWriter.ts`'s header comment for the fix applied there. This file
 * was not touched by that fix (its `tmpdir()` call is a deliberate contract
 * with the native side's `GetTempPathW()`-based `DiagTiming.h`, not "beside
 * the client log"), but the same divergence risk applies here and is
 * unconfirmed either way — Proxy.ts's `TARGET_FILE` uses the same
 * `tmpdir()` convention for the same reason (talking to native code).
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
