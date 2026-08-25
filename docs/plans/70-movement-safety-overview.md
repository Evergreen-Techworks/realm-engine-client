# 70 — Movement-Safety Subsystem Consolidation: Overview & Index

This is the **index and design-of-record** for a focused rework of the RotMG
auto-dodge / navigation / autonexus movement-safety subsystem under
`internal/src/features/movement/udodge/` (plus `dodge/DangerPlanner`,
`combat/autonexus/AutoNexus`, and the `gui/tabs/WorldTAB` occupancy source).
It is **not** itself executable. It records the two hard goals, the current
architecture as it actually works, the unified target design, the full plan
list, the dependency graph, and the global verification commands. Every other
plan (71-78) is self-contained and executable by a single implementer agent
with no context beyond its own file.

This workstream is scoped to the movement-safety subsystem ONLY. It is not the
whole-repo abstraction cleanup (plans 00-44 covered that). Do not widen scope.

## The two hard goals (authoritative, verbatim intent)

1. **"We will not be getting hit by any shots."** The dodge must be
   server-accurate and airtight across the whole pipeline: hit geometry folds
   the player half-extent + latency pad, per-frame re-anchor, mid-tick spawn
   reaction, worker-latency staleness gate, and — critically — the *actual*
   `CallMoveTo` landing must match the *validated* target.
2. **"The game will run at 60 fps no problem"** with all features on.

Every plan is **behavior-preserving unless it is explicitly a behavior plan**
(75 annulus, 76 commitment, 77 autonexus, and the correctness fixes in 78).
Refactor plans (72, 73, 74) must not change dodge behavior. Any real bug found
during a refactor is recorded as a divergence note and fixed in 78, never
smuggled into a refactor step.

## How the subsystem works today (end-to-end model)

**Dispatch.** `DangerPlanner.cpp` hooks `AppEngineManager::Update`
(`DangerPlanner.cpp:811` `Detour_AppEngineUpdate` → `RunDodgeTickBody` →
`DangerPlanner.cpp:781` `UDodge::Tick(p, px, py, dt)`), guarded by an SEH
firewall (`DodgeTickGuarded`, `DangerPlanner.cpp:799`). This is the **game
update thread** — the only thread allowed to touch IL2CPP / live game memory.

**Per-tick flow (`UDodge::Tick`, `UDodge.cpp:255`).**
1. Read settings + steer + autopilot lock (`UpdateAutopilotLock`,
   `UDodge.cpp:184`).
2. **NewTick sync** (`UDodge.cpp:298-313`): poll `WM_TickId`
   (`Sensors::ReadWorldTick`). Same tick → `Sensors::ReanchorMap` (re-anchor
   lanes to live projectile positions; structural mismatch returns false).
   New tick / fail-safe → `Sensors::BuildMap` (full re-enumerate). Map is
   stamped with the tick id.
3. Build `MapInput` and the `Goal` (WASD camera-rotated / walk-to spot /
   boss-lock orbit / none) (`UDodge.cpp:315-408`).
4. **Async planner publish** (`UDodge.cpp:417-452`): rasterize the **dodge
   OccGrid** (`FillOccGrid`, `UDodge.cpp:135`, 0.5-tile, 49×49 = 2401 cells,
   boss-centered when locked) and, when walk-to is active, the **nav NavGrid**
   (`FillNavGrid`, `UDodge.cpp:162`, 1-tile, 81×81 = 6561 cells). Both packed
   into a `PlannerSnapshot`, published to the worker at tick rate.
5. Consume the latest worker route (`TryGetLatestPlan`, `UDodge.cpp:457`) and
   gate its staleness (`UDodge.cpp:476-481`).
6. **Solve** once per rebuilt tick (`Solver::Solve`, `UDodge.cpp:487`); between
   ticks re-validate the cached target and re-solve if it went unsafe
   (`UDodge.cpp:499-524`).
7. Drive toward the target through `DodgeRuntime::CallMoveTo`
   (`UDodge.cpp:533`), clamped to per-frame speed.
8. Publish the debug snapshot (`UDodge.cpp:574-645`).

**Worker (`UDodgeWorker.cpp`).** One dedicated thread, IL2CPP-free, operates on
the plain-data `PlannerSnapshot` and writes a plain-data `PlanResult` through a
non-blocking double-buffered handoff (game thread never blocks). It runs
`Path::Compute` (`UDodgePathfinder.cpp:708`) = `ComputeDodge` (time-expanded
grid Dijkstra to nearest durable-safe pocket, in-range-disk gated, boss-centered
when locked) **then** `ComputeNav` (goal-directed octile A* over the nav grid
for walk-to).

**Core primitives (`UDodgeCore.cpp`).** `PointSafety` (server-accurate
clearance folding `kUPlayerHalf`), `PointSafe`, `LaneDistCheb`, `EnemyBlocked`.
The danger representation `DangerMap` (`UDodgeTypes.h:304`) is a single struct
(lanes + zones + enemies) — this part is NOT duplicated.

**AutoNexus (`AutoNexus.cpp`).** Independent predictive last-resort. Dead-reckons
the player along observed velocity to predict projectile hits. Currently defers
to udodge by zeroing predicted velocity when udodge is enabled
(`AutoNexus.cpp:506`) — a partial contract that needs proper design.

**Occupancy sources — the key divergence.** There is no single occupancy source:
- Dodge grid: `FillOccGrid` → `Sensors::CanOccupy` (`UDodgeSensors.cpp:511`) →
  `TestTAB::IsWalkPositionBlocked` → `IsPositionBlocked` (`TestTAB.cpp:308`),
  which tests a **player-box footprint** (`kPlayerChebyshevScale = 0.2285`,
  `TestTAB.cpp:314-321`) of `WorldTAB::IsTileBlocked` cells **plus a noclip
  override**, locking `s_tileMapMutex` per tile.
- Nav grid: `FillNavGrid` → `WorldTAB::CopyNavBlocked` (`WorldTAB.cpp:2217`),
  a **single-tile** read of `s_blockedMap` (no player footprint, no noclip),
  one bulk mutex acquisition.
- Worker re-derives occupancy from the rasterized grids (`GridBlocked`
  `UDodgePathfinder.cpp:207`, `NavBlocked` `UDodgePathfinder.cpp:509`).

So "is this cell walkable?" is answered **three different ways** with different
footprint semantics. `WorldTAB::s_blockedMap` (`WorldTAB.cpp:99`) is the real
single source of truth for walls.

**Duplicated temporal machinery.** The arrival-time bullet prediction is
implemented **twice, near-identically**: `SampleLaneOverTime` /
`BuildTempCtx` / `TemporalPathClear` in the solver anon namespace
(`UDodgeSolver.cpp:215-292`) and `SampleLaneOverTime` / `BuildTempCtx` /
`ArrivalClear` in the pathfinder anon namespace
(`UDodgePathfinder.cpp:123-202`). Same constants (`kUTemporalSteps`,
`kUTemporalStepMs`, `kUPocketMargin`, `kUPlayerHalf`), same math. The worker
cannot include the solver's copy (anon namespace), so it was copied.

**State ownership.** All engine state is game-thread-owned globals in the
`UDodge` anon namespace: `g_state` (CoreState / last heading), `g_map`
(DangerMap), `g_solve` (cached SolveResult), `g_route` (cached PlanResult),
`g_lastPubSeq`. Debug snapshot is double-buffered under `g_debugMutex` for the
render thread.

## The unified target design

The concepts that need one home, and where they land:

1. **One temporal-prediction core** (plan 72). Extract the duplicated
   arrival-time prediction into shared plain-data helpers in `UDodgeCore` that
   BOTH the game-thread solver and the worker pathfinder call. One copy, one
   set of constants, provably identical behavior.

2. **One occupancy source** (plan 73). `WorldTAB::s_blockedMap` is the single
   truth. Add ONE bulk occupancy reader per grid resolution that both fills
   route through, with ONE agreed footprint semantics. This removes the
   per-cell `CanOccupy` mutex storm (up to ~2401×4 tile-mutex locks per tick →
   one bulk locked pass) AND the three-way footprint divergence. This is the
   single largest measurable perf win in the subsystem.

3. **One search harness / fewer grids** (documented in 73/74). The dodge
   Dijkstra and nav A* stay as two searches (they are genuinely different:
   time-expanded danger Dijkstra vs walls-only octile A*), but they read from
   one occupancy abstraction and share the extracted grid primitives (heap,
   neighbor iteration, reconstruction). A single physical grid at 0.5-tile over
   both radii is rejected on the hot path (25k+ cells); resolution-appropriate
   views of one source is the correct trade.

4. **Inner-standoff annulus** (plan 75). The in-range region becomes an ANNULUS
   `[innerStandoff, weaponRange]` instead of a filled disk, at the goal gate,
   the solver score, and the pathfinder route — robust when the player starts
   inside the inner zone (outward traversal always allowed, never stuck).

5. **Plan commitment** (plan 76). Route-goal hysteresis + heading commitment so
   the controller stops flip-flopping between near-equal goals.

6. **AutoNexus ↔ udodge last-resort contract** (plan 77). AutoNexus fires only
   when udodge has genuinely FAILED (Fallback/Surrounded with the stand
   actually covered), not as a parallel predictor.

7. **Correctness audit** (plan 78). Prove the "never get hit" pipeline is
   airtight end to end on the consolidated code.

### Hot-path rules (respect these in every plan)

- The map rebuild / occupancy rasterize / snapshot publish run at **server-tick
  rate (~5 Hz)**, not per frame — keep it that way. Do not move per-tick work
  into the per-frame path.
- `PointSafety` is called thousands of times per tick (candidate eval + worker
  cell eval). It must stay a tight plain-data loop; do not add allocation,
  IL2CPP, or locks to it.
- The debug heatmap (`DrawWeightGrid`, `UDodgeDebug.cpp:96`) recomputes 2401
  `PointSafety` on tick change (cached) and draws 2401 quads EVERY frame. It is
  opt-in; keep it provably zero-cost when off and reduce its on-cost (plan 74).
- Occupancy grids are wall-static within a server tick — rebuild wall bits only
  on a full map rebuild (already true for the dodge grid; preserve it).

## Release-build requirement (grievance (c): "building DEBUG all session")

All performance claims MUST be validated in a **Release** build. The WSL
wrapper now builds Release cleanly (the old BuildSecrets.h blocker was removed;
see `internal/tools/wsl-build.sh`). Debug is 2-3× slower than Release and its
timing numbers are meaningless for "60 fps" judgments. Every perf plan states
this explicitly and records numbers from a Release build.

## Plans and dependency graph

| Plan | File | Content | Depends on |
|---|---|---|---|
| 71 | `71-perf-baseline-instrumentation.md` | Per-phase timers (Tick + worker), Release-build baseline table. Measurement only, zero behavior change | none |
| 72 | `72-shared-temporal-core.md` | Extract the duplicated arrival-time temporal prediction into `UDodgeCore`; solver + pathfinder call one copy | none |
| 73 | `73-unified-occupancy-source.md` | One bulk `WorldTAB` occupancy reader for both grids; reconcile the three-way footprint divergence | none |
| 74 | `74-debug-overlay-cost.md` | Reduce heatmap draw cost; gate the per-frame TickTimer probe behind a diag flag | 73 |
| 75 | `75-inner-standoff-annulus.md` | In-range disk → annulus `[innerStandoff, weaponRange]` at goal gate, solver score, pathfinder route; robust from inside | 72 |
| 76 | `76-plan-commitment-hysteresis.md` | Route-goal hysteresis + cross-tick heading commitment; kill flip-flop | 75 |
| 77 | `77-autonexus-lastresort-contract.md` | AutoNexus fires only on genuine udodge FAILURE; add the `UDodge` failure query | none |
| 78 | `78-never-get-hit-audit.md` | End-to-end safety audit + fixes on the consolidated pipeline | 72, 73, 75, 76 |

```
Wave A (parallel):   71    72    73    77
Wave B:                    │     │
                          75    74
Wave C:                    │
                          76
Wave D:              78 (after 72, 73, 75, 76)
```

- **71, 72, 73, 77** are independent and may be dispatched in parallel.
- **74** depends on **73** (both edit `UDodge.cpp`; 73 owns `FillOccGrid`, 74
  owns the TickTimer + debug publish — sequenced to avoid a merge conflict).
- **75** depends on **72** (both edit `UDodgeSolver.cpp` + `UDodgePathfinder.cpp`;
  72 lands first so 75 edits the post-dedup code).
- **76** depends on **75** (both edit the solver + `UDodge.cpp` route caching).
- **78** depends on **72, 73, 75, 76** — it audits the final consolidated code.

Sequencing rationale: refactors (72, 73) land before behavior plans (75, 76) so
the behavior work happens on deduplicated code; the correctness audit (78) runs
last so it validates the shipped pipeline, not an interim one.

## Global verification (run after EVERY step of EVERY plan)

```bash
# Build (Debug — the fast iteration path; must be 0 errors after every step):
bash internal/tools/wsl-build.sh Debug

# Raw-access guardrail (must stay exit 0 — no new raw IL2CPP in features/gui):
bash internal/tools/check-raw-access.sh

# Perf validation (Release ONLY — required for any "fps"/"ms" claim):
bash internal/tools/wsl-build.sh Release
# → copy C:\rebuild\Release\bin\realm-engine.dll to client/assets/ and measure in-game.
```

Success for a refactor plan = builds clean, guardrail exit 0, and the plan's
own behavior-parity check (overlay/log identical to before). Success for a
behavior plan = its stated in-game/overlay change is observed and no regression
in the "never get hit" invariant.

## Branch / files owned by concurrent work

All commits go on the current branch (`refactor/unified-gameapi`). The
uncommitted modifications to `client/build-tools/dev-build.bat`,
`client/build-tools/sync-and-build.bat`, `client/scripts/build-prod.mjs`, and
the untracked `client/assets/injector.exe` are pre-existing — do NOT stage,
revert, or commit them. `WorldTAB.cpp` was previously owned by an earlier
cleanup wave; plan 73's edits to it are purely additive (a new bulk reader) to
minimize any conflict — see 73's own guidance.
