# 93 — Stronger Stay-In-Range Annulus Hold (don't drift out of the fight)

## Goal
After this plan, while a boss is locked the dodge holds the weapon-range annulus
`[innerStandoff, weaponRange]` far more tightly during sustained fire: the
out-of-range penalty grows super-linearly with distance so drifting out is
strongly discouraged, and when the player IS out of range and safe it is actively
pulled back toward the annulus instead of only when already durable-holding.
Boss uptime goes up without weakening any safety floor — every affected decision
still ranks only SAFE candidates.

## Dependencies
Depends on **92 merged** (SEQUENTIAL — both edit `UDodgeSolver.cpp` `ScoreCand`
and would conflict). Reads the annulus plumbing shipped in plan 75 (already
present: `Goal::innerStandoff/maxRange/lockPos/fromLock`, `kSolveOutRangeW`,
`kSolveInnerW`). Files touched: `UDodgeSolver.cpp` (`ScoreCand` out-range term,
and the `repositionInward` hold exception `:295-315`), `UDodgeTypes.h` (weight +
new return-drive constant). `UDodge.cpp` is NOT touched (goal construction and
the standoff clamp `:613-644` are correct as-is).

## Current state — the range pull is weak and recovery is passive
1. **Out-range penalty is linear and modest** (`ScoreCand`,
   `UDodgeSolver.cpp:101-105`):
   ```cpp
   if (goal.fromLock && goal.maxRange > 0.f) {
       const float distToBoss = Len(Sub(c.pos, goal.lockPos));
       if (distToBoss > goal.maxRange)
           score -= kSolveOutRangeW * (distToBoss - goal.maxRange);   // 1.6/tile
   }
   ```
   During a barrage the reflex weighs this 1.6/tile against comfort (now capped
   at ~0.125 after 92), goal-progress, perp, and weave. One tile out of range
   costs 1.6 — enough to prefer an in-range option WHEN one is comparably safe,
   but a big safe flee 2-3 tiles out can still win when in-range cells are only
   marginally safe, and the linear penalty never escalates, so the player can
   camp well outside range for many ticks.
2. **Recovery is passive** — the only active "come back into range" is
   `repositionInward` (`UDodgeSolver.cpp:295-315`), which fires ONLY when the
   stand is already a durable temporal pocket AND `dist > maxRange`. While
   actively dodging (not durable-holding), nothing drives the player back toward
   the annulus beyond the soft score; the worker route's disk gate
   (`UDodgePathfinder.cpp:178-187`) helps but is a lookahead bias, and the reflex
   is authoritative in dense fire.

The inner-standoff term (`:112-116`) is already symmetric and adequate; this plan
does NOT strengthen the inner penalty (over-strengthening it would push the
player outward into more danger). Focus is the OUTER edge and recovery.

## Target design

### 1. Super-linear out-range penalty
Make the out-range penalty grow with the square of the excess distance so a small
drift is cheap (the player may briefly leave range to dodge — safety wins) but a
large drift is strongly punished, pulling the player back promptly. In
`ScoreCand`, replace the linear term (`UDodgeSolver.cpp:101-105`) with:
```cpp
if (goal.fromLock && goal.maxRange > 0.f) {
    const float distToBoss = Len(Sub(c.pos, goal.lockPos));
    const float over = distToBoss - goal.maxRange;
    if (over > 0.f)
        score -= kSolveOutRangeW * over            // linear base (unchanged slope near the edge)
               + kSolveOutRangeQuadW * over * over; // super-linear far-drift penalty
}
```
Add to `UDodgeTypes.h` (near `kSolveOutRangeW`, `:69`):
```cpp
// Extra out-of-range penalty proportional to the SQUARE of tiles past weapon
// range. Keeps a small dodge-out cheap (safety still wins near the edge) while
// making a large drift out of the fight expensive, so the player returns to the
// annulus promptly. Locked boss only. Chooses among SAFE candidates only.
constexpr float kSolveOutRangeQuadW = 0.8f;   // tune in testing
```
Keep `kSolveOutRangeW` at 1.6 (the near-edge slope is already right; step 3 may
nudge it).

### 2. Active return-to-range while dodging (not only when durable)
Today `repositionInward` only triggers from the durable-hold branch. Add a soft
return DRIVE so that when the player is out of range but the reflex is choosing a
safe cell, in-range safe cells are preferred even at some clearance cost — this
is already what the quadratic term does, so the main additional fix is to let the
solver TAKE an in-range step when out of range even if the current stand is
momentarily safe (so the player closes back in between shots rather than parking
just outside range). Extend the `standDurable` hold exception
(`UDodgeSolver.cpp:295-315`) to also progress inward toward the annulus when
safe:
```cpp
bool repositionInward = false;
if (goal.fromLock && goal.maxRange > 0.f)
    repositionInward = Len(Sub(in.player, goal.lockPos))
                       > goal.maxRange + kUReturnRangeSlack;   // hysteresis: only re-close past a small band
```
Add to `UDodgeTypes.h`:
```cpp
// Hysteresis band (tiles) beyond weapon range before the solver actively steps
// back INTO the annulus from a safe stand. A band (not 0) so the player does not
// twitch in/out at the exact range boundary. Locked boss only.
constexpr float kUReturnRangeSlack = 0.5f;
```
When `repositionInward` fires, the existing fall-through already runs the reflex
with `goal.pos` = the standoff point inside the annulus (`UDodge.cpp:635`), so
`kSolveGoalW` progress + the quadratic out-range term steer the safe step inward.
No new branch is needed beyond the slack band — this makes the existing
reposition fire a touch earlier and consistently, closing the passive-recovery
gap without adding an unsafe drive (only SAFE cells are ever chosen).

### Divergence / safety warnings
- Every change here is a SCORE term or a re-entry into the existing SAFE reflex.
  It never overrides safety: if the only safe cells are out of range, the player
  still dodges there (the penalty is finite; a hit is infinite cost via the hard
  admission gate) and pulls back once clear. Confirm the out-range term stays a
  subtractive SCORE, never a candidate filter.
- Do NOT strengthen `kSolveInnerW` here — pushing harder off the inner ring drives
  the player OUTWARD into the shot pattern. Inner behavior stays as plan 75 set it.
- The `kUReturnRangeSlack` band must be > 0 so the player does not oscillate
  across the exact range boundary (that would be new jitter — 94's concern).
- Applies ONLY when `goal.fromLock && goal.maxRange > 0` (locked boss). Unlocked
  play and walk-to are unaffected (`goal.fromLock` false).

## Steps

1. Add `kSolveOutRangeQuadW` and `kUReturnRangeSlack` to `UDodgeTypes.h`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors (unused → no
   behavior change).

2. Replace the linear out-range term in `ScoreCand` with the linear+quadratic
   form. Add the `kUReturnRangeSlack` band to the `repositionInward` test in
   `Solve`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game (locked
   boss, sustained fire): the player stays inside weapon range far more of the
   time, returns to the annulus quickly after a dodge-out, and the boss takes
   near-continuous damage.

3. Tuning pass (Release): tune `kSolveOutRangeQuadW` (0.4-1.2) so far drift is
   punished but the player still leaves range when it MUST to survive. Verify no
   new hits and no in/out twitching at the range boundary (if it twitches, raise
   `kUReturnRangeSlack`). Safety wins every tie.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- `command grep -n 'kSolveOutRangeQuadW\|kUReturnRangeSlack' internal/src/features/movement/udodge/UDodgeSolver.cpp`
  → both present and wired.
- In-game (Release): locked boss + dodge-able pattern → measured/observed
  time-in-range is higher than pre-plan; boss DPS uptime up; ZERO new hits. When
  a pattern forces leaving range, the player still leaves (safety preserved) then
  re-enters. Unlocked play behavior is byte-identical (the terms are gated on
  `goal.fromLock`).

## Out of scope
- Do NOT touch the inner-standoff term/constants (plan 75 owns them).
- Do NOT touch weave/comfort (92) or commitment (94).
- Do NOT change `UDodge.cpp` goal/standoff construction or the orbit `0.85`
  factor / `weaponRange` resolution.
- Do NOT change the pathfinder disk/annulus gate (it already matches).
</content>
