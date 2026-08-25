# 35 — Legacy Dodge Retirement (RePP, PJDodge, ZDodge)

> **GATE — DO NOT EXECUTE until the user has explicitly confirmed that the
> unified engine (UDodge, plans 31-34) has been validated in-game.** This
> plan deletes working engines; it is intentionally not behavior-preserving
> for users of the retired modes (they are redirected to UDodge). If you are
> an implementer agent and the dispatching instructions do not explicitly
> state that the user signed off, STOP and report back instead of executing.

## Goal
After this plan, the RePP, PJDodge, and ZDodge engines are deleted from the
DLL and hidden from the client, with their dashboard mode values redirected
to UDodge so stale clients degrade gracefully. XDodge and RolloutDodge stay
(different lineage; XDodge is the dashboard default and RolloutDodge is its
A/B partner — retiring those is a separate decision).

## Dependencies
- Plans 33 and 34 merged, **plus explicit user in-game sign-off on UDodge**.

Files touched that other plans also touch: the same wiring files as plan 33
(`TestTAB.{h,cpp}`, `DangerPlanner.cpp`, `FeatureCommandRegistry.cpp`,
`FeatureState.cpp`, `DiagBridge.cpp`, vcxproj/filters) and the same client
files as plan 34 (`auto-dodge.ts`, `contract.ts`).

## Current state
- Engine sources: `internal/src/features/movement/repp/` (13 files),
  `internal/src/features/movement/pjdodge/` (10 files),
  `internal/src/features/movement/zdodge/` (12 files).
- Enum: `internal/src/gui/tabs/TestTAB.h:10-18` — `ZDodge=4, RePP=5,
  PJDodge=6, UDodge=7` (values are wire format for `autoDodgeMode`).
- Registration points (each references all three retired engines):
  - `TestTAB.cpp` — includes, `ApplyDodgeModeWithEnter` SetEnabled fan-out +
    enter branches (141-204 region), clamp (~1414), mode combo labels
    (~928), settings dispatch (~939-951), overlay dispatch (~616-627).
  - `DangerPlanner.cpp:724-782` — `IsEnabled()` gates + Tick dispatch.
  - `FeatureCommandRegistry.cpp` — `ApplyZDodgeFeature` (184-204),
    `ApplyReppFeature` (206-220), `ApplyPJDodgeFeature` (222-235), chained
    in `Apply` (303-315). Unknown keys are tolerated by design (see the file
    header comment, lines 9-10), so deleting tables does not break old
    clients that still send `repp*`/`pjdodge*`/`zdodge*` keys.
  - `DiagBridge.cpp:299-331` — RePP + PJDodge DiagView JSON blocks.
  - `internal/il2cpp-dll-injection.vcxproj` (lines ~48-62, ~225-242) and
    `.filters` — ClCompile/ClInclude entries for all three engines.
- Client: `client/plugins/auto-dodge.ts` — `DODGE_VALUES` (line 13; ARRAY
  INDEX = wire value, so entries must NOT be removed), mode options (56-69),
  zdodge settings (152-208), RE++ settings (210-247), PJDodge settings
  (249-273), sync blocks (410-432). `client/src/bridge/contract.ts:59-86` —
  `repp*`, `pjdodge*`, `zdodge*` allowed keys.

## Target design
- **Wire compatibility**: enum values 4/5/6 remain declared in
  `TestTAB::DodgeMode` with a `// retired — redirects to UDodge` comment.
  `ApplyDodgeModeWithEnter` maps them to `DodgeMode::UDodge` at entry:
```cpp
    if (nextMode == DodgeMode::ZDodge || nextMode == DodgeMode::RePP ||
        nextMode == DodgeMode::PJDodge)
        nextMode = DodgeMode::UDodge;   // retired engines redirect (plan 35)
```
- **DLL**: delete the three source folders; strip every reference listed in
  Current state; DangerPlanner dispatch shrinks to
  `if (uniOn) UDodge::Tick(...); else if (rolloutOn) ...; else XDodge::Tick(...);`
  and the gate to `xdodgeOn || rolloutOn || uniOn`.
- **Client**: keep `DODGE_VALUES` array contents unchanged (index mapping);
  remove the three options from the `dodgeMode` select; in `flush()` map a
  stored retired value to `'unified'` before `modeToIdx`; delete the three
  settings groups and their sync blocks; remove the retired keys from
  `contract.ts`.

## Steps

1. Confirm the gate: the dispatch instructions for this plan must state the
   user validated UDodge in-game. If absent, STOP.
2. `TestTAB.h`: mark 4/5/6 retired in comments (keep values). `TestTAB.cpp`:
   add the redirect at the top of `ApplyDodgeModeWithEnter`; remove
   ZDodge/RePP/PJDodge includes, SetEnabled lines, enter branches, settings
   branches, overlay branches; combo labels for the retired slots become
   `"(retired)"` placeholders (the combo indexes must keep their positions);
   clamp stays `<= DodgeMode::UDodge`.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.
3. `DangerPlanner.cpp`: remove the three `IsEnabled()` gates and Tick
   dispatch lines + includes. `FeatureCommandRegistry.cpp`: remove the three
   Apply tables, their chain calls, and includes. `DiagBridge.cpp`: remove
   the RePP/PJDodge blocks and includes (keep the `udodge` block).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.
4. Delete `internal/src/features/movement/{repp,pjdodge,zdodge}/` and their
   vcxproj + filters entries. Also remove the three folders from
   `AdditionalIncludeDirectories` (both configs, vcxproj lines ~337/~364).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors;
   `bash internal/tools/check-raw-access.sh` → exit 0.
5. Client: `auto-dodge.ts` — remove the three select options, add the
   retired→`'unified'` mapping in `flush()`, delete the three settings
   groups + sync blocks (keep `DODGE_VALUES` untouched); `contract.ts` —
   remove `repp*`, `pjdodge*`, `zdodge*` keys.
   **Verify:** `cd client && npm run build` → tsc exits 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
cd client && npm run build

# Zero references to the retired engines outside docs:
grep -rn 'RePP\|PJDodge\|ZDodge' internal/src --include='*.cpp' --include='*.h' \
  | grep -v 'retired'            # → empty
ls internal/src/features/movement | grep -E 'repp|pjdodge|zdodge'   # → empty
grep -n "re-plus-plus\|pj-dodge\|'zdodge'" client/plugins/auto-dodge.ts \
  | grep -v DODGE_VALUES         # → only the flush() mapping remains
grep -c "repp\|pjdodge\|zdodge" client/src/bridge/contract.ts        # 0
```

## Out of scope
- XDodge, RolloutDodge, DangerPlanner internals, GhostHit — all stay.
- The shared substrate in `internal/src/features/movement/dodge/`
  (ProjectileTracking, AoeTracking, MovementRuntime, SteerInput,
  ThreatIndex, DodgeGeometry, ...) — UDodge and XDodge both depend on it.
- Renumbering `DodgeMode` values or `DODGE_VALUES` indexes — wire format.

## Deferred hygiene rider (user-approved 2026-08-19: execute together with this plan)

When this plan runs, the same implementer must also do these small,
unrelated-to-retirement cleanups that were deliberately deferred to this
moment:

1. **`internal/tools/check-raw-access.ps1`** — port checks 9-11 from the
   `.sh` version (added by plan 43, commit `0bc9e1d`) so the Windows mirror
   run by `build-and-test.bat` enforces the same ratchet. Mirror the `.sh`
   blocks 1:1, including check 10's dodge-territory directory exclusions
   (update those exclusions to match the post-retirement tree: `repp/`,
   `pjdodge/`, `zdodge/` no longer exist).
2. **`internal/src/features/movement/udodge/UDodgeTypes.h`** — delete the
   now-unused `kMaxPathSamples` constant (last consumers died in plan 47).
3. **`internal/src/features/movement/udodge/UDodge.cpp`** — delete the
   now-unused `#include <windows.h>` (its `GetTickCount64` user died in
   plan 47). Verify nothing else in the TU needs it before deleting.
4. **`internal/src/features/movement/dodge/ProjectileTracking.cpp:109`** —
   migrate the private `il2cpp_class_get_field_from_name` resolution of
   `KDAJOMOFMJB` to the `RuntimeOffsets` registry (add a registry row;
   see the existing `HBEAKBIHANL` group), then narrow check 10's directory
   exclusion in **both** guardrail scripts accordingly.

Each rider item ends with the standard verification:
`bash internal/tools/wsl-build.sh Debug` → 0 warnings / 0 errors, and both
guardrail scripts exit 0.
