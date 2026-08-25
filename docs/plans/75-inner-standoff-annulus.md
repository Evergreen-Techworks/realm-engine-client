# 75 — Inner-Standoff Annulus (disk → `[innerStandoff, weaponRange]`)

## Goal
After this plan, when a boss is locked the in-range region is an **annulus**
`[innerStandoff, weaponRange]` instead of a filled disk. The planner keeps the
boss hittable AND never hugs it (shotgun / point-blank patterns kill at close
range). The inner exclusion is applied consistently at all three layers that
currently treat the disk as filled: the pathfinder goal gate, the solver
candidate score, and the pathfinder route avoidance. It is robust when the
player STARTS inside the inner zone — outward traversal is always allowed and the
player is never trapped against the boss.

## Dependencies
Depends on **72** (shared temporal core) — 72 lands first so this plan edits the
post-dedup solver/pathfinder. **Plan 76 depends on this.** Files touched:
`UDodgeTypes.h` (new constant), `UDodgeSolver.{h,cpp}` (Goal + ScoreCand),
`UDodgePathfinder.cpp` (disk gate → annulus), `UDodge.cpp` (plumb innerStandoff
into `goal` and the snapshot).

## Current state — the disk is filled everywhere
The in-range manifold is a **filled disk** of radius `weaponRange` at three
places:

1. **Goal construction** (`UDodge.cpp:389-408`): on lock, `goal.maxRange =
   weaponRange` and the orbit standoff point is `lockPos + dir*standoff` where
   `standoff = orbitRange>0 ? orbitRange : weaponRange*0.85`. There is a soft
   standoff *preference* but no hard inner exclusion.

2. **Solver score** (`ScoreCand`, `UDodgeSolver.cpp:95-99`): penalizes only
   points OUTSIDE `goal.maxRange`:
   ```cpp
   if (goal.fromLock && goal.maxRange > 0.f) {
       const float distToBoss = Len(Sub(c.pos, goal.lockPos));
       if (distToBoss > goal.maxRange) score -= kSolveOutRangeW*(distToBoss - goal.maxRange);
   }
   ```
   Nothing penalizes points too CLOSE to the boss. A safe cell at point-blank
   scores fine.

3. **Pathfinder goal gate** (`UDodgePathfinder.cpp`): `EvalCell`
   (`UDodgePathfinder.cpp:253-256`) accepts a durable-safe goal cell iff
   `Len(w - diskCenter) <= diskLimit` where `diskLimit = weaponRangeTiles +
   kUInRangeSlack` (`UDodgePathfinder.cpp:361`). The `ComputeDodge` short-circuit
   (`UDodgePathfinder.cpp:656-658`) and `RunSearch` both treat the whole disk as
   valid. So the route will happily terminate at a cell 0.5 tiles from the boss.

Enemy bodies ARE a hard exclusion (`EnemyBlocked` / `EnemyBlockedLocal`) with
radius `kEnemyRadius = 0.8` + `kUPlayerHalf`, so the player never sits ON the
boss body — but "just outside the body" is still point-blank and lethal.

## Target design

### One inner-standoff value, plumbed like maxRange
Add to `Solver::Goal` (`UDodgeSolver.h:61`):
```cpp
float innerStandoff = 0.f;  // min distance from lockPos to stay (annulus inner
                            // radius). 0 = no inner gate (unlocked / disabled).
```
Add a baked constant in `UDodgeTypes.h` (near `kUInRangeSlack`):
```cpp
// Annulus inner radius as a fraction of weapon range: the planner keeps the
// player at least this far from a locked boss so it never fights point-blank.
// Fraction (not absolute) so it scales with weapon range across classes.
constexpr float kUInnerStandoffFrac = 0.35f;   // tune in testing
// Absolute floor so a very short-range weapon still keeps a body's-worth of gap.
constexpr float kUInnerStandoffMinTiles = 2.0f;
```
In `UDodge.cpp` goal construction (`UDodge.cpp:389-408`), when locked set:
```cpp
goal.innerStandoff = std::max(kUInnerStandoffMinTiles,
                              weaponRange * kUInnerStandoffFrac);
```
Also carry it into the planner snapshot: add
`float innerStandoffTiles = 0.f;` to `PlannerSnapshot` (`UDodgePathfinder.h:71`)
and set `s_snap.innerStandoffTiles = goal.fromLock ? goal.innerStandoff : 0.f`
in the publish block (`UDodge.cpp:441` area).

The orbit standoff *point* should sit inside the annulus: keep
`standoff = weaponRange*0.85` but clamp it to `>= goal.innerStandoff + margin`
so the soft goal never aims inside the inner ring.

### Robust-from-inside rule (critical)
The inner ring is a **goal/score exclusion, never a traversal veto**. The player
may START inside it (boss walked onto the player, or a dodge drove inward) and
MUST be able to move outward through it. Concretely:
- The pathfinder goal gate rejects a cell as a GOAL if it is inside the inner
  radius, but the cell stays **traversable** (never marked blocked). Outward
  progress is always possible.
- The solver's inner penalty is a SCORE term over the safe set (like the
  existing out-range term), never a hard filter — so if the only safe cells are
  inside the inner ring, the player still dodges there (safety wins) and the
  score pulls outward next tick.
- Never let the inner exclusion cause "no goal": if every in-annulus cell is
  unsafe, the existing safety-override path (`ComputeDodge` unconstrained
  re-search, `UDodgePathfinder.cpp:681-697`) already handles it — extend that
  fallback ordering to also cover "no in-annulus goal".

### The three edits
1. **Solver score** (`ScoreCand`, `UDodgeSolver.cpp`): after the out-range term,
   add a symmetric inner term:
   ```cpp
   if (goal.fromLock && goal.innerStandoff > 0.f) {
       const float distToBoss = Len(Sub(c.pos, goal.lockPos));
       if (distToBoss < goal.innerStandoff)
           score -= kSolveInnerW * (goal.innerStandoff - distToBoss);
   }
   ```
   Add `constexpr float kSolveInnerW` to `UDodgeTypes.h` (start equal to
   `kSolveOutRangeW = 1.6f`; the inner penalty should be at least as strong as
   the out-range one so it does not prefer point-blank).

2. **Pathfinder goal gate** (`EvalCell`, `UDodgePathfinder.cpp:253-256`): the
   `Ctx` already has `diskActive/diskCenter/diskLimit`. Add
   `float diskInner = 0.f;` to `Ctx` (`UDodgePathfinder.cpp:227-234`), set it in
   `RunSearch` from `s.innerStandoffTiles`, and gate the goal:
   ```cpp
   bool goalOk = safety >= kUPocketMargin;
   if (goalOk && c.diskActive) {
       const float dB = Len(Sub(w, c.diskCenter));
       goalOk = dB <= c.diskLimit && dB >= c.diskInner;   // ANNULUS
   }
   ```
   The cell remains open/traversable regardless (only `s_goal` is gated).

3. **Pathfinder short-circuit** (`ComputeDodge`, `UDodgePathfinder.cpp:656-658`):
   the "player cell is already a durable-safe goal" test currently accepts any
   in-disk safe start. Add the inner check so a player standing point-blank does
   NOT short-circuit as "already at goal" — it must route outward:
   ```cpp
   if (startGoal && in.hasLock && in.weaponRangeTiles > 0.f) {
       const float dB = Len(Sub(in.player, in.lockPos));
       startGoal = dB <= in.weaponRangeTiles + kUInRangeSlack
                && dB >= in.innerStandoffTiles;
   }
   ```

### Divergence / correctness warnings
- The annulus is applied ONLY when `hasLock && weaponRange>0`. Unlocked play and
  walk-to are unchanged (`innerStandoff` stays 0).
- Do NOT make the inner ring a `GridBlocked`/`EnemyBlocked` hard cell — that
  would trap a player who starts inside. It is exclusively a goal/score gate.
- The enemy-body hard exclusion (`kEnemyRadius + kUPlayerHalf`) stays; the inner
  standoff is a LARGER, softer ring around the same center. They compose: body =
  hard no-go, annulus-inner = soft "don't hold here".

## Steps

1. Add constants (`kUInnerStandoffFrac`, `kUInnerStandoffMinTiles`,
   `kSolveInnerW`) to `UDodgeTypes.h`; add `innerStandoff` to `Solver::Goal`
   (`UDodgeSolver.h`) and `innerStandoffTiles` to `PlannerSnapshot`
   (`UDodgePathfinder.h`).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. In `UDodge.cpp` goal construction (`389-408`), compute and set
   `goal.innerStandoff`, clamp the orbit standoff point to `>= innerStandoff`,
   and set `s_snap.innerStandoffTiles` in the publish block.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Add the inner-penalty term to `ScoreCand` (`UDodgeSolver.cpp`).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game (locked
   boss, no shots): the player settles at mid-annulus range, not point-blank.

4. Add `diskInner` to the pathfinder `Ctx`, set it in `RunSearch`, and gate
   `EvalCell`'s goal + the `ComputeDodge` short-circuit with the annulus inner
   radius. Ensure cells inside the inner ring stay traversable.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. Robust-from-inside test: spawn/stand point-blank on the locked boss with the
   overlay on. Confirm the route heads OUTWARD to the annulus (not "already at
   goal"), the player is never stuck against the body, and under a dense pattern
   with only point-blank safe cells the player still dodges inward (safety wins)
   then pulls back out.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- In-game (Release recommended): locked boss + no threat → player holds at
  mid-annulus, not hugging. Under fire → still dodges, prefers annulus cells,
  never parks point-blank. Starting inside the inner ring → routes outward, never
  trapped. Boss still takes damage (stays inside `weaponRange`).
- Overlay: the in-range ring should read as an annulus in behavior (the route
  goal never lands inside `innerStandoff`). Optionally draw the inner ring in
  `UDodgeDebug.cpp` for confirmation (small addition; allowed here since it is
  this plan's feature — draw a second `DrawWorldCircle` at `innerStandoff`).

## Out of scope
- Do NOT apply the annulus to unlocked play or walk-to.
- Do NOT turn the inner ring into a hard traversal block (would trap the player).
- Do NOT retune `weaponRange`, `kUInRangeSlack`, or the orbit `0.85` factor
  beyond clamping the standoff point above the inner radius.
- Do NOT change the enemy-body hard exclusion radius.
- Plan-commitment / anti-flip-flop is plan 76 — do not add hysteresis here.
