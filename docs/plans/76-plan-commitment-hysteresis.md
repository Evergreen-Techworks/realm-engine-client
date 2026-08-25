# 76 — Plan Commitment / Anti-Flip-Flop Hysteresis

## Goal
After this plan, the planner **commits** to a chosen route/goal and stops
"cancelling on a dime" when two near-equal safe goals exist. The worker's route
goal is held across ticks with hysteresis (a new goal must be meaningfully better
to win), and the game-thread heading commitment is strengthened so the drive is
smooth. Safety stays fully authoritative — commitment only chooses AMONG
equally-safe options; a goal that becomes unsafe is dropped immediately.

## Dependencies
Depends on **75** (annulus) — 75 lands first; both edit the solver and the goal
plumbing. Files touched: `UDodgePathfinder.{h,cpp}` (route-goal hysteresis in the
Dijkstra target selection), `UDodgeTypes.h` (hysteresis constants),
`UDodge.cpp` (carry the previously-committed goal into the snapshot, hold
`g_solve` more sensibly), `UDodgeSolver.cpp` (heading commitment strength).

## Current state — where the flip-flop comes from
1. **The worker re-solves the route every tick from scratch** (`RunSearch` →
   `SearchPass`, `UDodgePathfinder.cpp:276-346`). It early-exits at the durable
   goal reached SOONEST (min arrival time, `UDodgePathfinder.cpp:302-305`). When
   two pockets have near-equal arrival times, tiny per-tick changes in the danger
   map flip which one wins, so `out.goalPos` / `out.stepTarget` jump between them.
   Nothing carries the previous goal forward as a tiebreak.
2. **Partial routes swing too** (`partialIdx`, `UDodgePathfinder.cpp:306-310`):
   the "safest reachable-in-time cell" changes as safety values wobble.
3. There is a heading anti-oscillation guard already (`kURouteReverseDot`,
   `UDodgeSolver.cpp:439-450`) that damps a hard REVERSAL of the committed
   heading — but only for a >105° flip, and only for the pre-position step. It
   does not stop a repeated left/right toggle between two goals at ~90°.
4. The solver's continuity term `kSolveCommitW = 1.0` (`UDodgeTypes.h:45`,
   `UDodgeSolver.cpp:66-67`) rewards continuing `state.lastMoveDir`, but it is
   one term among several and is easily outvoted by `kSolveGoalW` /
   `kSolvePerpW` when the goal itself flipped.

Net: the *goal* flips at the worker, and the solver faithfully chases the flipped
goal, so the player jitters between two near-equal options.

## Target design
Add hysteresis at the **goal-selection** layer (the root cause), plus a modest
heading-commitment reinforcement.

### 1. Route-goal hysteresis in the worker
Carry the previously-committed goal into the snapshot and prefer it.

Add to `PlannerSnapshot` (`UDodgePathfinder.h`):
```cpp
bool prevGoalValid = false;
Vec2 prevGoalPos{};        // last tick's committed durable-safe goal (world)
```
The game thread sets these from the last accepted `g_route.goalPos`
(`UDodge.cpp`, in the publish block): `s_snap.prevGoalValid = g_route.found;
s_snap.prevGoalPos = g_route.goalPos;`.

In `RunSearch` / `SearchPass`, when a durable goal is found, DON'T just take the
first (soonest) — apply hysteresis toward the previous goal:
- If the previous goal cell is still a valid durable in-annulus goal this pass
  (re-test it with `EvalCell` + the annulus gate) AND its arrival time is within
  `kURouteGoalHystMs` of the best new goal's arrival time, **keep the previous
  goal**. Otherwise take the new best.
- Concretely: run the search to completion enough to know the best goal's arrival
  time; if `prevGoal` is reachable-in-time and `t(prevGoal) <= t(best) +
  kURouteGoalHystMs`, set `target = prevGoalCell`. This is cheap: the previous
  goal is one cell; test it during the same pass (track its index + arrival time
  when the Dijkstra relaxes it).

Add constants to `UDodgeTypes.h`:
```cpp
constexpr float kURouteGoalHystMs   = 120.f;  // keep the old goal unless a new
                                              // one arrives this much sooner
constexpr float kURouteGoalHystTiles = 1.5f;  // ...or is this much closer (for
                                              // the partial-route case)
```
For the **partial** route (no durable goal), apply the same idea by distance:
keep `partialIdx = prevGoalCell`'s nearest reachable cell if the new
`partialSafety` improvement over holding the old target is `< small`, i.e. only
switch when the new partial is meaningfully safer (reuse `kPartialGainTiles`
already at `UDodgePathfinder.cpp:266`, but compare against the OLD target's
safety, not just the start's).

### 2. Reject a stale-but-still-valid re-solve churn on the game thread
`UDodge::Tick` re-solves only on `rebuilt` (`UDodge.cpp:487`) and re-validates
between ticks — that part is fine. But the mid-tick forced re-solve
(`UDodge.cpp:518-524`) runs a fresh `Solver::Solve` whenever the cached target
went unsafe, which can pick a different goal. That is correct for SAFETY (the old
target became unsafe). Leave it. Do NOT add hysteresis that would delay dropping
an unsafe target — safety must win instantly.

### 3. Heading commitment reinforcement (solver)
- Raise the effective weight of continuity when the previous heading is still
  safe: in `ScoreCand` (`UDodgeSolver.cpp:66-67`), keep `kSolveCommitW` but add a
  small BONUS when the candidate direction closely matches `prevDir` AND the
  candidate is safe, so near-equal options break toward "keep going". Simplest:
  bump `kSolveCommitW` from 1.0 to a tuned value (e.g. 1.5) OR add a
  `kSolveCommitBonus` for `Dot(dir,prevDir) > 0.9`. Prefer the explicit bonus so
  the base term is untouched.
- Broaden the anti-oscillation guard: the current guard only fires on a hard
  reversal (`Dot < kURouteReverseDot = -0.25`). Add a second, softer branch: if
  the fresh route step differs from the committed heading by more than ~60°
  (`Dot < 0.5`) but continuing the committed heading is STILL walkable +
  enemy-free + temporally clear, prefer continuing for one more tick. This kills
  the ~90° left/right toggle. Gate it behind a small "committed for at least one
  tick" counter so it never delays a genuine required turn indefinitely (max N
  consecutive damped ticks, then accept the new step).

Add to `CoreState` (`UDodgeTypes.h:360`): `uint8_t dampStreak = 0;` reset in
`Reset()`. In the guard, increment on damp, clear on accept, and stop damping
once `dampStreak >= kUMaxDampTicks` (e.g. 3).

### Divergence / safety warnings
- Hysteresis applies ONLY to choosing among **safe** goals/cells. It must never
  keep a goal or heading that is unsafe: the goal-hysteresis re-tests the previous
  goal with `EvalCell` each pass (dropped the instant it stops being durable), and
  the heading damp re-tests the continuation with the full temporal + occupancy +
  enemy floor (same as the route step). If either fails, take the new option
  immediately.
- Do NOT add wall-clock hysteresis timers on the game thread — commitment is
  tick-locked (per the plan-44 design). The `kURouteGoalHystMs` is compared
  against **arrival-time estimates within one solve**, not wall-clock.

## Steps

1. Add constants (`kURouteGoalHystMs`, `kURouteGoalHystTiles`,
   `kUMaxDampTicks`, and `kSolveCommitBonus` if used) to `UDodgeTypes.h`. Add
   `prevGoalValid`/`prevGoalPos` to `PlannerSnapshot`, `dampStreak` to
   `CoreState`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. In `UDodge.cpp` publish block, set `s_snap.prevGoalValid`/`prevGoalPos` from
   the last committed `g_route.goalPos`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. In `UDodgePathfinder.cpp` `RunSearch`/`SearchPass`, track the previous goal
   cell's index + arrival time during the pass; after the search, apply the
   arrival-time hysteresis to choose `target` (keep previous goal when within
   `kURouteGoalHystMs`). Apply the distance-based hysteresis for the partial case.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: the route
   goal marker stops toggling between two near-equal pockets.

4. In `UDodgeSolver.cpp`, add the heading-commitment bonus and the softened
   anti-oscillation branch with the `dampStreak` cap. Keep the existing hard-
   reversal branch.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. In-game tuning pass (Release): confirm the player commits to a route, stops
   the left/right jitter between equal goals, and still turns promptly when the
   old heading genuinely becomes unsafe (verify by forcing a new shot onto the
   committed path — the player must break commitment instantly).

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- In-game: with two near-equal safe pockets, the route goal + heading no longer
  oscillate tick-to-tick (watch the overlay route goal + the `[UDodge] MOVE`
  `stepDot` log — `stepDot` stays near 1, `DAMPED` appears only briefly then
  clears). A shot placed on the committed path still triggers an immediate break
  (safety wins — no stuck commitment).
- Regression guard: the "never get hit" invariant is unchanged — commitment only
  chooses among safe options.

## Out of scope
- Do NOT add wall-clock hysteresis or delay unsafe-target drops.
- Do NOT change the annulus (plan 75) or occupancy (plan 73).
- Do NOT touch autonexus (plan 77).
- Keep the commitment purely a tiebreak among safe choices — never a safety
  override.
