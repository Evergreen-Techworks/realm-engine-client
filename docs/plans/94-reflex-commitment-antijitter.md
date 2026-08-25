# 94 — Reflex-Branch Commitment & Anti-Jitter (commit to a good dodge)

## Goal
After this plan, plan-76's commitment/hysteresis extends to the conservative
REFLEX branch (the common dense-fire path), and a single safe frame no longer
erases the committed heading. The player commits to a dodge direction and stops
flip-flopping between two near-equal safe cells even when the worker route is not
driving the step. Safety stays authoritative — commitment only breaks ties among
already-safe candidates and is dropped the instant continuing becomes unsafe.

## Dependencies
Depends on **93 merged** (SEQUENTIAL — edits `UDodgeSolver.cpp` `ScoreCand` and
`Solve`, conflicts with 92/93). Builds on plan-76 machinery already present
(`state.lastMoveDir`, `state.dampStreak`, `kSolveCommitW`, `kSolveCommitBonus`,
`kURouteReverseDot`, `kUMaxDampTicks`). Files touched: `UDodgeSolver.cpp` (the
Hold branch's `lastMoveDir` reset, and the reflex safe-set loop), `UDodgeTypes.h`
(one small tuning constant if needed).

## Current state — commitment only covers the route step
1. **Brief holds wipe the committed heading.** In the Hold branch
   (`UDodgeSolver.cpp:307-314`):
   ```cpp
   out.kind = SolveKind::Hold;
   ...
   state.lastMoveDir = {};   // fresh commitment when the next dodge starts
   state.dampStreak = 0;
   ```
   A single safe frame (Hold) zeroes `lastMoveDir`, so the NEXT dodge starts with
   no continuity memory — `ScoreCand`'s commit term (`:66-73`) contributes 0 and
   the direction can flip vs the pre-hold heading. In a stream that briefly opens
   and re-closes, this produces a left→hold→right reversal.
2. **The reflex branch has no anti-oscillation damp.** The soft/hard damp that
   keeps a committed heading through a near-equal toggle exists ONLY on the
   pre-position route step (`UDodgeSolver.cpp:373-389`). The conservative reflex
   safe-set loop (`:413-465`) picks purely by `ScoreCand` each tick; its only
   commitment is the soft `kSolveCommitW`/`kSolveCommitBonus` score, which
   `kSolveGoalW`/`kSolvePerpW`/(now `kSolveWeaveW`) can outvote when two safe
   cells are near-equal — so the reflex can still jitter.
3. On a reflex step the code sets `state.lastMoveDir = w.dir` and
   `state.dampStreak = 0` (`:461-462`), so at least continuity is recorded for
   the NEXT tick — but there is no damping that USES it to resist a flip within
   the reflex.

## Target design

### 1. Don't wipe commitment on a brief hold — decay it instead
A Hold means "safe right now," not "the dodge is over." Preserve the last heading
so a re-triggered dodge continues the same way. Change the Hold branch
(`UDodgeSolver.cpp:311-313`): do NOT zero `lastMoveDir`. Keep it as-is so the
commit term still biases the next dodge toward the pre-hold heading. Reset only
`dampStreak` (a hold legitimately ends a damped route run):
```cpp
// Keep lastMoveDir across a brief hold so a re-triggered dodge commits to the
// same heading instead of flipping. It is naturally refreshed when the next
// move is chosen; only a genuine direction change overwrites it.
state.dampStreak = 0;   // a hold ends a route-damp run, but heading memory persists
```
(Delete the `state.lastMoveDir = {};` line.) Do the same at the Surrounded exit
(`:508-511`) if it also zeroes the heading — it currently does not set it, so
leave that branch's heading untouched (persist).

Divergence note: the original comment claims "fresh commitment when the next
dodge starts" — that is precisely the flip source. The CORRECT behavior is to
persist the heading; a real reversal is still chosen freely by the score when the
safe cells genuinely point the other way (the commit term is a bounded bias, not
a lock), and the damp below re-tests continuation safety before honoring it.

### 2. Add the soft/hard anti-oscillation damp to the reflex step
Mirror the pre-position damp (`UDodgeSolver.cpp:373-389`) in the reflex WINNER
selection so a near-equal per-tick flip is resisted when continuing the committed
heading is itself still safe. After the reflex loop picks `best` and BEFORE
committing the move (`:451-464`), when the chosen candidate reverses the committed
heading, prefer continuing the previous heading IF a candidate in that direction
is also admissible (safe). Concretely, do NOT invent a new continuation point
(the reflex already only steps to admitted candidates); instead bias selection:
during the reflex loop, when two candidates score within a small epsilon, prefer
the one whose `dir` better matches `prevDir`. Implement as a commitment tiebreak
inside the loop:
```cpp
// (inside the reflex scoring loop, replacing the plain best-tracking at :445-448)
const float s = ScoreCand(sc, in.player, goal, flow, prevDir, b);
if (best < 0 || s > bestScore + kSolveReflexHystEps) {
    bestScore = s; best = i;                         // clearly better → take it
} else if (s > bestScore - kSolveReflexHystEps &&    // near-tie …
           LenSq(prevDir) > 1e-6f && best >= 0 &&
           Dot(sc.dir, prevDir) > Dot(cands[best].dir, prevDir)) {
    best = i;                                         // … break toward the committed heading
    // keep bestScore (the incumbent's) so a later clearly-better cand still wins
}
```
Add to `UDodgeTypes.h`:
```cpp
// Reflex score-tie band: two safe candidates within this score of each other are
// treated as equal and the tie is broken toward the committed heading (anti-
// jitter). Small — a meaningfully better safe cell still wins outright. Choosing
// among SAFE candidates only, so it never trades safety away.
constexpr float kSolveReflexHystEps = 0.15f;
```
This resists the left/right toggle WITHOUT any safety cost: only candidates
already admitted (`instSafe`/`tempSafe`) participate, and the tie band is small so
a genuinely safer/closer cell still wins.

### Divergence / safety warnings
- Persisting `lastMoveDir` across a hold must NEVER cause the player to keep
  moving during a hold: the Hold branch still returns `shouldMove=false` /
  `target=player` — only the *memory* persists, consumed by the NEXT dodge's
  scoring. Verify the Hold early-return still drives no motion.
- The reflex tie-break only reorders SAFE candidates; it does not widen admission
  and cannot select an unadmitted (unsafe) candidate. `best` is only ever set to
  an index that passed `instSafe || tempSafe`.
- Do NOT add a `dampStreak`-style cap here that could hold a heading into danger:
  because every reflex candidate is re-admitted each tick against the current
  map, an unsafe committed heading simply is not among the candidates and cannot
  be chosen. No cap needed; a genuine required turn still wins the moment the old
  heading's candidates stop being safe/near-equal.
- Keep this independent of the pre-position damp — do not merge the two code
  paths; the pre-position path constructs a continuation point, the reflex path
  only reorders existing candidates.

## Steps

1. Add `kSolveReflexHystEps` to `UDodgeTypes.h`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors (unused yet).

2. Remove the `state.lastMoveDir = {};` wipe in the Hold branch
   (`UDodgeSolver.cpp:312`); keep the `dampStreak = 0` reset and update the
   comment.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: a dodge
   interrupted by a brief hold resumes the SAME heading instead of flipping.

3. Add the near-tie commitment tiebreak to the reflex scoring loop.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: with two
   near-equal safe cells the reflex stops toggling left/right tick-to-tick; a
   shot placed on the committed path still breaks commitment instantly (the old
   heading's candidates stop being admitted).

4. Tuning pass (Release): tune `kSolveReflexHystEps` (0.05-0.3) so jitter is gone
   but the dodge still turns promptly when it must. Confirm no new hits.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- `command grep -n 'lastMoveDir = {}' internal/src/features/movement/udodge/UDodgeSolver.cpp`
  → **zero results in the Hold branch** (the wipe is gone; the fresh-dodge case is
  handled by the score, not a wipe).
- `command grep -n 'kSolveReflexHystEps' internal/src/features/movement/udodge/UDodgeSolver.cpp`
  → present and wired.
- In-game (Release): watch the `[UDodge] MOVE` `stepDot` log and the overlay —
  heading no longer oscillates through brief holds or between near-equal reflex
  cells; a shot forced onto the committed path still produces an immediate,
  safe turn (no stuck commitment → no hit).

## Out of scope
- Do NOT change the pre-position route damp (`:354-411`) or plan-76 worker goal
  hysteresis — they already work; do not duplicate them.
- Do NOT change weave/comfort (92) or annulus (93) terms.
- Do NOT add wall-clock timers — commitment stays tick/score based (plan-44/76
  design).
- Do NOT weaken any admission gate to make commitment "stickier."
</content>
