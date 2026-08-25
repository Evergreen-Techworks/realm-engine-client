# 55 — UDodge Background Planner + Boss Autopilot: Overview

This is the overview/index for the UDodge autopilot workstream (plans 56-62). It
continues the instantaneous-map UDodge from plans 44-54 on branch
`refactor/unified-gameapi`. It is NOT itself executable — it records the target
design, the thread-boundary contract, the six testable stages, the dependency
graph, and the global verification commands.

Read `docs/plans/44-udodge-instant-overview.md` (instant-map design of record)
and `docs/plans/50-udodge-upgrade-overview.md` (reaction-margin / budget /
grid-flow direction) first. Plan 51 is merged (live reaction-margin slider,
commit `dc7e077`). Plans 52-54 were NEVER merged — this workstream SUPERSEDES
them: the tick-pipeline/budget idea (52) folds into Stage C, grid-flow-primary
(53) folds into Stage D, and the direct-write teleport (54) is deferred (see
"Out of scope").

## What this workstream delivers (the user's firm goal)

A dedicated **background/multithreaded dodge + planner** that draws paths around
the WHOLE local map for automated boss fighting (orbit / range-keeping / boss
lock / autopilot) like the older RePP engine — **decoupled from render frame
rate** — PLUS reliable dodging. Delivered in six stages, each independently
in-game testable and gated so the user tests between them.

## The two pre-existing bugs that block everything (fix FIRST)

Nothing else works until these are fixed. They are thread-independent.

1. **Empty threat map (`threats=0`).** Live logs show bullets captured
   (`[ProjectileTracking] Install: spawn hook INSTALLED`), speed and MoveTo
   resolve, yet `[UDodge] NO-MOVE dec=1(NoThreat) ... standClr=1e+09 threats=0`
   prints continuously. Fixed by **Plan 56 (Stage A)**. Root-cause analysis and
   the diagnostic bisection protocol are in that plan.
2. **Emergency/field zero-velocity.** `[UDodge] MOVE dec=6(EmergencyOverride)
   ov=1 |v|=0 -> (target==player)` — when surrounded the selection picks stand
   (dir {0,0}) → zero velocity → no move, even though the field escape's pocket
   marker is drawn. Fixed by **Plan 57 (Stage B)**.

## THE THREAD-BOUNDARY CONTRACT (mandatory — naive threading crashes)

IL2CPP game objects (projectiles, player, entities, tiles) may ONLY be read on
the **game-update thread** (the `AppEngineManager::Update` detour at
`internal/src/features/movement/dodge/DangerPlanner.cpp:805`, which calls
`RunDodgeTickBody` → `UDodge::Tick`). Reading or walking IL2CPP objects, or
calling IL2CPP methods, from a worker thread races the GC and crashes.

Safe split:

- **GAME thread** (`UDodge::Tick`): does ALL live IL2CPP reads — builds/re-anchors
  the `DangerMap` (already plain data), reads player/intent/speed/tick, and
  **rasterizes** a plain-data occupancy+hazard grid over the local window
  (calling `Sensors::CanOccupy` / `Sensors::IsHazardAt` per cell — these are the
  only functions that touch live world memory). It packs all of this into a
  plain-data `PlannerSnapshot`, publishes it lock-free, reads the worker's
  latest `PlanResult`, feeds the plan's first-step direction to the game-thread
  dodge `Core::Evaluate` as `intentDir`, and **executes** movement via
  `DodgeRuntime::CallMoveTo` (always game-thread).
- **WORKER thread**: runs the expensive **whole-window path planner**
  (Dijkstra/A* over the rasterized grid to the boss-orbit goal, routing around
  walls / hazards / danger) purely on the plain `PlannerSnapshot`, at a high
  fixed rate decoupled from FPS. Publishes a plain-data `PlanResult` (chosen
  direction + full path polyline for drawing). It NEVER touches IL2CPP.

**Why the dodge stays reliable and low-latency:** the cheap per-frame compass
dodge `Core::Evaluate` (35 candidates) stays ON the game thread, so bullet
reaction is bounded by frame time, not by the worker cycle. The worker only
owns the EXPENSIVE whole-map routing that would otherwise blow the frame budget.
The dodge naturally **pre-empts** the planned path: the worker's route is
consumed as an *overridable intent*, exactly as WASD intent is today
(`UDodgeCore.cpp:554-560` preserves a safe intent but overrides it the instant
it is unsafe).

### Data that crosses the thread boundary — proof it is all plain-data

- **Game → Worker: `PlannerSnapshot`** — contains `DangerMap` (already pure
  plain data: `LaneThreat`/`ZoneThreat`/`EnemyBlocker` hold only `Vec2`/scalars,
  no pointers — `UDodgeTypes.h:118-148`), a rasterized `OccGrid` (fixed
  `uint8_t[]` walls + hazard), and scalars (`Vec2 player`, `Vec2 intentDir`,
  `float speed`, `float stepTiles`, `Settings`, `uint32_t tickId`, boss-lock
  `bool/Vec2/float`). No IL2CPP handle, no `void*`, no `Env` function pointers
  (those stay game-thread-only).
- **Worker → Game: `PlanResult`** — `Decision`, `Vec2 firstDir`, `float
  speedScale`, `bool valid`, `uint32_t forTickId/forSeq`, and a fixed-size
  `Vec2 path[]` polyline for drawing. All plain.
- **Handoff:** two triple-buffers (or double-buffer + `std::atomic<uint32_t>`
  publish index) — lock-free on the hot path. The worker copies the snapshot
  under the atomic-index protocol into its own local storage before planning, so
  the game thread may overwrite the next buffer freely.

## The six stages

| Plan | File | Stage | Content | Depends on |
|---|---|---|---|---|
| 56 | `56-udodge-fix-empty-threatmap.md`     | A | Diagnose + fix the empty threat map so the dodge sees bullets and moves | none (builds on merged 44-51) |
| 57 | `57-udodge-fix-emergency-zero-velocity.md` | B | Non-degenerate escape direction + emergency never issues a zero move | 56 |
| 58 | `58-udodge-planner-seam.md`            | C1 | Extract plain-data `PlannerSnapshot`/`PlanResult` + `Planner::Compute`, run SYNC on game thread (behavior-preserving) | 57 |
| 59 | `59-udodge-worker-thread.md`           | C2 | Move `Planner::Compute` onto a background worker; lock-free snapshot/plan handoff; FPS-decoupled | 58 |
| 60 | `60-udodge-wholemap-planner.md`        | D1 | Upgrade `Planner::Compute` to whole-window Dijkstra path routing + draw the path overlay | 59 |
| 61 | `61-udodge-boss-autopilot.md`          | D2 | Boss lock / orbit / range-keeping goal loop + dodge-override precedence + settings + client wiring | 60 |
| 62 | `62-udodge-diagnostics-cleanup-guardrails.md` | — | Remove the `DBG_FILE_LOG` diagnostics, keep the CameraTAB spam fix, add a grep guardrail | 61 |

```
56 ──► 57 ──► 58 ──► 59 ──► 60 ──► 61 ──► 62
```

**Strictly SEQUENTIAL by design.** This is the user's explicit staging
requirement (each stage built, committed, and tested IN-GAME before the next),
not only a merge-conflict concern — they all touch `udodge/`. Do NOT dispatch any
plan before its predecessor is merged and confirmed working in-game.

## Diagnostics already in the tree (plan for them)

The user left `DBG_FILE_LOG` diagnostic lines in `UDodge.cpp` (the `MOVE`/
`NO-MOVE` blocks and `MOVE`/BuildMap logs) and in `UDodgeSensors.cpp`
(`BuildMap rawProjs=` / `BuildMap DONE lanes=`), plus an UNCOMMITTED CameraTAB
log-spam fix. Stages A-D KEEP these diagnostics (they are the in-game debugging
lifeline). **Plan 62** removes the UDodge `DBG_FILE_LOG` diagnostics after the
feature is proven, and preserves the CameraTAB spam fix.

## Move-budget risk (server-side movement validation)

Total displacement within one server tick must stay ≤ the move budget
(`tilesPerSec × kServerTickSec` ≈ 1-1.5 tiles) or the server rubber-bands the
player and flags a speedhack. `MoveTo` (`FKALGHJIADI::DGLCONCOIBO`,
`MovementRuntime.cpp:139-151`) is speed-clamped by the game and is always safe —
this workstream uses ONLY `MoveTo`. No raw position write is introduced here (the
plan-54 teleport is deferred). Therefore this workstream cannot violate the
budget. The one thing to watch: the worker must never produce a plan whose
first-step direction, when executed via `MoveTo`, would still be interpolated —
it cannot, because `MoveTo` self-clamps.

## Global verification (run after EVERY step of every plan)

```bash
# Internal DLL — Debug config only (the verified WSL path):
bash internal/tools/wsl-build.sh Debug          # → MSBuild reports 0 errors

# Raw-access guardrail — must stay exit 0:
bash internal/tools/check-raw-access.sh

# Client (plans 61 touches client/):
cd client && npm run build                      # → tsc clean
```

## Constraints binding every plan in this workstream

- Commit on `refactor/unified-gameapi`. `docs/` is gitignored — plan files are
  working docs, not committed.
- Only touch: `internal/src/features/movement/udodge/**`; shared dodge infra
  (`DangerPlanner`, `ProjectileTracking`, `AoeTracking`, `MovementRuntime`,
  `ProjectileStore`) AS NEEDED; and `client/plugins/auto-dodge.ts` +
  `client/src/bridge/contract.ts` + `FeatureCommandRegistry.cpp` for settings.
- DO NOT modify: `internal/src/features/movement/repp/`, `pjdodge/`, `zdodge/`
  (plan 35 owns their retirement — read RePP as reference only); the cleanup-wave
  files `internal/src/gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp`,
  `gui/tabs/PlayerTAB.cpp`, `gui/tabs/CameraTAB.cpp`, `internal/tools/check-raw-access.sh`;
  and `internal/src/gui/tabs/TestTAB.cpp` (the teleport primitive is REUSED by
  factoring a shared helper elsewhere, not by editing TestTAB — and only if a
  later plan needs it, which this workstream does not).
- Leave the UNCOMMITTED `client/build-tools/dev-build.bat` exactly as found.
- Behavior-preserving refactors and behavior changes are never mixed in one step.
  Each step leaves the repo compiling and behaving as its stage intends.
```
