# 48 — UDodge Wiring: IPC Keys, Deprecated-Stub Removal, DiagView/DiagBridge Reshape

## Goal

After this plan, the DLL-side wiring matches the instantaneous UDodge engine:
the IPC feature keys `udodgeHorizonMs`, `udodgeLeadMs`, and
`udodgePredictionAccuracy` are gone, `udodgeLaneTiles` and `udodgeStepTiles`
exist, the three deprecated no-op setters left by plan 47 are deleted, and
the `UDodge::DiagView` / DiagBridge JSON block reports clearance + tick-sync
state instead of impact time + prediction calibration. After this plan the
internal/ side of the workstream is COMPLETE and the workstream-wide greps in
the Verification section must pass.

Branch: commit on `refactor/unified-gameapi`. Leave the pre-existing
uncommitted `client/build-tools/dev-build.bat` modification alone.

## Dependencies

Plan 47 MUST be merged first (it left the deprecated no-op setters and the
compatibility-filled `DiagView` that this plan removes; it also added
`UDodge::SetLaneTiles/SetStepTiles` which this plan wires to IPC).

Files touched: `internal/src/features/control/FeatureCommandRegistry.cpp`,
`internal/src/core/runtime/DiagBridge.cpp`,
`internal/src/features/movement/udodge/UDodge.h`, `UDodge.cpp`.
Plan 49 (client) depends on this plan.

## Current state

- IPC feature table `ApplyUDodgeFeature`
  (`internal/src/features/control/FeatureCommandRegistry.cpp:238-256`):

```cpp
            FH_FLOAT("udodgeHorizonMs", UDodge::SetHorizonMs),
            FH_FLOAT("udodgeLeadMs", UDodge::SetLeadMs),
            FH_FLOAT("udodgeHitScale", UDodge::SetHitScale),
            ...
            FH_INT_BOOL("udodgePredictionAccuracy", UDodge::SetPredictionAccuracy),
```

- Deprecated no-op setters in
  `internal/src/features/movement/udodge/UDodge.cpp` (left by plan 47,
  marked `// Deprecated no-ops — ... until plan 48`), with matching
  declarations in `UDodge.h`.
- `UDodge::DiagView` (`internal/src/features/movement/udodge/UDodge.h:13-30`)
  still carries `earliestImpactMs` (filled with `-1` since plan 47) and the
  five `pred*` fields (filled with zeros since plan 47).
- DiagBridge emits them in the `"udodge"` JSON block
  (`internal/src/core/runtime/DiagBridge.cpp:332-352`), including a
  `"prediction": { ... }` sub-object. The diag file is a dev-only opt-in
  (`DiagBridge.cpp:362-368`, gated on `settings.bEnableDiagBridge`); no
  client code parses these fields — reshaping is safe.

## Target design

### `FeatureCommandRegistry.cpp` — `ApplyUDodgeFeature`

Final table (order preserved where unchanged):

```cpp
    bool ApplyUDodgeFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("udodgeLaneTiles", UDodge::SetLaneTiles),
            FH_FLOAT("udodgeStepTiles", UDodge::SetStepTiles),
            FH_FLOAT("udodgeHitScale", UDodge::SetHitScale),
            FH_INT_BOOL("udodgeSafeWalk", UDodge::SetSafeWalk),
            FH_INT_BOOL("udodgeSpeedScale", UDodge::SetSpeedScale),
            FH_INT_BOOL("udodgeFieldEscape", UDodge::SetFieldEscape),
            FH_INT_BOOL("udodgeDebugOverlay", UDodge::SetDebugOverlay),
            FH_INT("udodgeMode", UDodge::SetMode),
            FH_INT_BOOL("udodgeLockFollow", UDodge::SetLockFollow),
            FH_INT_BOOL("udodgeFollowLantern", UDodge::SetFollowLantern),
            FH_INT("udodgeStandOnType", UDodge::SetStandOnType)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }
```

(An old client sending the removed keys is harmless: `ApplyFeatureTable`
finds no handler and the dispatcher falls through — same as any unknown key.)

### `UDodge.h` / `UDodge.cpp`

- Delete the three deprecated no-op setters and their declarations
  (`SetHorizonMs`, `SetLeadMs`, `SetPredictionAccuracy`).
- Reshape `DiagView` to:

```cpp
struct DiagView {
    bool  enabled = false;
    int   decision = 0;
    float playerX = 0.f, playerY = 0.f;
    bool  overrideActive = false;
    float velXPerSec = 0.f, velYPerSec = 0.f;
    int   candidate = 0;
    float speedScale = 1.f;
    int   threatCount = 0;
    float standClearanceTiles = 0.f;   // ≤ 0 = danger covers current position; -1 sentinel unused
    int   lanes = 0, zones = 0, enemies = 0;
    uint32_t tickId = 0;               // NewTick stamp of the current map
    bool  tickValid = false;           // false = tick source unreadable (rebuild-every-frame mode)
    bool  fieldActive = false;
    bool  hasLockTarget = false;
    float lockX = 0.f, lockY = 0.f;
};
```

- `GetDiagView()` fills the new fields from the debug slot
  (`standClearance`, `map.laneCount`, `map.zoneCount`, `map.enemyCount`,
  `tickId`, `tickValid`); delete the `ProjectileTracking::GetPredictionDiag`
  call and, if it is the last use, the now-unneeded
  `#include "ProjectileTracking.h"` from `UDodge.cpp` (check with grep —
  `ProjectileTracking::Install()` calls at `UDodge.cpp:164,176` REMAIN, so
  the include stays; only the diag call goes).

### `DiagBridge.cpp` — `"udodge"` block

Replace the format string + arguments (`DiagBridge.cpp:332-352`) with:

```cpp
    const UDodge::DiagView uv = UDodge::GetDiagView();
    if (len > 0 && len < static_cast<int>(sizeof(buf)) - 700)
        len += snprintf(buf + len, sizeof(buf) - len,
            "  ,\"udodge\": { \"enabled\": %s, \"decision\": %d, \"override\": %s,\n"
            "    \"player\": { \"x\": %.2f, \"y\": %.2f }, \"velPerSec\": { \"x\": %.2f, \"y\": %.2f },\n"
            "    \"candidate\": %d, \"speedScale\": %.2f, \"threats\": %d, \"clearanceTiles\": %.3f,\n"
            "    \"lanes\": %d, \"zones\": %d, \"enemies\": %d,\n"
            "    \"tick\": { \"id\": %u, \"valid\": %s },\n"
            "    \"fieldActive\": %s,\n"
            "    \"lock\": { \"active\": %s, \"x\": %.2f, \"y\": %.2f } }\n",
            uv.enabled ? "true" : "false", uv.decision,
            uv.overrideActive ? "true" : "false",
            uv.playerX, uv.playerY, uv.velXPerSec, uv.velYPerSec,
            uv.candidate, uv.speedScale, uv.threatCount, uv.standClearanceTiles,
            uv.lanes, uv.zones, uv.enemies,
            uv.tickId, uv.tickValid ? "true" : "false",
            uv.fieldActive ? "true" : "false",
            uv.hasLockTarget ? "true" : "false", uv.lockX, uv.lockY);
```

Do NOT touch the PJDodge diag block above it (`DiagBridge.cpp:325-330`) —
PJDodge keeps its prediction fields until plan 35.

## Steps

1. `UDodge.h`/`UDodge.cpp`: reshape `DiagView` + `GetDiagView`; delete the
   three deprecated no-op setters/declarations.
   `DiagBridge.cpp`: swap the `"udodge"` block as specified.
   (One step: `DiagView` consumers must change together.)
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
2. `FeatureCommandRegistry.cpp`: replace the `ApplyUDodgeFeature` table as
   specified.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
3. Guardrail + workstream-complete greps (below), then commit on
   `refactor/unified-gameapi` (message:
   `refactor(plan48): udodge IPC keys + diag reshaped for instantaneous map`).
   Do NOT include `client/build-tools/dev-build.bat` in the commit.

## Verification

- `bash internal/tools/wsl-build.sh Debug` → 0 errors after every step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- Workstream-complete greps for internal/ (ALL must return NOTHING):

```bash
grep -rnE "horizonMs|leadMs|impactMs|sampleTimesMs|landingMs|remainMs|arrivalMs|holdMs|PointDwellClear|SweepSegment|SearchSurvival|RefineWithEscapeSearch|PredictionAccuracy|predEnabled|predClockErr|elapsedCalMs|selectedUntilMs|CoreInput|struct Snapshot|ProjectileThreat|AoeThreat" internal/src/features/movement/udodge/
grep -rn "udodgeHorizonMs\|udodgeLeadMs\|udodgePredictionAccuracy" internal/src/
```

- Positive checks:
  `grep -n "udodgeLaneTiles\|udodgeStepTiles" internal/src/features/control/FeatureCommandRegistry.cpp`
  → both present;
  `grep -n "clearanceTiles" internal/src/core/runtime/DiagBridge.cpp` → present.

## Out of scope

- Do NOT touch anything else in `FeatureCommandRegistry.cpp` (the PJDodge /
  RePP / ZDodge tables keep their keys until plan 35) or in
  `DiagBridge.cpp` beyond the `"udodge"` block.
- Do NOT touch `FeatureState.cpp` (the dodge-mode clamp at
  `internal/src/features/control/FeatureState.cpp:46` already spans mode 7).
- Do NOT touch `udodge/UDodgeTypes.h`, `UDodgeCore.*`, `UDodgeField.*`,
  `UDodgeSensors.*`, `UDodgeDebug.*` — plan 47 finished them.
- Do NOT touch `repp/`, `pjdodge/`, `zdodge/`, `gui/tabs/WorldTAB.cpp`,
  `gui/CamState.cpp`, `gui/tabs/PlayerTAB.cpp`, `gui/tabs/CameraTAB.cpp`,
  `internal/tools/check-raw-access.sh`.
- Do NOT touch client/ code (plan 49).
