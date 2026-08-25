# 49 — UDodge Client Settings: Drop Time Knobs, Add Map Knobs

## Goal

After this plan, the Electron client's auto-dodge plugin and the DLL feature
contract match the instantaneous UDodge engine: the `unified` mode no longer
exposes or sends `udodgeHorizonMs` / `udodgeLeadMs` /
`udodgePredictionAccuracy`, and exposes/sends `udodgeLaneTiles` and
`udodgeStepTiles` instead. This is the only client-side plan of the
workstream (45-49) and completes it.

Branch: commit on `refactor/unified-gameapi`. There is a pre-existing
UNCOMMITTED modification to `client/build-tools/dev-build.bat` — leave it
alone (do not stage, revert, or commit it).

## Dependencies

Plan 48 MUST be merged first (the DLL accepts `udodgeLaneTiles` /
`udodgeStepTiles` and no longer accepts the removed keys as of plan 48).

Files touched: `client/src/bridge/contract.ts`,
`client/plugins/auto-dodge.ts`. No other plan touches these files.

## Current state

- `client/src/bridge/contract.ts:75-78` — the allowed feature-key list
  contains `'udodgeHorizonMs'`, `'udodgeLeadMs'`,
  `'udodgePredictionAccuracy'` (alphabetically ordered list; the udodge
  cluster currently reads:
  `'udodgeDebugOverlay', 'udodgeFieldEscape', 'udodgeFollowLantern',
  'udodgeHitScale', 'udodgeHorizonMs', 'udodgeLeadMs', 'udodgeLockFollow',
  'udodgeMode', 'udodgePredictionAccuracy', 'udodgeSafeWalk',
  'udodgeSpeedScale', 'udodgeStandOnType'`).
- `client/plugins/auto-dodge.ts:280-287` — `registerModeSetting('unified',
  'udodgeHorizonMs', ...)` and `('unified', 'udodgeLeadMs', ...)` sliders:

```ts
  registerModeSetting('unified', 'udodgeHorizonMs', {
    label: '[UDodge] Prediction horizon (ms)',
    type: 'range', value: 600, min: 300, max: 1200, step: 25,
  }, (v: number) => sendDllFeature('udodgeHorizonMs', v));
  registerModeSetting('unified', 'udodgeLeadMs', {
    label: '[UDodge] Command lead (ms — latency compensation)', advanced: true,
    type: 'range', value: 40, min: 0, max: 150, step: 5,
  }, (v: number) => sendDllFeature('udodgeLeadMs', v));
```

- `client/plugins/auto-dodge.ts:296-298` — the
  `udodgePredictionAccuracy` on/off setting.
- `client/plugins/auto-dodge.ts:484-485` — re-apply pushes
  `sendDllFeature('udodgeHorizonMs', ...)` and `('udodgeLeadMs', ...)`.
- `client/plugins/auto-dodge.ts:489-492` — the boolean re-apply loop lists
  `'udodgePredictionAccuracy'`.

Do NOT touch the parallel `pjdodge*` settings (lines 253-277, 478-482) —
PJDodge keeps its time knobs until plan 35 retires it.

## Target design

New settings (semantics, for labels/tooltips): `udodgeLaneTiles` — how far
ahead of each bullet its danger lane is painted (react earlier vs only dodge
nearby); `udodgeStepTiles` — candidate commitment distance in tiles, 0 = auto
(one server tick of motion). DLL clamps: laneTiles [2, 16]; stepTiles 0 or
[0.4, 3].

### `client/plugins/auto-dodge.ts`

1. Replace the `udodgeHorizonMs` + `udodgeLeadMs` registrations (280-287)
   with:

```ts
  registerModeSetting('unified', 'udodgeLaneTiles', {
    label: '[UDodge] Danger lane length (tiles)',
    type: 'range', value: 12, min: 2, max: 16, step: 0.5,
  }, (v: number) => sendDllFeature('udodgeLaneTiles', v));
  registerModeSetting('unified', 'udodgeStepTiles', {
    label: '[UDodge] Step distance (tiles, 0 = auto: one server tick)', advanced: true,
    type: 'range', value: 0, min: 0, max: 3, step: 0.1,
  }, (v: number) => sendDllFeature('udodgeStepTiles', v));
```

2. Delete the `udodgePredictionAccuracy` registration (296-298).
3. Re-apply block (around 483-492): replace

```ts
    sendDllFeature('udodgeHorizonMs', ctx.getSetting<number>('udodgeHorizonMs'));
    sendDllFeature('udodgeLeadMs', ctx.getSetting<number>('udodgeLeadMs'));
```

   with

```ts
    sendDllFeature('udodgeLaneTiles', ctx.getSetting<number>('udodgeLaneTiles'));
    sendDllFeature('udodgeStepTiles', ctx.getSetting<number>('udodgeStepTiles'));
```

   and remove `'udodgePredictionAccuracy'` from the boolean loop array so it
   reads:

```ts
    for (const k of ['udodgeSafeWalk', 'udodgeSpeedScale',
                     'udodgeFieldEscape', 'udodgeLockFollow', 'udodgeFollowLantern',
                     'udodgeDebugOverlay'] as const)
```

### `client/src/bridge/contract.ts`

In the allowed-key list, remove `'udodgeHorizonMs'`, `'udodgeLeadMs'`,
`'udodgePredictionAccuracy'` and insert `'udodgeLaneTiles'`,
`'udodgeStepTiles'` keeping the list's alphabetical order (both new keys
sort between `'udodgeHitScale'` and `'udodgeLockFollow'`; `'udodgeStepTiles'`
sorts after `'udodgeSpeedScale'` — place each key in its correct alphabetical
position within the list).

## Steps

1. `client/src/bridge/contract.ts`: swap the keys as specified.
   `client/plugins/auto-dodge.ts`: make edits 1-3.
   Verify: `cd client && npm run build` → tsc completes with no errors.
2. Greps, then commit on `refactor/unified-gameapi` (message:
   `refactor(plan49): udodge client settings — lane/step tiles replace time knobs`).
   Do NOT include `client/build-tools/dev-build.bat` in the commit (it has a
   pre-existing local modification that must stay uncommitted).

## Verification

```bash
cd client && npm run build     # tsc clean

# Must return NOTHING:
grep -rn "udodgeHorizonMs\|udodgeLeadMs\|udodgePredictionAccuracy" client/src client/plugins

# Must each return at least one hit in BOTH files:
grep -rn "udodgeLaneTiles" client/src/bridge/contract.ts client/plugins/auto-dodge.ts
grep -rn "udodgeStepTiles" client/src/bridge/contract.ts client/plugins/auto-dodge.ts
```

Note: `client/dist/` and `client/packages/*/dist/` may contain stale compiled
copies of old keys — ignore generated output in greps (the two greps above
target source dirs only).

## Out of scope

- Do NOT touch any `pjdodge*`, `repp*`, `zdodge*`, `xdodge*`, or `rollout*`
  settings/keys (legacy engines keep their client wiring until plan 35).
- Do NOT touch `client/plugins/admin-autododge.ts` or any other plugin.
- Do NOT touch `client/build-tools/dev-build.bat` (pre-existing uncommitted
  local modification — leave exactly as found).
- Do NOT touch anything under `internal/` (plans 45-48 finished it).
