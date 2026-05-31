/**
 * Anti-hook detection for the Node.js proxy process.
 *
 * "Hooking" in a Node.js context means replacing (monkey-patching) a
 * function on a built-in module or prototype so that attacker code runs
 * whenever the application calls that function.  Common targets are:
 *
 *   - fs.readFileSync / fs.writeFileSync  (intercept file I/O)
 *   - crypto.createHash / randomBytes     (intercept hashing / key gen)
 *   - process.exit                        (prevent shutdown)
 *   - Module._load / _resolveFilename     (intercept require() calls)
 *   - Function.prototype.toString         (hide the hook itself)
 *
 * Strategy
 * ────────
 *  1. At the earliest possible point in startup, `captureBaseline()` records
 *     the exact `Function.prototype.toString()` output of every critical
 *     function.  For truly native functions this will be `function X() {
 *     [native code] }`; for JS wrappers it will be the full source text.
 *  2. On every subsequent call to `detect()` the current toString output is
 *     compared against the snapshot.  Any deviation means the function body
 *     has been replaced.
 *  3. Additional structural checks verify prototype chain integrity and the
 *     Module extension/hook tables.
 *
 * Limitations
 * ───────────
 *  - An attacker who patches things *before* `captureBaseline()` runs will
 *    not be caught by the snapshot comparison.  Calling this as the very
 *    first import in main.cjs / index.ts mitigates this.
 *  - Proxied functions (ES6 Proxy) will pass toString checks.  The timing
 *    probe in AntiDebug covers that vector indirectly.
 */

import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

// createRequire lets us reach CommonJS-only internals (Module._load etc.)
// from an ES-module file without using the bare require() syntax.
const _require = createRequire(import.meta.url);

export interface HookDetectionResult {
  hooked: boolean;
  targets: string[];
}

interface CapturedFunction {
  name: string;
  toStringResult: string;
  ref: Function;
}

export class AntiHook {
  private static readonly baseline: Map<string, string> = new Map();
  private static initialized = false;

  // ─── Baseline capture ─────────────────────────────────────────────────────

  /**
   * Snapshot the toString() output of every critical function.
   * Call this as early as possible — before any third-party code runs.
   */
  static captureBaseline(): void {
    if (AntiHook.initialized) return;
    AntiHook.initialized = true;

    for (const entry of AntiHook.getCriticalFunctions()) {
      try {
        const result = Function.prototype.toString.call(entry.ref);
        AntiHook.baseline.set(entry.name, result);
      } catch {
        AntiHook.baseline.set(entry.name, '__capture_failed__');
      }
    }
  }

  // ─── Detection ────────────────────────────────────────────────────────────

  /**
   * Compare current function identities against the captured baseline.
   * Returns every name whose body has changed since `captureBaseline()`.
   */
  static detect(): HookDetectionResult {
    if (!AntiHook.initialized) {
      // If baseline was never captured the check is meaningless — treat as
      // clean but schedule a capture so the next call works.
      AntiHook.captureBaseline();
      return { hooked: false, targets: [] };
    }

    const hooked: string[] = [];

    // 1. Snapshot comparison
    for (const entry of AntiHook.getCriticalFunctions()) {
      const baseline = AntiHook.baseline.get(entry.name);
      if (baseline === '__capture_failed__' || baseline === undefined) continue;

      try {
        const current = Function.prototype.toString.call(entry.ref);
        if (current !== baseline) {
          hooked.push(entry.name);
        }
      } catch {
        hooked.push(`${entry.name} (toString threw)`);
      }
    }

    // 2. Verify Function.prototype.toString itself is still native.
    //    If an attacker hooked toString to hide their hooks, this check fires.
    if (!AntiHook.isNative(Function.prototype.toString)) {
      hooked.push('Function.prototype.toString');
    }

    // 3. Verify Object.prototype methods are untouched.
    if (!AntiHook.isNative(Object.prototype.hasOwnProperty)) {
      hooked.push('Object.prototype.hasOwnProperty');
    }
    if (!AntiHook.isNative(Object.defineProperty)) {
      hooked.push('Object.defineProperty');
    }

    // 4. Check Module loader tables for injected hooks.
    const moduleHookIssue = AntiHook.checkModuleHooks();
    if (moduleHookIssue) hooked.push(moduleHookIssue);

    return { hooked: hooked.length > 0, targets: hooked };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private static isNative(fn: Function): boolean {
    try {
      return Function.prototype.toString.call(fn).includes('[native code]');
    } catch {
      return false;
    }
  }

  /**
   * Check the Node.js Module extension table for unexpected entries.
   * The default table should only contain handlers for .js, .json, .node
   * (and possibly .cjs / .mjs in newer Node versions).
   * Additional entries indicate a --require hook or monkey-patch.
   */
  private static checkModuleHooks(): string | null {
    try {
      const Module = _require('module') as {
        _extensions: Record<string, unknown>;
      };
      const KNOWN_EXTENSIONS = new Set(['.js', '.json', '.node', '.cjs', '.mjs']);
      const extras = Object.keys(Module._extensions).filter(
        ext => !KNOWN_EXTENSIONS.has(ext)
      );
      if (extras.length > 0) {
        return `Module._extensions has unexpected entries: ${extras.join(', ')}`;
      }
    } catch {
      // Safe to ignore.
    }
    return null;
  }

  /**
   * Build the list of critical functions to monitor.
   * The list is intentionally kept narrow — too many entries increase
   * the cost of periodic checks without improving coverage.
   */
  private static getCriticalFunctions(): CapturedFunction[] {
    const Module = _require('module') as {
      _load: Function;
      _resolveFilename: Function;
    };

    const candidates: Array<{ name: string; fn: unknown }> = [
      // Process primitives (truly native — [native code] expected)
      { name: 'process.exit',              fn: process.exit },
      { name: 'process.binding',           fn: (process as any).binding },
      { name: 'process.dlopen',            fn: (process as any).dlopen },

      // Buffer (native)
      { name: 'Buffer.from',              fn: Buffer.from },
      { name: 'Buffer.allocUnsafe',       fn: Buffer.allocUnsafe },

      // Crypto (native bindings exposed as JS)
      { name: 'crypto.createHash',        fn: crypto.createHash },
      { name: 'crypto.createHmac',        fn: crypto.createHmac },
      { name: 'crypto.randomBytes',       fn: crypto.randomBytes },

      // fs (JS wrappers — snapshot text; any change = tamper)
      { name: 'fs.readFileSync',          fn: fs.readFileSync },
      { name: 'fs.writeFileSync',         fn: fs.writeFileSync },
      { name: 'fs.existsSync',            fn: fs.existsSync },
      { name: 'fs.readdirSync',           fn: fs.readdirSync },

      // Module loader
      { name: 'Module._load',             fn: Module._load },
      { name: 'Module._resolveFilename',  fn: Module._resolveFilename },
    ];

    return candidates
      .filter((c): c is { name: string; fn: Function } => typeof c.fn === 'function')
      .map(c => ({ name: c.name, toStringResult: '', ref: c.fn }));
  }
}
