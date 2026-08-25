# 50 — UDodge Upgrade (post-instant-map): Overview

This is the overview/index for the UDodge upgrade workstream (plans 51-54).
It continues the instantaneous-map UDodge built in plans 44-49 (branch
`refactor/unified-gameapi`). It is NOT itself executable — it records the
target design, the four testable stages, the dependency graph, and the global
verification commands.

Read `docs/plans/44-udodge-instant-overview.md` first for the instant-map
design of record this builds on. That workstream is fully merged: UDodge is a
no-time-dimension engine that rebuilds a spatial `DangerMap` on every server
tick (`WM_TickId` change) and re-anchors to live projectile positions between
ticks.

## The problem this workstream fixes

The instant-map sensing works (danger areas render correctly) and the movement
plumbing works (`DodgeRuntime::CallMoveTo` runs every frame), but the dodge
reacts late/jerky/"throttled". Root cause: with the time/lead dimension
deleted, the SPATIAL reaction margin must be WIDE to compensate, but
`kIntentSafeClearance` was left at 0.08 tiles
(`internal/src/features/movement/udodge/UDodgeTypes.h:32`) — the dodge only
starts moving when a bullet is ~0.08 tiles off the hitbox (essentially
touching) and stops the instant it is 0.08 clear, producing stop-start hugging
of the bullet edge.

A margin-widening change is ALREADY EDITED (uncommitted) into
`UDodgeTypes.h`: `kRelevanceClearance` 1.0→2.0, `kIntentSafeClearance`
0.08→0.60, `kEmergencyIntentBand` 0.14→0.30. That edit is the seed of Stage 1
and must be preserved.

## Target design (four stages, each independently testable in-game)

1. **Wide reaction space** substitutes for the deleted time/lead dimension.
   Keep the widened margin constants and expose the reaction margin
   (`kIntentSafeClearance`) as a LIVE client slider so it can be tuned without
   rebuilds. (Plan 51.)
2. **Tick-hooked pipeline + per-tick move-budget accounting.** Formalize the
   ordered sequence NewTick(applied) → rebuild danger map → decide → execute,
   and track "displacement spent this server tick" keyed on `WM_TickId`, so
   later stages can respect the remaining move budget. (Plan 52.)
3. **Grid-flow search as the primary selector.** Promote the existing
   RePP-derived Dijkstra field escape (`UDodgeField.{h,cpp}`) from a boxed-in
   fallback to the primary geometry brain: run it every tick over a widened
   local danger window, returning the safest reachable spot / first step. The
   fixed-compass scorer stays as a fast path / tie-break. (Plan 53.)
4. **Budget-bounded precise placement.** Two execution modes off the same
   decision: normal `MoveTo` (~95% of the time); pinch = when a hit lands THIS
   tick and smooth `MoveTo` won't interpolate to the clear spot in time, write
   the player position DIRECTLY to the clear point (the TestTAB Ctrl+Click
   teleport primitive, factored into a shared helper), clamped to the REMAINING
   per-tick budget. Sub-tile only. (Plan 54.)

## THE HARD INVARIANT (server-side movement validation)

Total displacement within one server tick must stay `<=` the move budget
(`tilesPerSec × kServerTickSec`, ~1-1.5 tiles). Exceeding it gets the player
rubber-banded back (often into danger) and flagged as a speedhack (ban risk).
`MoveTo` (`FKALGHJIADI::DGLCONCOIBO`) is speed-clamped by the game and cannot
exceed the budget — it is always safe. The DIRECT position write (Stage 4)
BYPASSES that clamp, so Stage 4 is the only place the invariant can be
violated. Plan 52's budget tracker exists to bound it. See the DIVERGENCE /
RISK note below.

## Facts established by the live debugging session (do not re-litigate)

- The instant-map sensing and `CallMoveTo` plumbing both work.
- Sub-1-tile teleports are accepted by live Exalt validation in practice;
  multi-tile raw-writes are NOT (they snap back — see the risk note).
- The tick counter `RuntimeOffsets::WM_TickId` (fallback `0xD8`) is the sync
  source; `UDodge::Sensors::ReadWorldTick` already polls it.

## Key code sites (verified, for all plans)

- Dodge dispatch / update hook:
  `internal/src/features/movement/dodge/DangerPlanner.cpp:721-809`
  (`RunDodgeTickBody` at 721; `UDodge::Tick` dispatched at 775;
  `Detour_AppEngineUpdate` at 805 calls `s_origUpdate` THEN the dodge; the
  hook target is `AppEngineManager::Update`, resolved at 819).
- UDodge per-frame pipeline: `internal/src/features/movement/udodge/UDodge.cpp:180-299`
  (`Tick`: read tick → sync map → build `MapInput` → `Core::Evaluate` →
  `CallMoveTo`).
- Reaction margin use sites (Stage 1 audit):
  `UDodgeCore.cpp:299,304,511,553,571,576,580,605,617` (`kIntentSafeClearance`),
  `UDodgeDebug.cpp:130`.
- Move primitive: `DodgeRuntime::CallMoveTo`
  (`internal/src/features/movement/dodge/MovementRuntime.cpp:139-151`);
  speed/budget source `GetTilesPerSec` (`MovementRuntime.cpp:153-186`).
- Teleport write path (to factor into a shared helper):
  `internal/src/gui/tabs/TestTAB.cpp:800-805` — four `Mem::TryWrite<float>`
  to `RuntimeOffsets::PosX`, `PosY`, `KJ_Float3Pos` (= x), `KJ_Float3Pos+4`
  (= −y). Offsets declared at `RuntimeOffsets.h:106,107,115`.
- Field escape (Stage 3): `UDodgeField.{h,cpp}` (Dijkstra, 21×21 half-tile
  grid, invoked only when boxed-in at `UDodgeCore.cpp:508-534`).
- Client settings pattern: `client/plugins/auto-dodge.ts:280-320,481-489`;
  allowed-key list `client/src/bridge/contract.ts:75-78`; DLL command table
  `internal/src/features/control/FeatureCommandRegistry.cpp:238-254`.

## Plans and dependency graph

| Plan | File | Stage | Depends on |
|---|---|---|---|
| 51 | `51-udodge-reaction-margin-slider.md` | 1 — live reaction-margin slider (keep widened constants) | none (builds on merged 44-49) |
| 52 | `52-udodge-tick-pipeline-budget.md` | 2 — tick-hooked pipeline + per-tick move-budget tracker | 51 (shares `UDodge.cpp`, `UDodgeTypes.h`) |
| 53 | `53-udodge-gridflow-primary.md` | 3 — Dijkstra grid-flow promoted to primary selector | 52 (uses the tick-locked pipeline; shares `UDodgeCore.cpp`) |
| 54 | `54-udodge-budget-teleport.md` | 4 — budget-bounded direct-write teleport (opt-in) | 52 (budget tracker) + 53 (clear-spot target) |

```
51 ──► 52 ──► 53 ──► 54
```

Strictly SEQUENTIAL, by design: each stage is meant to be built, committed, and
tested IN-GAME on its own before the next begins, so the user can isolate the
effect of each change (this is the user's explicit staging requirement, not
only a merge-conflict concern). Do not dispatch any plan before its predecessor
is merged and confirmed working.

## DIVERGENCE / RISK — raw position-write teleport (Stage 4)

`DangerPlanner.h:29-35` and `:142-152` document that an EARLIER raw
position-write teleport (writing `+0x3C/+0x40/+0x68/+0x6C`) "caused server
snap-backs" and was REMOVED in favor of a native-move speed boost, with the
standing instruction: "USE [`NativeMoveTo`] for every movement write ... Raw
writes ... bypass ACTk's rigidbody sync and cause server snap-backs."

Stage 4 deliberately reintroduces a raw position write, but under a NEW
constraint the old one lacked: the teleport delta is CLAMPED to the remaining
per-tick move budget (sub-tile). The debugging session confirmed sub-1-tile
teleports are accepted in practice; the old teleport snapped back because it
moved multiple tiles ignoring the budget. This is the single highest-risk
change in the workstream. Plan 54 gates it behind an opt-in setting (default
OFF) and makes the budget clamp mandatory. If in-game testing shows any
snap-back, disable the setting — the engine falls back to pure `MoveTo` and
stays fully functional.

## Global verification (run after EVERY step of every plan)

```bash
# Internal DLL — Debug config only (the verified WSL path):
bash internal/tools/wsl-build.sh Debug          # → MSBuild reports 0 errors

# Raw-access guardrail — must stay exit 0:
bash internal/tools/check-raw-access.sh

# Client (plans 51 and 54, which touch client/):
cd client && npm run build                      # → tsc clean
```

## Constraints binding every plan in this workstream

- Commit on `refactor/unified-gameapi`. `docs/` is gitignored — plan files are
  working docs, not committed.
- A pre-existing UNCOMMITTED modification to `client/build-tools/dev-build.bat`
  must be left exactly as found (do not stage, revert, or commit it).
- DO NOT modify: `internal/src/features/movement/repp/`, `pjdodge/`, `zdodge/`
  (plan 35 owns their retirement); the cleanup-wave files
  `internal/src/gui/tabs/WorldTAB.cpp`, `internal/src/gui/CamState.cpp`,
  `internal/src/gui/tabs/PlayerTAB.cpp`, `internal/src/gui/tabs/CameraTAB.cpp`,
  `internal/tools/check-raw-access.sh`; and `internal/src/gui/tabs/TestTAB.cpp`
  (the teleport primitive is REUSED by factoring a shared helper elsewhere, not
  by editing TestTAB).
- Behavior-preserving refactors and behavior changes are never mixed in one
  step. Each step leaves the repo compiling and working.
</content>
</invoke>
