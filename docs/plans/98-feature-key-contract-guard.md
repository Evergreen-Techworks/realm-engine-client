# 98 — Feature-key contract drift guard (C++ registry ↔ contract.ts)

## Goal

After this plan, a checked-in script (`client/scripts/check-bridge-contract.mjs`)
parses the DLL's `FeatureCommandRegistry.cpp` and the client's
`contract.ts`, and **fails** when the two disagree in a way that matters:
a key the client can send that the DLL will silently swallow, or a key the DLL
handles that the client's typed union claims does not exist. It runs from
`npm test` and from CI. `contract.ts` gains an explicit
`DLL_ONLY_FEATURE_KEYS` list so "the DLL handles it, nothing in the client sends
it" is a documented state rather than an undetectable gap.

Today those two lists are hand-maintained, `contract.ts:52` calls its list
"Exhaustive", and they disagree on **25 keys** — including two keys a shipped
plugin sends into the void.

**This is a TypeScript / tooling plan.** It reads C++ source as text but never
compiles the DLL. Parallel-safe against every C++ plan.

## Dependencies

- **Plan 97 SHOULD be merged first.** This plan's checker is wired into
  `npm test`, which plan 97 creates. If 97 has not landed, wire the checker into
  a standalone `npm run check:contract` script and note in the PR that it needs
  re-wiring once 97 lands.

Files this plan touches that other plans also touch:
- `client/src/bridge/contract.ts` — **plan 99 also edits this file** (it removes
  three tile message types from `DllMessageType` at lines 45–47). Those are
  different regions of the file; if both land, expect a trivial merge. This plan
  edits the `DLL_FEATURE_KEYS` block (lines 58–94) and its docblock.
- `client/package.json` — plan 97 also edits it (`scripts`). Coordinate:
  add only the one new script line.

## Current state

### Two hand-maintained lists

**C++ side** — `internal/src/features/control/FeatureCommandRegistry.cpp`.
Keys are declared in `FeatureHandler` tables via the `FH*` macros defined at
lines 88–93:

```cpp
// internal/src/features/control/FeatureCommandRegistry.cpp:88-93
#define FH(key, body) { key, [](const FeatureCommand& f)->bool { body; return true; } }
#define FH_BOOL(key, fn) FH(key, fn(f.Bool()))
#define FH_INT(key, fn) FH(key, fn(f.Int()))
#define FH_INT_BOOL(key, fn) FH(key, fn(f.Int() != 0))
#define FH_FLOAT(key, fn) FH(key, fn(f.Float()))
#define FH_TEXT(key, fn) FH(key, fn(f.value))
```

Plus four keys matched with `f.Is("...")` inside an `FH` body
(`xdodgeFutureHorizon`, `xdodgeFutureSample`, `xdodgeFutureStride`,
`xdodgeStayPenalty`). Total: **154 keys**.

**TS side** — `client/src/bridge/contract.ts:58-94`, a `as const` array whose
element type drives `sendDllFeature`'s parameter type. Total: **133 keys**.
Its docblock (lines 51–57) says:

```ts
/**
 * The full set of `sendDllFeature` feature keys, sorted. Exhaustive — the union
 * below drives sendDllFeature's parameter type, so a typo is a compile error.
 * Every key here is consumed by the DLL's FeatureCommandRegistry.cpp ...
 */
```

Both claims in that docblock are currently false.

### Why a mismatch is silent

`FeatureCommandRegistry.cpp:9-10` documents the swallow-by-design policy:

```cpp
// - Unknown keys are intentionally treated as applied after all groups are tried;
//   this keeps the IPC command stream tolerant of client/server version skew.
```

So a client→DLL key with no handler produces **no log, no warning, nothing**.

### The 25 disagreements

**A. In `DLL_FEATURE_KEYS` but NOT handled by the DLL (2) — REAL BUG:**

| Key | Client sender | DLL handler |
|---|---|---|
| `followEntityActive` | `client/plugins/auto-follow.ts:24,45,49` | none |
| `followEntityName` | `client/plugins/auto-follow.ts:23` | none |

`plugins/auto-follow.ts:7-10` claims "The DLL resolves the entity each frame and
feeds `DangerPlanner::SetExternalGoal`". `grep -rn 'SetExternalGoal' internal/src`
returns only `TestTAB.cpp:551,1139` (the shift+click walk-to path) and the
`DangerPlanner.h:44` declaration. **The Auto Follow plugin has been a no-op for
some time.** This plan makes the condition *detectable*; see "Out of scope" for
why the fix is not here.

**B. Handled by the DLL but absent from `DLL_FEATURE_KEYS` (23) — not bugs,
but undocumented:**

DLL-only by design (driven from the in-game ImGui tabs, no client UI):

| Key | Registry line |
|---|---|
| `overlayEnabled` | `FeatureCommandRegistry.cpp:96` |
| `autoFireEnabled` | `:118` (`FH_BOOL("autoFireEnabled", AutoFire::SetEnabled)`) |
| `autoFireHotkey` | `:119` |
| `autoBreakWallsEnabled` | `:120` |
| `autoBreakWallsProbeTiles` | `:121` |
| `autoBreakWallsTimeoutMs` | `:122` |
| `walkTargetX` | `:283` |
| `walkTargetY` | `:284` |
| `walkTargetActive` | `:285` |

Sent by the client through the **untyped** `setFeature` escape hatch:

| Key | Client sender |
|---|---|
| `pluginToggleHotkeys` | `client/src/dashboard/server/DevServer.ts:2897` (`this.internalBridge?.setFeature('pluginToggleHotkeys', payload)`) |

Legacy dodge tuning keys with no client sender and no in-game control — the DLL
still honours them if anything ever sends them:

`autoDodgeHitboxPadding`, `autoDodgeHorizonMs` (`:131`), `autoDodgeWallAvoid`
(`:133`), `dodgeHitAversion`, `dodgeIdleMinGain`, `dodgeReplanOnSpawn`,
`dodgeStickiness` (`:317`), `dodgeStrategicBias`, `dodgeStrategicNearWaypoint`,
`dodgeTightLeash`, `dodgeWasdLookahead`, `xdodgeNotifyHit`, `xdodgeSearchRadius`
(`:150`).

### The typed/untyped split

`sendDllFeature(key: DllFeatureKey, ...)`
(`client/src/bridge/DllFeatureBus.ts:183`) is type-checked. But
`InternalBridge.setFeature(key: string, ...)`
(`client/src/bridge/InternalBridge.ts:141`) is not, and `DevServer.ts:2897`
uses it. So today there are two send paths with different guarantees.

## Target design

### 1. `contract.ts` gains a second, explicit list

Insert immediately after `DLL_FEATURE_KEYS` / `DllFeatureKey`
(`contract.ts:94-95`):

```ts
/**
 * Feature keys the DLL's FeatureCommandRegistry.cpp handles but that NOTHING in
 * the client sends today. Listed here so `scripts/check-bridge-contract.mjs`
 * can tell "intentionally DLL-side only" apart from "someone forgot to add a
 * key" — the latter is a silent bug, because the DLL swallows unknown keys by
 * design (FeatureCommandRegistry.cpp:9-10).
 *
 * Three sub-groups, kept in one list because the checker only needs the set:
 *   - in-game-UI only  : the ImGui Combat/Test tab owns them, there is no
 *                        dashboard control (autoFire*, autoBreakWalls*,
 *                        overlayEnabled, walkTarget*)
 *   - untyped sender   : sent via InternalBridge.setFeature (not sendDllFeature),
 *                        so it deliberately bypasses DllFeatureKey
 *                        (pluginToggleHotkeys — DevServer.ts:2897)
 *   - legacy dodge     : honoured by the DLL, no live sender anywhere
 *
 * Adding a dashboard control for one of these means MOVING it into
 * DLL_FEATURE_KEYS, not duplicating it.
 */
export const DLL_ONLY_FEATURE_KEYS = [
  'autoBreakWallsEnabled', 'autoBreakWallsProbeTiles', 'autoBreakWallsTimeoutMs',
  'autoDodgeHitboxPadding', 'autoDodgeHorizonMs', 'autoDodgeWallAvoid',
  'autoFireEnabled', 'autoFireHotkey',
  'dodgeHitAversion', 'dodgeIdleMinGain', 'dodgeReplanOnSpawn', 'dodgeStickiness',
  'dodgeStrategicBias', 'dodgeStrategicNearWaypoint', 'dodgeTightLeash',
  'dodgeWasdLookahead',
  'overlayEnabled', 'pluginToggleHotkeys',
  'walkTargetActive', 'walkTargetX', 'walkTargetY',
  'xdodgeNotifyHit', 'xdodgeSearchRadius',
] as const;

/**
 * Keys `sendDllFeature` accepts that the DLL does NOT currently handle. Every
 * entry here is a live bug: the send succeeds, the DLL swallows it silently
 * (FeatureCommandRegistry.cpp:9-10), and the feature does nothing.
 *
 * KNOWN-BROKEN (do not add to without an owner):
 *   followEntityActive / followEntityName — client/plugins/auto-follow.ts sends
 *   both; there is no handler in FeatureCommandRegistry.cpp and no caller of
 *   DangerPlanner::SetExternalGoal outside TestTAB. The Auto Follow plugin is a
 *   no-op. Fix = either implement the DLL handler or delete the plugin; that is
 *   a product decision, tracked separately.
 */
export const KNOWN_UNHANDLED_FEATURE_KEYS = [
  'followEntityActive', 'followEntityName',
] as const;
```

Also **fix the false docblock** at `contract.ts:51-57`: replace "Exhaustive —"
and "Every key here is consumed by the DLL's FeatureCommandRegistry.cpp" with
an accurate statement plus a pointer to the checker.

### 2. The checker

New file `client/scripts/check-bridge-contract.mjs`. Node, zero dependencies,
reads both files as text.

```
node scripts/check-bridge-contract.mjs
```

Exit 0 = the two sides agree. Exit 1 = drift, with a report naming each key and
which direction it drifted.

Parsing contract (keep it dumb and greppable):

- **C++ keys**: over `internal/src/features/control/FeatureCommandRegistry.cpp`,
  collect
  `/FH(?:_BOOL|_INT|_INT_BOOL|_FLOAT|_TEXT)?\s*\(\s*"([A-Za-z0-9_]+)"/g`
  **and** `/f\.Is\("([A-Za-z0-9_]+)"\)/g`.
  Sanity gate: if fewer than 100 keys are found, exit 1 with
  "registry parse produced only N keys — the FH macro shape changed, fix the
  parser". A silently-empty parse is worse than no checker.
- **TS keys**: over `client/src/bridge/contract.ts`, extract the three arrays by
  name (`DLL_FEATURE_KEYS`, `DLL_ONLY_FEATURE_KEYS`,
  `KNOWN_UNHANDLED_FEATURE_KEYS`) with
  `new RegExp(name + "\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const")` and then
  `/'([A-Za-z0-9_]+)'/g` inside the captured body.

Rules:

| # | Rule | Failure message |
|---|---|---|
| 1 | `DLL_FEATURE_KEYS − cppKeys − KNOWN_UNHANDLED_FEATURE_KEYS` must be empty | "client can send `<k>` but the DLL has no handler — it will be silently swallowed. Add the handler, or add `<k>` to KNOWN_UNHANDLED_FEATURE_KEYS with an owner." |
| 2 | `cppKeys − DLL_FEATURE_KEYS − DLL_ONLY_FEATURE_KEYS` must be empty | "the DLL handles `<k>` but no TS list mentions it. Add it to DLL_FEATURE_KEYS (if a plugin should send it) or DLL_ONLY_FEATURE_KEYS (if the in-game UI owns it)." |
| 3 | `DLL_ONLY_FEATURE_KEYS ∩ DLL_FEATURE_KEYS` must be empty | "`<k>` is in both lists — pick one." |
| 4 | `DLL_ONLY_FEATURE_KEYS − cppKeys` must be empty | "`<k>` is listed DLL-only but the DLL no longer handles it — delete it." |
| 5 | `KNOWN_UNHANDLED_FEATURE_KEYS ∩ cppKeys` must be empty | "`<k>` is listed as unhandled but the DLL now handles it — remove it from KNOWN_UNHANDLED_FEATURE_KEYS." (this is the ratchet that closes the auto-follow bug the moment someone fixes it) |
| 6 | `DLL_FEATURE_KEYS` must be sorted and duplicate-free | "list is not sorted / has duplicate `<k>`." |

Also print a one-line summary on success:
`bridge contract OK — 154 DLL keys, 133 client-sendable, 23 DLL-only, 2 known-unhandled`.

### Ownership / threading / caching

None — a build-time script.

### Divergence warning

The registry parser and `contract.ts` must both tolerate the file being edited
by plans 99–105. Plan 99 removes tile message *types*, not feature keys, so the
counts above stay valid. If a C++ plan adds or removes a feature key, this
checker is exactly the thing that will catch the forgotten TS side — that is
working as intended, not a merge problem.

## Steps

1. **Create `client/scripts/check-bridge-contract.mjs`** implementing the
   parsing and the six rules above. Resolve the C++ path relative to the script:
   `resolve(__dirname, '..', '..', 'internal', 'src', 'features', 'control', 'FeatureCommandRegistry.cpp')`.
   If that file does not exist, print a clear message and exit **0** (a
   client-only checkout must not fail CI on a missing DLL source tree) — but
   print `SKIPPED` loudly.
   Verify:
   ```bash
   cd client && node scripts/check-bridge-contract.mjs; echo "exit=$?"
   ```
   Expect `exit=1` at this step, with rules 1 and 2 reporting the 2 + 23 keys
   listed above. Confirm the numbers match this plan exactly. If they do not,
   the parser is wrong — fix the parser, not the lists.

2. **Add `DLL_ONLY_FEATURE_KEYS` and `KNOWN_UNHANDLED_FEATURE_KEYS`** to
   `client/src/bridge/contract.ts`, immediately after line 95
   (`export type DllFeatureKey = ...`), with the exact contents given above.
   Verify:
   ```bash
   cd client && npx tsc --noEmit -p tsconfig.json && node scripts/check-bridge-contract.mjs; echo "exit=$?"
   ```
   Expect `exit=0` and the summary line.

3. **Correct the `DLL_FEATURE_KEYS` docblock** at `contract.ts:51-57`. Replace
   the two false sentences. Suggested text:

   ```ts
   /**
    * Feature keys `sendDllFeature` accepts, sorted. This union drives
    * sendDllFeature's parameter type, so a typo is a compile error — but it is
    * NOT the full set the DLL handles: see DLL_ONLY_FEATURE_KEYS below.
    *
    * The DLL swallows unknown keys by design (FeatureCommandRegistry.cpp:9-10),
    * so a key added here without a matching handler fails SILENTLY. Run
    * `node scripts/check-bridge-contract.mjs` (part of `npm test`) after any
    * change to either side.
    */
   ```
   Verify: `cd client && npx tsc --noEmit -p tsconfig.json` — exit 0.

4. **Wire the checker into `npm test`.** In `client/package.json`, change the
   `test` script (created by plan 97) to:
   `"test": "node scripts/check-bridge-contract.mjs && vitest run"`.
   If plan 97 has not landed, instead add
   `"check:contract": "node scripts/check-bridge-contract.mjs"` and say so in
   the PR description.
   Verify: `cd client && npm test` — passes, and the contract summary line
   appears before the vitest output.

5. **Wire into CI.** In `.github/workflows/ci.yml`, add a step to the
   `client-checks` job created by plan 97 (or a new job if 97 has not landed):

   ```yaml
       - name: Bridge feature-key contract
         working-directory: client
         run: node scripts/check-bridge-contract.mjs
   ```

   This step needs no `node_modules`, so it can run before the install step.
   Verify: the YAML parses — `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`.

6. **Prove the checker actually catches drift.** Temporarily add a bogus key
   `'zzTestDrift'` to `DLL_FEATURE_KEYS`, run the checker, confirm it exits 1
   with rule 1's message, then remove it.
   Verify: `cd client && node scripts/check-bridge-contract.mjs; echo "exit=$?"`
   → `exit=0` after removal.

## Verification

```bash
cd client
node scripts/check-bridge-contract.mjs   # exit 0 + summary line
npx tsc --noEmit -p tsconfig.json        # exit 0, no output
npm test                                 # contract check then all vitest suites pass
```

Success summary line (exact counts may shift by ±1 if a C++ plan lands first;
the point is that all six rules pass):

```
bridge contract OK — 154 DLL keys, 133 client-sendable, 23 DLL-only, 2 known-unhandled
```

Greps that must return **zero** results when this plan is complete:

```bash
# The false "Exhaustive" claim is gone:
grep -n 'Exhaustive' client/src/bridge/contract.ts

# The checker is wired into a runnable script:
cd client && node -e "const s=require('./package.json').scripts; process.exit(/check-bridge-contract/.test(s.test||s['check:contract']||'')?0:1)"
```

## Out of scope

- **Do NOT fix the Auto Follow plugin.** Deleting `client/plugins/auto-follow.ts`
  removes a feature users can see in the dashboard; implementing a DLL
  `followEntity*` handler is new feature work with a real design question
  (which planner owns the goal now that xdodge is one of five modes). Record it
  in `KNOWN_UNHANDLED_FEATURE_KEYS` and stop.
- **Do NOT delete the "legacy dodge" keys from the C++ registry.** They are
  cheap table rows and removing them is a separate, C++-build-requiring change.
- **Do NOT convert `DevServer.ts:2897` to `sendDllFeature`.** `pluginToggleHotkeys`
  deliberately uses the untyped path; making it typed means either exporting it
  in `DLL_FEATURE_KEYS` (wrong — no plugin should send it) or plumbing a second
  typed sender. Leave it, documented.
- **Do NOT generate `contract.ts` from the C++ source.** Codegen across a
  language boundary in a repo with no shared build step is a much larger change;
  a checker gets the drift protection without it.
- **Do NOT touch any C++ file.** This plan is text-parsing only; it must not
  require `wsl-build.sh`.
