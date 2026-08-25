# 90 — UDodge Accuracy/Tightness Overhaul — Overview

## Scope & goal
Make the existing auto-dodge (`internal/src/features/movement/udodge/`)
measurably TIGHTER and more accurate — toward "dodges every shot, never gets
hit, while staying aggressive" — WITHOUT weakening any safety floor. This is
**solver / sensor MATH ONLY**. Explicitly out of scope: offset/binding plumbing
(`RuntimeOffsets`, `PlayerCollider`, `ProjectileTracking` — Phase 1, done) and
new features (killaura/autofire — Phase 2, parallel). Do NOT add game features.

The four target behaviors and the plan that addresses each:
1. **Pixel-perfect dodging** (thread gaps as tightly as server-accurate
   collision allows; stop fleeing shots that would miss) → **91** (margin
   separation + tightening) with the safety invariants in **95**.
2. **Tight weaving** (accept a gap clear at arrival-time even if a bullet is
   near it now; weave between/in front of shots, don't flee to open space) →
   **91** (arrival margin) + **92** (scoring reward for threading vs fleeing).
3. **Stay in weapon range around a locked boss** (hold the annulus
   `[innerStandoff, weaponRange]`, don't drift out during a barrage) → **93**.
4. **Commit to a plan** (no jitter / rapid re-planning / cancelling a good
   dodge) → **94**.
5. Cross-cutting **arrival-time robustness** (horizon/step so the never-accept-
   an-unsafe-gap invariant holds under fast/slow shots) → **95**.

## How the dodge works today (end-to-end model)

Two-rate MPC: a game-thread micro-dodge safety floor + an async worker grid
pathfinder, sharing one temporal solver core.

- **Sensors (game thread)** — `UDodgeSensors::BuildMap` (per server tick,
  ~5 Hz) and `ReanchorMap` (per frame). Produce a plain-data `DangerMap`:
  `LaneThreat[]` = bullet polylines with per-point arrival times
  (`points[]`, `pointTimesMs[]`, `points[0]`=live), `ZoneThreat[]` = AOE discs
  (`active`=hard / pending=soft cost), `EnemyBlocker[]` = mob bodies (single
  baked `kEnemyRadius=0.8`), plus `hasLock/lockId/lockPos`. Lanes trace via
  cached path → fresh `ComputePosAt` → straight extrapolation
  (`UDodgeSensors.cpp:287-312`).
- **Core primitives (host-independent math, `UDodgeCore`)** —
  `PointSafety` (server-accurate: `LaneDistCheb − (hitHalf·scale + kUPlayerHalf)`,
  `UDodgeCore.cpp:125-142`), `PointSafe` (occupancy + `PointSafety ≥ pad`),
  `SegmentSafety` (swept, `:157-184`), `EnemyBlocked` (`:186-194`), and
  `Core::Temporal` — the shared arrival-time model: `Build`/`SampleLane`/
  `BulletPosAt`/`PathClear` (solver: walk straight to P + hold, clear at every
  march step) / `ArrivalClear` (pathfinder: stand at B over `[tA,tB]`, swept).
- **Solver (game thread, per tick, `UDodgeSolver::Solve`)** — builds a candidate
  set (stand + 4 rings × 32 headings + goal-dir + pocket-dir,
  `UDodgeSolver.cpp:125-182`), evaluates occupancy + `PointSafety`
  (`Evaluate`, `:196-205`), then a decision cascade: HOLD if the stand is a
  durable temporal pocket (`:295-345`) → PRE-POSITION along the worker route
  step, temporally validated + anti-oscillation damped (`:354-411`) →
  conservative reflex among `instSafe` OR `tempSafe` candidates scored by
  `ScoreCand` (`:413-465`) → Fallback max-min-clearance (`:467-505`) →
  Surrounded hold. `ScoreCand` (`:59-123`) = commit + goal-progress +
  perp-sidestep + move-penalty + comfort + out-range + inner-standoff + stand.
- **Worker pathfinder (worker thread, `UDodgePathfinder::Compute`)** —
  `ComputeDodge`: time-expanded Dijkstra (`RunSearch`/`SearchPass`, edge cost =
  ARRIVAL TIME, each edge gated by `ArrivalClear`, goal = durable-safe cell in
  the annulus, radius-expanding) with plan-76 goal hysteresis; `ComputeNav`:
  octile A* walk-to. Publishes a plain `PlanResult` (route, `stepTarget`,
  `goalPos`).
- **Driver (game thread, `UDodge::Tick`)** — reads player, builds/re-anchors the
  map, constructs the `goal` (WASD → walk-to → boss-lock annulus orbit,
  `UDodge.cpp:590-644`), publishes the snapshot to the worker at tick rate
  (`:646-706`), consumes the latest route (staleness-gated, `:742-749`), solves
  once per tick (`:755-758`), re-validates the cached target EVERY frame
  (`:764-823`), drives via speed-clamped `CallMoveTo` (`:828-837`).

Key constants (`UDodgeTypes.h`): `kUPlayerHalf=0.2139` (bullet-hit half, folded
into `PointSafety`), `kUOccPlayerHalfEdge=0.2285` (wall-collision half-edge —
DISTINCT, used only for occupancy; NOT a duplicate, do not conflate),
`kULatencyPad=0.05` (safety pad beyond hit geometry = the spatial reflex floor),
`kUPocketMargin=0.18` (durable-pocket clearance AND temporal comfort AND
hold-durability — triple-purposed; see gap G1).

## Gap analysis (per goal, with evidence)

### G1 — Margins are inconsistent and triple-counted (Goals 1 & 2)
`kUPocketMargin` (0.18) is used for three conceptually different jobs:
- durable-pocket / goal definition: `PointSafety ≥ kUPocketMargin`
  (`UDodgePathfinder.cpp:178`, `:672`; solver hold floor uses `kULatencyPad`).
- **temporal arrival comfort**: added on top of the already-server-accurate
  `c.half` inside `PathClear`/`ArrivalClear`
  (`UDodgeCore.cpp:278`, `:304`; `c.half` already includes `kUPlayerHalf` at
  `:246`).
- the reflex time-threaded clamp: `sc.clr = max(sc.clr, kUPocketMargin)`
  (`UDodgeSolver.cpp:443`).

Net effect: the SPATIAL reflex (flee) accepts a point at `hit + 0.05`
(`kULatencyPad`), but the TEMPORAL thread (weave in front of / between shots)
demands `hit + 0.18` — the tight path is **3.6× more padded than the flee
path**, which is backwards for tightness. And because the same constant governs
"comfortable resting pocket" and "how close I may thread a moving bullet in
time," the two cannot be tuned independently. **This is the single biggest
tightness lever.** Fix in 91: split into `kUArrivalMargin` (thread comfort,
tightenable) and `kUDurablePocketMargin` (rest/goal comfort, unchanged).

### G2 — The objective rewards clearance (comfort) → biases toward fleeing (Goal 2)
`ScoreCand` gives every candidate a comfort reward `kSolveClearW·min(clr,
kSolveClearComfort)` (`UDodgeSolver.cpp:96`, up to +0.25 for a 1.0-tile-clear
flee spot), while a time-threaded candidate is flattened to `clr=0.18`
(`:443`) → +0.045. So an open-space flee out-scores a tight in-gap thread on
comfort alone; only the move-distance penalty (`kSolveMoveW=1.2`) pulls back
toward the nearer thread. There is NO explicit reward for "stay in the gap /
weave in front" versus "flee to open space." For aggressive tight play we WANT
the thread preferred when it is safe at arrival-time. Fix in 92.

### G3 — Stay-in-range is a weak soft score; drift-out during a barrage is slow to recover (Goal 3)
The annulus `[innerStandoff, weaponRange]` IS implemented (plan 75):
`kSolveOutRangeW=1.6`/tile-out and `kSolveInnerW=1.6`/tile-in in `ScoreCand`
(`UDodgeSolver.cpp:101-116`), the pathfinder goal gate
(`UDodgePathfinder.cpp:178-187`), and the `repositionInward` hold exception
(`UDodgeSolver.cpp:295-315`). Gaps: during SUSTAINED dodging the reflex chooses
among safe cells and the out-range penalty (1.6/tile) competes against comfort
(+0.25) and a large flee clearance — the pull back into range is weak, so the
player drifts far out and returns slowly (`repositionInward` only fires when the
stand is already durable AND outside range, not while actively dodging). Fix in
93: strengthen and make range-holding first-class, add an active return drive.

### G4 — Commitment does not cover the reflex branch; brief holds wipe it (Goal 4)
Plan-76 hysteresis (`kURouteGoalHystMs`, `dampStreak`, soft/hard damp) applies
ONLY to the worker goal and the PRE-POSITION route step
(`UDodgeSolver.cpp:354-411`). The conservative REFLEX (the common dense-fire
path, `:413-465`) picks purely by per-tick score with only the soft
`kSolveCommitW` term — no damp / no hysteresis floor — so it can still jitter
between near-equal safe cells. Worse, `state.lastMoveDir = {}` is wiped on every
Hold (`:312`), so a single safe frame erases the committed heading and the next
dodge can start in a reversed direction. Fix in 94: carry commitment through the
reflex and through brief holds.

### G5 — Arrival-time horizon is short and clamps to a frozen bullet (Goals 1, 2 robustness)
The temporal horizon is `kUTemporalSteps=5 × kUTemporalStepMs=100 = 500 ms`
(`UDodgeTypes.h:139-142`); beyond it `BulletPosAt`/`SampleLane` CLAMP the bullet
to its last sample (`UDodgeCore.cpp:219`, `:255-260`). A durable HOLD is judged
over only 500 ms, and a bullet still approaching at 500 ms is frozen — so a
slow-closing wall can be under-counted on the hold side, and the coarse 100 ms
step relies entirely on the swept-segment check to not tunnel fast shots. This
is the invariant that guarantees "never accept a gap not clear at arrival-time";
91's tightening and 92's thread-preference both lean harder on it, so 95 hardens
it (longer/adaptive horizon, step sizing) — conservative, safety-positive.

## Non-issues (read, deliberately NOT changed)
- `kUPlayerHalf` (0.2139, bullet hit) vs `kUOccPlayerHalfEdge` (0.2285, wall
  collision) are DIFFERENT quantities used in different tests
  (`UDodgeTypes.h:36-45`), not a duplicate — leave both.
- The fixed `kULatencyPad=0.05` spatial floor is thin for very fast shots
  (plan 78 Hole E deferred a speed-aware pad). Making it speed-aware is
  safety-positive but trades aggression; it is DEFERRED here (out of the 90-95
  scope) and only referenced by 95 as an option. Do not ship it blind.

## The plans

| # | Title | Axis | Safety direction |
|---|-------|------|------------------|
| 91 | Arrival vs durable margin separation & tightening | margin math | rename = neutral; tighten = gated tightness |
| 92 | Tight-weave scoring (prefer thread over flee) | solver objective | neutral (chooses among safe only) |
| 93 | Stronger stay-in-range annulus hold | solver objective + goal | neutral (chooses among safe only) |
| 94 | Reflex-branch commitment / anti-jitter | solver state | neutral (chooses among safe only) |
| 95 | Arrival-time horizon & swept-step robustness | temporal core | safety-positive (more conservative) |

## Dependency graph & execution order

```
        91 (margins: Types, Core, Solver:443, Pathfinder:178/672)
       /   \
      v     v
     92     95            92 → 93 → 94  (all edit UDodgeSolver.cpp ScoreCand/Solve — SERIAL)
     |
     v
     93                  95 edits Core+Types only → concern-disjoint from 92/93/94
     |                   (but see BUILD-INFRA — builds are serial regardless)
     v
     94
```

- **91 is the foundation** (introduces the split margin names the reflex and
  pathfinder use). Land it first. Its step 1 is a pure rename (zero behavior
  change); its step 2 is the gated tightening.
- **92 → 93 → 94 are SEQUENTIAL**: all three edit `UDodgeSolver.cpp`
  (`ScoreCand` and/or `Solve`) and would conflict. Each depends on the prior
  being merged. They also read constants added in 91.
- **95 depends only on 91** (both touch `UDodgeCore` temporal + `UDodgeTypes.h`)
  and is concern-disjoint from 92/93/94 (it edits `UDodgeCore.cpp`/`.h` +
  `UDodgeTypes.h`, not the solver objective). It MAY be authored in parallel
  with 92-94, but see the build-infra note.

Recommended merge order: **91 → 95 → 92 → 93 → 94** (get both foundations +
the safety hardening in before the objective changes that lean on them).

## BUILD-INFRA NOTE (read before dispatching implementers)
`internal/tools/wsl-build.sh` writes intermediates and the DLL to a SHARED
output dir `C:\rebuild\Debug` (see the script's `OUT="C:\\rebuild\\${CONFIG}"`).
**Two implementers building concurrently CLOBBER each other's obj/PCH/DLL.**
Therefore, even the plans marked "parallel-safe by files" (91↔95, and 95↔92-94)
MUST run their BUILDS serially, or each implementer must pass a distinct
`OutDir`/`IntDir`. Do not dispatch two agents to run `wsl-build.sh Debug` at the
same time. Given 92→93→94 are already a serial chain and 91 gates everything,
the safest operating mode is: run all five plans serially in the order above.

## Global verification (every plan)
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after EVERY step.
- `bash internal/tools/check-raw-access.sh` → exit 0 (these plans stay inside
  `features/movement/udodge/` and add no raw game access).
- In-game (Release recommended for realistic timing) per each plan's
  Verification. The hard bar across all plans: **the "never get hit" invariant
  never regresses** — a change that could accept an unsafe point must be gated
  behind an explicit clearance/arrival check and flagged.

## Invariants every plan must preserve (non-negotiable)
1. Never accept a candidate/step/hold that is NOT clear at ARRIVAL time
   (`Core::Temporal::PathClear`/`ArrivalClear` remain the gate; any margin they
   apply must stay `≥ 0` beyond the server hit geometry).
2. Never path/step/hold ON an enemy body (`EnemyBlocked`/`EnemyBlockedLocal`
   stay hard exclusions).
3. Never weaken the spatial reflex floor (`PointSafety ≥ kULatencyPad` +
   `SegmentSafety ≥ kULatencyPad` for `instSafe` acceptance).
4. Commitment / annulus / comfort terms only choose AMONG already-safe options —
   never override safety, never delay dropping an unsafe target.
</content>
</invoke>
