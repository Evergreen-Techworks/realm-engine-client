# 92 — Tight-Weave Scoring: Prefer Threading the Gap Over Fleeing to Open Space

## Goal
After this plan the conservative reflex's objective stops systematically
preferring a wide-open flee spot over a tight, arrival-safe thread. A new
bounded score term rewards a candidate that keeps the player weaving in/near the
shot pattern (accepted because it is clear at arrival time) instead of one that
retreats to distant open space, and the comfort term is capped tighter so a large
open clearance can no longer out-vote a valid tight thread. Safety is unchanged —
every scored candidate is already `instSafe` or `tempSafe` (arrival-clear), so
this only re-ranks among safe options.

## Dependencies
Depends on **91 merged** (uses `kUDurablePocketMargin` / `kUArrivalMargin`
naming; the reflex clamp line was repointed there). SEQUENTIAL with 93 and 94 —
all three edit `UDodgeSolver.cpp` (`ScoreCand` / the reflex loop) and must not
run concurrently. Files touched: `UDodgeSolver.cpp` (`ScoreCand`, and the reflex
accept/score loop `:413-465`), `UDodgeTypes.h` (new weight + a `tempSafe` flag on
`Cand`).

## Current state — comfort biases toward fleeing
In the reflex loop (`UDodgeSolver.cpp:413-465`), a candidate is admitted if it is
`instSafe` (endpoint + swept spatially safe) OR `tempSafe` (arrival-clear via
`PathClear`, `:434-436`). A time-threaded candidate then has its clearance
FLATTENED so its negative instantaneous clearance can't veto it (`:442-443`):
```cpp
Cand sc = cands[i];
if (tempSafe) sc.clr = std::max(sc.clr, kUDurablePocketMargin);   // post-91
const float s = ScoreCand(sc, in.player, goal, flow, prevDir, b);
```
`ScoreCand` (`:59-123`) then rewards comfort:
```cpp
score += kSolveClearW * std::min(c.clr, kSolveClearComfort);   // :96  (0.25 × min(clr,1.0))
```
Result (G2 in the overview): an open flee at ~1.0-tile clearance earns +0.25
comfort; a tight in-gap thread is flattened to `clr=0.18` and earns +0.045. The
only counter-pull toward the near thread is the move-distance penalty
(`kSolveMoveW=1.2`, `:93`). There is NO term that says "prefer staying in the
pattern / weaving in front over fleeing." The perp term (`kSolvePerpW=1.2`,
`:87-90`) rewards LATERAL motion but not specifically the thread-vs-flee choice.

The `Cand` struct (`UDodgeSolver.cpp:31-39`) has no field recording whether a
candidate was admitted via the temporal thread; `ScoreCand` cannot currently tell
a thread from a flee.

## Target design

### 1. Mark threaded candidates so the objective can see them
Add to `Cand` (`UDodgeSolver.cpp:31-39`):
```cpp
bool  threaded = false;   // admitted via the arrival-time thread (in a lane NOW,
                          // clear on arrival) rather than open-space spatial safety
```
In the reflex loop, set `sc.threaded = tempSafe;` alongside the existing
`sc.clr` clamp (replace the two lines at `:442-443`):
```cpp
Cand sc = cands[i];
sc.threaded = tempSafe;
if (tempSafe) sc.clr = std::max(sc.clr, kUDurablePocketMargin);
```

### 2. New weave-preference term in `ScoreCand`
Add a bounded reward for a threaded candidate that keeps the player near the
pattern (aggressive weaving), and a matching cap so open-space comfort can't
dominate. In `UDodgeTypes.h` (near the other `kSolve*` weights, `:56-70`):
```cpp
// Reward a candidate that WEAVES the pattern — accepted because it is clear at
// ARRIVAL time (in/near a lane now, gap opens as the player arrives) — over one
// that flees to open space. Applied ONLY to already-safe (arrival-clear)
// candidates, so it can never trade safety away; it just keeps the dodge tight
// and aggressive instead of retreating off the pattern. Bounded, modest.
constexpr float kSolveWeaveW = 0.35f;   // flat reward for a threaded (in-gap) candidate
```
In `ScoreCand`, after the comfort tiebreak (`UDodgeSolver.cpp:95-96`), add:
```cpp
// Tight-weave preference: a threaded (arrival-clear, in-gap) candidate is
// rewarded so we hold the pattern instead of fleeing to open space. Safe by
// construction — only arrival-clear candidates carry threaded=true.
if (c.threaded) score += kSolveWeaveW;
```

### 3. Tighten the comfort cap so open clearance stops out-voting a thread
The comfort reward should reward "not standing in a shot" but not keep rewarding
ever-wider open space (which is exactly the flee bias). Lower the comfort ceiling
so beyond a modest clearance there is no extra pull outward. Change
`kSolveClearComfort` (`UDodgeTypes.h:67`) from `1.0f` to `0.5f`:
```cpp
constexpr float kSolveClearComfort = 0.5f;  // clearance (tiles) above which comfort
                                            // stops rewarding — capped low so a wide
                                            // flee never out-scores a valid tight thread
```
Net after this plan: a threaded in-gap candidate gets `+kSolveWeaveW (0.35)` plus
`kSolveClearW·min(0.18,0.5)=0.045` ≈ +0.395; a 1.0-tile open flee gets
`kSolveClearW·min(1.0,0.5)=0.125` and no weave bonus. The thread now competes on
even footing with (and, at equal move cost, beats) the flee, while goal/perp/
commit still steer the choice. Both remain fully safe.

### Divergence / safety warnings
- This term ONLY re-ranks candidates the reflex already admitted (`instSafe` or
  `tempSafe`). It touches neither admission (`:432-436`) nor the hard floors, so
  the never-accept-an-unsafe-point invariant is untouched.
- Do NOT let the weave reward apply to the STAND candidate or a fallback cell:
  `c.threaded` is only ever set in the reflex safe-set loop, and the stand /
  fallback paths build their own `Cand`s without it (default `false`). Confirm
  the stand candidate (`:131-136`) leaves `threaded=false`.
- Lowering `kSolveClearComfort` reduces the pull toward open space in ALL modes
  (locked and unlocked). That is intended (tightness), but verify it does not
  make the player HUG a shot when a genuinely safer nearby cell exists — the
  move penalty + real clearance still favor the nearer/safer of two threads.

## Steps

1. Add `kSolveWeaveW` and change `kSolveClearComfort` to `0.5f` in
   `UDodgeTypes.h`. Add the `threaded` field to `Cand` in `UDodgeSolver.cpp`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors (no behavior change
   yet — nothing reads `threaded`, weave weight unused; comfort cap change IS
   live, so this step already slightly tightens — acceptable, it only lowers the
   flee pull).

2. Set `sc.threaded = tempSafe;` in the reflex loop and add the `kSolveWeaveW`
   term to `ScoreCand`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: under a
   stream you can walk in front of, the player now HOLDS the gap / weaves between
   shots instead of backpedaling to open space, and still takes no hits.

3. Tuning pass (Release): confirm the player is tighter/more aggressive but not
   reckless. If it hugs shots (clips), lower `kSolveWeaveW` toward 0.2; if it
   still flees, raise toward 0.5. Record the value that is tight WITHOUT any new
   hit — safety wins ties.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- `command grep -n 'kSolveWeaveW\|threaded' internal/src/features/movement/udodge/UDodgeSolver.cpp`
  → the term and the flag are present and wired.
- In-game (Release): with a dodge-able straight stream, the player weaves through
  / in front rather than fleeing; hit count across a fixed test window does not
  increase vs pre-plan. With a dense unavoidable pattern, the Fallback/Surrounded
  behavior is unchanged (this plan does not touch those branches).

## Out of scope
- Do NOT change candidate ADMISSION or any safety floor (`instSafe`/`tempSafe`
  gates, `PointSafety`, `SegmentSafety`, `EnemyBlocked`).
- Do NOT touch the annulus/out-range/inner terms (that is 93) or commitment
  (that is 94) — even though they live in the same `ScoreCand`.
- Do NOT change the temporal margins (91) or horizon (95).
</content>
