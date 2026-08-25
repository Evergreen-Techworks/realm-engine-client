# 97 — Make the DLL↔client wire-format tests actually run

## Goal

After this plan, `npm test` in `client/` executes the existing round-trip tests
for the two compact IPC wire payloads (threats and aim), those tests are part of
`npx tsc --noEmit`'s coverage, and CI fails when either side of the wire format
drifts. Today those test files exist, are correct, and have **never executed
once** — `vitest` is not installed anywhere in the repository, `client/package.json`
has no `test` script, and `client/tsconfig.json` explicitly excludes the test
directory. This plan turns four dead files into the guardrail they were written
to be, and adds the missing fixtures that pin the C++ encoder's exact output.

**This is a TypeScript-only plan.** It never builds the C++ DLL and is
parallel-safe against every C++ plan.

## Dependencies

None — parallel-safe.

Files this plan touches that other plans also touch:
- `client/package.json` — no other plan touches it.
- `client/tsconfig.json` — no other plan touches it.
- `client/src/bridge/__tests__/**` — no other plan touches it.
- `.github/workflows/ci.yml` — no other plan touches it.
- It **reads but does not modify** `client/src/bridge/contract.ts` (plans 98 and
  99 modify that file). No conflict.

## Current state

### The tests exist and are unrunnable

```
client/src/bridge/__tests__/aimPayload.roundtrip.test.ts       (imports 'vitest')
client/src/bridge/__tests__/threatPayload.roundtrip.test.ts    (imports 'vitest')
client/packages/protocol/src/__tests__/hello-roundtrip.test.ts (imports 'vitest')
client/packages/protocol/src/__tests__/shootack-roundtrip.test.ts
```

Evidence that none of them can run:

1. `client/package.json` — the `scripts` block (lines 7–24) has `start`, `dev`,
   `dev:wsl`, `electron`, `build:sdk`, `build`, `build:native`, `build:prod`,
   `build:admin`, `download-game-xml`, `dist*`, `installer:*`. **There is no
   `test` script.** `devDependencies` (lines 36–46) lists
   `@types/node`, `@types/ws`, `electron`, `electron-builder`, `esbuild`,
   `javascript-obfuscator`, `node-gyp`, `tsx`, `typescript`. **`vitest` is
   absent.**
2. `client/packages/protocol/package.json:17` declares `"test": "vitest run"`
   and `client/packages/core/package.json:21` declares
   `"test": "vitest run --passWithNoTests"`, but neither package lists `vitest`
   as a dependency and there is no `vitest` binary under
   `client/node_modules/.bin/` (only `esbuild` and `tsc`).
3. `client/tsconfig.json:16` —
   `"exclude": ["node_modules", "dist", "src/**/__tests__/**"]`. The bridge
   tests are excluded from the typecheck, so even a syntax error in them is
   invisible.
4. `.github/workflows/ci.yml` has exactly one job, `locale-guard`, which greps
   for three localized-string anti-patterns. It runs no tests and no typecheck.
   Its header comment (lines 15–19) claims the client has "~135 pre-existing
   errors"; that is **stale** — `npx tsc --noEmit -p tsconfig.json` from
   `client/` currently exits 0 with no output.

### What the tests protect

`client/src/bridge/__tests__/aimPayload.roundtrip.test.ts` pins the aim payload
to exactly 11 `;`-separated tokens in a fixed order, rejects a wrong version
token, rejects 10- and 12-token payloads, rejects `nan`/`inf` in any float slot,
and rejects a non-integer `targetId`/`stamp`. Its C++ counterpart is
`IpcMessages::EncodeAim` (`internal/src/core/ipc/IpcMessages.cpp:125-137`):

```cpp
// internal/src/core/ipc/IpcMessages.cpp:129-134
const int wrote = snprintf(out, static_cast<size_t>(outSize),
    "%d;%d;%d;%d;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%u",
    AIM_SCHEMA_VERSION, (int)a.armed, (int)a.mode, a.targetId,
    (double)a.tx, (double)a.ty, (double)a.px, (double)a.py,
    (double)a.standoffTiles, (double)a.maxOffsetTiles, a.stampMs);
```

and the decoder is `decodeAimPayload` (`client/src/bridge/DllAimBus.ts:77-120`).

`threatPayload.roundtrip.test.ts` covers `IpcMessages::EncodeThreats`
(`IpcMessages.cpp:64-118`) ↔ `decodeThreatPayload`
(`client/src/bridge/DllThreatBus.ts:91-153`).

A drift in either is a **silent** runtime bug: the aim decoder returns `null`
(killaura stops rewriting shot origins with no error the user sees), the threat
decoder returns an empty list (auto-nexus quietly degrades to server-confirmed
damage only).

## Target design

Add a single `vitest` runner at `client/` that discovers tests across `src/` and
`packages/`, wire it into `package.json`, stop excluding tests from the
typecheck, and add fixtures that pin the *exact byte output* of the two C++
encoders.

### Files to create

`client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// One runner for the whole client workspace. `packages/*` have their own
// `test` scripts but no runner of their own; including them here means a
// single `npm test` covers every wire-format guardrail in the repo.
export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    // Node ESM + our `.js` import specifiers on `.ts` sources.
    // vitest resolves these through its own transform pipeline.
  },
});
```

`client/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*", "plugins/**/*", "src/**/__tests__/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `package.json` changes

Add to `devDependencies`: `"vitest": "^2.1.9"` (pin a 2.x; 3.x changes the
config surface and this repo is on Node 20 types).

Add to `scripts`:

```json
"test": "vitest run",
"typecheck": "tsc --noEmit -p tsconfig.json",
"typecheck:tests": "tsc --noEmit -p tsconfig.test.json"
```

### Ownership / threading / caching

None — this is build tooling. No runtime code changes at all.

### Divergence warning

`client/tsconfig.json` must keep excluding `src/**/__tests__/**` (the production
`tsc` build emits into `dist/` and must not emit test files). The new
`tsconfig.test.json` is the one that *includes* them, and it is `noEmit`. Do
**not** delete the exclude from `tsconfig.json`.

## Steps

1. **Install the runner.** From `client/`:
   ```bash
   npm install --save-dev vitest@^2.1.9
   ```
   Verify: `ls node_modules/.bin/ | grep vitest` prints `vitest`.

2. **Create `client/vitest.config.ts`** with the content above.
   Verify: `npx vitest --version` prints a version (does not error on config).

3. **Add the scripts to `client/package.json`** (`test`, `typecheck`,
   `typecheck:tests`) exactly as specified above. Do not reorder or remove any
   existing script.
   Verify:
   ```bash
   cd client && npm test
   ```
   Expect all four existing test files to be discovered and to **pass**. If any
   fails, STOP and report — a failure here means the encoder/decoder already
   disagree and that is a real bug, not a test-harness problem. Do not "fix" a
   test to make it pass.

4. **Create `client/tsconfig.test.json`** with the content above.
   Verify:
   ```bash
   cd client && npx tsc --noEmit -p tsconfig.test.json
   ```
   Expect exit 0. If `vitest/globals` types are missing, the tests use explicit
   `import { describe, it, expect } from 'vitest'` (they do), so you may drop
   `"vitest/globals"` from `types` and keep just `["node"]`.

5. **Add the exact-encoder fixtures.** Append to
   `client/src/bridge/__tests__/aimPayload.roundtrip.test.ts` a describe block
   that pins the C++ `snprintf` formatting, because the decoder's token-count
   check cannot catch a format-width change:

   ```ts
   // These strings are what `snprintf("%d;%d;%d;%d;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%u", ...)`
   // at internal/src/core/ipc/IpcMessages.cpp:129-134 emits for the given
   // IpcAim values. If the C++ format string changes, update BOTH sides.
   describe('EncodeAim C++ output fixtures', () => {
     it('decodes the exact bytes EncodeAim emits for a disarmed aim', () => {
       // IpcAim{} default-constructed, stampMs = 0
       expect(decodeAimPayload('1;0;0;0;0.000;0.000;0.000;0.000;0.000;0.000;0'))
         .toEqual({
           armed: false, mode: 0, targetId: 0,
           tx: 0, ty: 0, px: 0, py: 0,
           standoffTiles: 0, maxOffsetTiles: 0, stamp: 0,
         });
     });

     it('decodes the exact bytes EncodeAim emits at KillAura defaults', () => {
       // standoff 0.35 (KillAura.cpp:25), maxOffset 12 (KillAura.cpp:26),
       // both printed with %.3f.
       const aim = decodeAimPayload(
         '1;1;0;99;41.250;13.750;40.900;13.750;0.350;12.000;4294967295');
       expect(aim).not.toBeNull();
       expect(aim!.standoffTiles).toBe(0.35);
       expect(aim!.maxOffsetTiles).toBe(12);
       expect(aim!.stamp).toBe(4294967295); // uint32 max — %u, not %d
     });
   });
   ```

   Verify: `cd client && npm test` — all green.

6. **Add a threat fixture for the ground-segment quirk.** Append to
   `client/src/bridge/__tests__/threatPayload.roundtrip.test.ts`:

   ```ts
   // EncodeThreats (IpcMessages.cpp:76-99) always writes a LEADING ground
   // summary segment "<rawDamage>:<tHitMs>" before the per-event "|d:t" list,
   // and decodeThreatPayload deliberately SKIPS index 0 (DllThreatBus.ts:118
   // starts the loop at i = 1). This fixture pins that asymmetry: it is the
   // single easiest place for the two sides to silently disagree.
   describe('EncodeThreats ground-segment layout', () => {
     it('ignores the leading summary segment and reads events from index 1', () => {
       // ground.rawDamage = 500, ground.tHitMs = 250.0, one event {300, 180.0}
       const r = decodeThreatPayload('1;500:250.0|300:180.0;;0');
       expect(r.ground.events).toEqual([{ rawDamage: 300, tHitMs: 180 }]);
       expect(r.ground.rawDamage).toBe(300);   // taken from the FIRST EVENT
       expect(r.ground.tHitMs).toBe(180);
       expect(r.threats).toEqual([]);
       expect(r.truncated).toBe(false);
     });

     it('reports truncated from the trailing flag', () => {
       expect(decodeThreatPayload('1;0:-1.0;;1').truncated).toBe(true);
     });
   });
   ```

   Verify: `cd client && npm test` — all green. If the first fixture fails,
   read `DllThreatBus.ts:117-130` and `IpcMessages.cpp:76-99` side by side and
   report the actual disagreement rather than adjusting the fixture.

7. **Wire into CI.** In `.github/workflows/ci.yml`, add a job alongside
   `locale-guard`:

   ```yaml
   client-checks:
     name: Client typecheck + bridge wire-format tests
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - uses: actions/setup-node@v4
         with:
           node-version: '20'
       - name: Install client deps
         working-directory: client
         run: npm ci --ignore-scripts
       - name: Typecheck
         working-directory: client
         run: npx tsc --noEmit -p tsconfig.json
       - name: Bridge wire-format tests
         working-directory: client
         run: npm test
   ```

   Also update the stale header comment at `.github/workflows/ci.yml:15-19`:
   the "~135 pre-existing errors" claim is no longer true; replace that bullet
   with a note that the typecheck now runs. Leave the other "does NOT cover"
   bullets alone.

   Note `--ignore-scripts`: `sharp` and the native addon have postinstall steps
   that will not run on a Linux CI runner. If `npm ci` fails on the lockfile,
   fall back to `npm install --no-audit --no-fund --ignore-scripts`.

   Verify locally: `cd client && npm ci --ignore-scripts && npm test` succeeds
   from a clean `node_modules`. If `npm ci` cannot run offline in your
   environment, note it in the PR and verify the two commands individually.

8. **Commit `package-lock.json`.** `npm install --save-dev vitest` updates it;
   CI's `npm ci` requires it to be in sync.
   Verify: `cd client && git status --short package.json package-lock.json`
   shows both modified.

## Verification

```bash
cd client
npx tsc --noEmit -p tsconfig.json        # exit 0, no output
npx tsc --noEmit -p tsconfig.test.json   # exit 0, no output
npm test                                 # all suites pass, >= 4 files, 0 failures
```

Success looks like `vitest` reporting at least these four files as passed:

```
 ✓ src/bridge/__tests__/aimPayload.roundtrip.test.ts
 ✓ src/bridge/__tests__/threatPayload.roundtrip.test.ts
 ✓ packages/protocol/src/__tests__/hello-roundtrip.test.ts
 ✓ packages/protocol/src/__tests__/shootack-roundtrip.test.ts
```

Greps that must return **zero** results when this plan is complete:

```bash
# No test script left undefined:
cd client && node -e "process.exit(require('./package.json').scripts.test ? 0 : 1)"

# No package declares a vitest script without the runner being installed:
cd client && test -x node_modules/.bin/vitest
```

## Out of scope

- **Do not change any encoder or decoder.** If a test fails, that is a real
  cross-boundary bug; report it, do not adjust the code or the assertion to make
  it green.
- **Do not touch `client/src/bridge/contract.ts`** — plans 98 and 99 own it.
- **Do not add tests for anything other than the two wire payloads** and the two
  pre-existing protocol tests. Broad test coverage is a separate effort.
- **Do not install vitest inside `packages/protocol` or `packages/core`.** The
  root `client/vitest.config.ts` covers them; a second runner is exactly the
  duplication this plan removes.
- **Do not enable CI jobs for the C++ build or `npm audit`.** Both are blocked
  on things outside this plan (IL2CPP headers, CVE bumps) and the CI header
  comment already documents why.
