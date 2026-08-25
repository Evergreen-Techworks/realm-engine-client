# 34 — UDodge Client Exposure (Dashboard Plugin + Contract)

## Goal
After this plan, the Electron client's Auto Dodge plugin offers a
"Unified" dodge mode that drives the new internal UDodge engine
(`autoDodgeMode = 7`) and exposes its settings as `udodge*` feature keys,
which the bridge contract accepts. All existing modes/settings keep working.

Context: plan 33 added the DLL side — `TestTAB::DodgeMode::UDodge = 7` and a
`FeatureCommandRegistry` table for these keys: `udodgeHorizonMs`,
`udodgeLeadMs`, `udodgeHitScale`, `udodgeSafeWalk`, `udodgeSpeedScale`,
`udodgePredictionAccuracy`, `udodgeFieldEscape`, `udodgeDebugOverlay`,
`udodgeMode` (0 = Assist, 1 = Autopilot), `udodgeLockFollow`,
`udodgeFollowLantern`, `udodgeStandOnType`. The client mirrors how PJDodge
and RE++ are already exposed.

## Dependencies
- **Plan 33 must be merged first.** The DLL clamps `autoDodgeMode` to the
  highest known enum value (`internal/src/features/control/FeatureState.cpp:46`);
  shipping the client first would silently clamp mode 7 to PJDodge.

Files this plan touches that other plans also touch:
- `client/plugins/auto-dodge.ts` and `client/src/bridge/contract.ts`
  (plan 35 later removes the legacy modes from the same files).

## Current state
- `client/plugins/auto-dodge.ts:13` —
  `const DODGE_VALUES = ['off', 'xdodge', 'rollout-grid', 'rollout-quad', 'zdodge', 're-plus-plus', 'pj-dodge'] as const;`
  Index in this array IS the C++ `DodgeMode` value (`modeToIdx`, lines
  18-21; flushed as `autoDodgeMode`, lines 33-37).
- Mode option list: `auto-dodge.ts:56-69`.
- Per-mode settings pattern: `registerModeSetting(mode, key, config, cb)`
  (lines 41-51) with `sendDllFeature('<key>', v)` callbacks — see the
  PJDodge group at lines 249-273 (the closest template).
- Reconnect/resync: `syncModeSettings()` (lines 385-439) re-sends every
  engine's settings on `clientConnected` and debounced `MAPINFO` (lines
  446-479) — new settings MUST be added here or they silently drop on realm
  hop.
- Allowed feature keys: `client/src/bridge/contract.ts:59-86` — a sorted
  string list containing `pjdodge*`, `repp*`, etc. Keys not in this list are
  rejected before reaching the DLL.

## Target design
- New mode value `'unified'` appended to `DODGE_VALUES` (index 7 — order in
  the array is load-bearing, append at the END).
- New option `{ label: 'Unified (RE++ x PJDodge)', value: 'unified' }` in the
  `dodgeMode` select.
- New settings group, visible when `dodgeMode === 'unified'` (mirror the
  PJDodge group style):

| Setting key | Type | Default | DLL key |
|---|---|---|---|
| `udodgeHorizonMs` | range 300-1200 step 25 | 600 | `udodgeHorizonMs` |
| `udodgeLeadMs` | range 0-150 step 5, advanced | 40 | `udodgeLeadMs` |
| `udodgeHitScale` | range 0.5-1.5 step 0.05, advanced | 1 | `udodgeHitScale` |
| `udodgeSafeWalk` | on/off select | on | `udodgeSafeWalk` (1/0) |
| `udodgeSpeedScale` | on/off select | on | `udodgeSpeedScale` (1/0) |
| `udodgePredictionAccuracy` | on/off select | on | `udodgePredictionAccuracy` (1/0) |
| `udodgeFieldEscape` | on/off select | on | `udodgeFieldEscape` (1/0) |
| `udodgeMode` | select assist/autopilot | assist | `udodgeMode` (0/1) |
| `udodgeLockFollow` | on/off select | off | `udodgeLockFollow` (1/0) |
| `udodgeFollowLantern` | on/off select, advanced | off | `udodgeFollowLantern` (1/0) |
| `udodgeStandOnType` | range 0-65535 step 1, advanced | 0 | `udodgeStandOnType` |
| `udodgeDebugOverlay` | on/off select | on | `udodgeDebugOverlay` (1/0) |

Use the existing `onOff(label, def)` helper (`auto-dodge.ts:147-150`) for
the on/off selects and the `reppMode` select (lines 227-235) as the template
for `udodgeMode`.

- `syncModeSettings()` additions (append after the PJDodge block, lines
  427-432):
```ts
    // UDodge (unified) settings.
    sendDllFeature('udodgeHorizonMs', ctx.getSetting<number>('udodgeHorizonMs'));
    sendDllFeature('udodgeLeadMs', ctx.getSetting<number>('udodgeLeadMs'));
    sendDllFeature('udodgeHitScale', ctx.getSetting<number>('udodgeHitScale'));
    sendDllFeature('udodgeStandOnType', ctx.getSetting<number>('udodgeStandOnType'));
    sendDllFeature('udodgeMode', ctx.getSetting<string>('udodgeMode') === 'autopilot' ? 1 : 0);
    for (const k of ['udodgeSafeWalk', 'udodgeSpeedScale', 'udodgePredictionAccuracy',
                     'udodgeFieldEscape', 'udodgeLockFollow', 'udodgeFollowLantern',
                     'udodgeDebugOverlay'] as const)
      sendDllFeature(k, ctx.getSetting<string>(k) === 'on' ? 1 : 0);
```
- `contract.ts` allowed-keys list: insert (keeping the list's alphabetical
  grouping style) `'udodgeDebugOverlay', 'udodgeFieldEscape',
  'udodgeFollowLantern', 'udodgeHitScale', 'udodgeHorizonMs',
  'udodgeLeadMs', 'udodgeLockFollow', 'udodgeMode',
  'udodgePredictionAccuracy', 'udodgeSafeWalk', 'udodgeSpeedScale',
  'udodgeStandOnType'`.
- Also update the stale mode comment at `auto-dodge.ts:4-12` to mention
  index 7 = Unified.

## Steps

1. `client/src/bridge/contract.ts` — add the 12 `udodge*` keys to the
   allowed-keys list (lines 59-86 region).
   **Verify:** `cd client && npm run build` → tsc exits 0.

2. `client/plugins/auto-dodge.ts` — append `'unified'` to `DODGE_VALUES`,
   add the select option, add the settings group per the table, extend
   `syncModeSettings()`, refresh the header comment.
   **Verify:** `cd client && npm run build` → tsc exits 0.

3. Sanity greps.
   **Verify:** commands under Verification all pass.

## Verification
```bash
cd client && npm run build     # tsc clean (regenerates dist/, including contract.d.ts)

grep -n "'unified'" client/plugins/auto-dodge.ts        # DODGE_VALUES + option
grep -c 'udodge' client/plugins/auto-dodge.ts            # >= 24 (register + sync)
grep -c 'udodge' client/src/bridge/contract.ts           # 12 keys present
# Index check — 'unified' must be position 7 (0-based) of DODGE_VALUES:
node -e "const s=require('fs').readFileSync('client/plugins/auto-dodge.ts','utf8');const m=s.match(/DODGE_VALUES = \[(.*?)\]/s)[1].split(',').map(x=>x.trim().replace(/['\s]/g,'')).filter(Boolean);console.log(m.indexOf('unified')===7?'OK':'WRONG INDEX '+m.indexOf('unified'))"
```
Manual smoke (user): launch dashboard, Auto Dodge → mode "Unified
(RE++ x PJDodge)", confirm the DLL log shows
`[DodgeSwap] IPC autoDodgeMode changed ... -> 7`.

## Out of scope
- Do NOT remove or reorder any existing `DODGE_VALUES` entries or settings
  (indexes are wire format; removal is plan 35).
- Do NOT touch `internal/` — the DLL side shipped in plan 33.
- Do NOT edit `client/dist/**` by hand (build output).
