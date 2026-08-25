# 91 — Separate & Tighten the Arrival Margin vs the Durable-Pocket Margin

## Goal
After this plan the single triple-purposed constant `kUPocketMargin` (0.18) is
split into two named, independently-tunable constants — `kUArrivalMargin`
(the time-thread comfort added inside the temporal swept checks) and
`kUDurablePocketMargin` (the clearance a cell needs to count as a durable resting
pocket / route goal, and the reflex hold floor). Step 1 introduces both equal to
the current 0.18 (pure rename, ZERO behavior change). Step 2 lowers ONLY
`kUArrivalMargin` so the player may weave in front of / between shots more
tightly, while the durable/hold comfort stays exactly as it was. This is the
foundation the tight-weave scoring (92) and horizon hardening (95) build on.

## Dependencies
None — parallel-safe as an entry point, but it is the FOUNDATION: 92, 93, 94, 95
all read the constants introduced here. Land it first.
Files this plan touches that other plans also touch:
- `UDodgeTypes.h` — every other plan adds constants here (additive; conflicts
  unlikely but declare it).
- `UDodgeCore.cpp` / `UDodgeCore.h` — also touched by 95.
- `UDodgeSolver.cpp` — also touched by 92/93/94 (this plan changes ONE line,
  `:443`; keep the edit minimal to reduce conflict surface).
- `UDodgePathfinder.cpp` — the goal-margin call sites.
- `UDodge.cpp` — mechanical rename ONLY at `:628-629` (also touched by 93 for the
  annulus logic; this plan does NOT change that logic, so conflict is minimal).
- `UDodgeDebug.cpp` — mechanical rename of two visualization sites.

## Current state — one constant, three jobs
`kUPocketMargin` is defined once (`UDodgeTypes.h:118-123`) and consumed as:

1. **Temporal arrival comfort** — added ON TOP of the already-server-accurate
   effective half inside the swept checks:
   - `UDodgeCore.cpp:278` (in `Temporal::PathClear`):
     ```cpp
     const float half = c.half[li] + kUPocketMargin;
     ```
   - `UDodgeCore.cpp:304` (in `Temporal::ArrivalClear`):
     ```cpp
     const float half = c.half[li] + kUPocketMargin;
     ```
   Here `c.half[li]` is ALREADY `hitHalf·scale + kUPlayerHalf`
   (`UDodgeCore.cpp:246`), i.e. the exact server hit boundary. So this term is
   pure comfort slack on the moving-bullet thread test.

2. **Durable-pocket / route-goal definition** — a cell is a durable-safe goal
   when its static clearance clears this margin:
   - `UDodgePathfinder.cpp:178`:
     ```cpp
     bool goalOk = safety >= kUPocketMargin;
     ```
   - `UDodgePathfinder.cpp:672` (`ComputeDodge` start short-circuit):
     ```cpp
     bool startGoal = startSafety >= kUPocketMargin;
     ```

3. **Reflex time-threaded clamp / fallback hold slack** in the solver:
   - `UDodgeSolver.cpp:443` (flatten a time-threaded candidate's clearance so its
     negative instantaneous clearance doesn't veto it):
     ```cpp
     if (tempSafe) sc.clr = std::max(sc.clr, kUPocketMargin);
     ```
   - `UDodgeSolver.cpp:493` (fallback "helps" tolerance):
     ```cpp
     w.clr >= standClr - kUPocketMargin
     ```

Divergence being resolved: job (1) governs HOW TIGHTLY the player may thread a
MOVING bullet in time — for tightness we want this SMALL. Jobs (2)/(3) govern how
comfortable a RESTING pocket must be — we want that unchanged (a durable hold
should stay comfortable). They are currently the same number and cannot move
independently. The spatial reflex floor is a separate constant already
(`kULatencyPad=0.05`, `UDodgeTypes.h:51`); do NOT touch it here.

## Target design

### New constants (`UDodgeTypes.h`, replacing `kUPocketMargin`)
Add next to the current definition:
```cpp
// Comfort slack (tiles) the TEMPORAL arrival test adds beyond the exact server
// hit boundary (which already folds bulletHalf·scale + kUPlayerHalf). This is
// the ONLY knob for how tightly the player may weave in FRONT of / BETWEEN
// moving shots: a bullet that is not within (hit + kUArrivalMargin) of the
// player at the moment the player is there is threaded, not fled. SMALL = tight.
// Must stay > 0 so a slightly-off prediction can never let a real hit through.
constexpr float kUArrivalMargin = 0.18f;   // step 2 lowers this; step 1 = 0.18 (no-op)

// Clearance (tiles) a cell needs BEYOND the server hit boundary to count as a
// DURABLE resting pocket / route goal, and the comfort a HELD stand keeps. This
// is a RESTING-comfort knob, deliberately independent of the arrival-thread knob
// above: a hold/goal should stay comfortable even as threading gets tighter.
constexpr float kUDurablePocketMargin = 0.18f;
```
Then remove `kUPocketMargin` and repoint each call site to the correct new
constant (mechanical — see Steps). If keeping `kUPocketMargin` as a compile alias
is easier for a first pass, do NOT: the whole point is that the two values
diverge in step 2, so a single alias would defeat it. Delete the old name.

### Divergence warning — which value is correct where
- `UDodgeCore.cpp:278`, `:304` (temporal swept `half`) → **`kUArrivalMargin`**.
  This is the tight-weave knob.
- `UDodgePathfinder.cpp:178`, `:672` (durable goal / start-goal) →
  **`kUDurablePocketMargin`**.
- `UDodgeSolver.cpp:443` (time-threaded reflex clamp) → **`kUDurablePocketMargin`**.
  Rationale: this clamp only decides the SCORE floor a time-threaded candidate
  is GIVEN so its negative spatial clearance doesn't veto it; it is not the
  arrival gate (the arrival gate is `PathClear`, already applied to admit the
  candidate at `:435`). Tying it to the resting-comfort value keeps step 2's
  arrival tightening from perturbing reflex scoring. (92 revisits this line;
  keeping it on the durable constant now avoids a double-move.)
- `UDodgeSolver.cpp:493` (fallback "helps" tolerance) →
  **`kUDurablePocketMargin`**. This is a "don't lose meaningful clearance"
  tolerance, a resting-comfort concept.
- `UDodgeDebug.cpp:96`, `:136` (heatmap amber threshold + durable goal-cell
  coloring) → **`kUDurablePocketMargin`**. Pure visualization of the
  durable-comfort concept; behavior-identical (the constant stays 0.18).
- `UDodge.cpp:628`, `:629` (orbit-standoff annulus clamp:
  `innerStandoff + kUPocketMargin`) → **`kUDurablePocketMargin`**. This is the
  resting/goal-comfort standoff, so it belongs on the durable constant, which
  stays `0.18` for the entire plan — the clamp value NEVER changes. NOTE: this is
  a MECHANICAL constant rename only; it does NOT alter the annulus/standoff logic
  (that is plan 93). Required because Step 1 deletes `kUPocketMargin`, so leaving
  this reference would break the `UDodge.cpp` compile.

### Step 2 tightening (gated, the actual behavior change)
Lower `kUArrivalMargin` from `0.18f` to `0.10f`. Rationale: the arrival test is
already SWEPT (`MinChebOnSegment` over each 100 ms step, `UDodgeCore.cpp:284`)
and folds the full server hit half + player half, so 0.10 tiles of extra slack
is still a real cushion against prediction error while letting the player thread
~0.08 tiles closer to a moving bullet than today. **Invariant:** keep
`kUArrivalMargin > 0.f` (add a `static_assert(kUArrivalMargin > 0.f, ...)` next
to it) — a zero or negative arrival margin would let the player accept a point a
bullet is exactly on at arrival, i.e. a hit. Do NOT go below ~0.08 without
in-game validation; 0.10 is the recommended conservative first cut.

## Steps

1. In `UDodgeTypes.h`, add `kUArrivalMargin = 0.18f` and
   `kUDurablePocketMargin = 0.18f` (both 0.18 for now) with the comments above
   and a `static_assert(kUArrivalMargin > 0.f, ...)`. Remove `kUPocketMargin`.
   Build: `bash internal/tools/wsl-build.sh Debug` → EXPECT compile errors at the
   old call sites (that is the checklist for step 2's repoint).

2. Repoint every former `kUPocketMargin` use to the correct new constant per the
   Divergence table above:
   - `UDodgeCore.cpp:278`, `:304` → `kUArrivalMargin`.
   - `UDodgePathfinder.cpp:178`, `:672` → `kUDurablePocketMargin`.
   - `UDodgeSolver.cpp:443`, `:493` → `kUDurablePocketMargin`.
   - `UDodgeDebug.cpp:96`, `:136` → `kUDurablePocketMargin`.
   - `UDodge.cpp:628`, `:629` → `kUDurablePocketMargin` (mechanical rename only —
     do NOT touch the surrounding standoff/annulus logic).
   There are exactly **10 code call sites** across `UDodge.cpp`, `UDodgeCore.cpp`,
   `UDodgeSolver.cpp`, `UDodgePathfinder.cpp`, `UDodgeDebug.cpp` — after this step
   a grep for `kUPocketMargin` must return ZERO. Also update the surrounding
   comments that name `kUPocketMargin` (search all files under
   `features/movement/udodge/` for the identifier and the prose "pocket margin",
   incl. `UDodgePathfinder.h:12`).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. Behavior is
   IDENTICAL to before (both constants still 0.18). This is the safe checkpoint.

3. (Gated tightening.) Lower `kUArrivalMargin` to `0.10f`. Leave
   `kUDurablePocketMargin` at `0.18f`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: the
   player weaves visibly closer to moving shots (slips just in front of / behind
   a bullet) but still never touches one; durable holds/route goals look
   unchanged.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after steps 2 and 3.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- The old identifier is fully gone:
  `command grep -rn 'kUPocketMargin' internal/src/features/movement/udodge/`
  → **zero results**.
- Both new identifiers are referenced:
  `command grep -rn 'kUArrivalMargin\|kUDurablePocketMargin' internal/src/features/movement/udodge/`
  → arrival margin appears in `UDodgeCore.cpp`; durable margin in
  `UDodgePathfinder.cpp` and `UDodgeSolver.cpp`.
- In-game (Release): after step 2, side-by-side identical to pre-plan behavior
  (regression check the rename). After step 3, tighter weaving with NO new hits
  in a controlled pattern (e.g. a straight shot stream you can walk in front of).
  If any hit appears that did not before, raise `kUArrivalMargin` back toward
  0.18 and record the safe floor — do not ship a value that produces a hit.

## Out of scope
- Do NOT change `kULatencyPad` (the spatial reflex floor) — that is a different
  safety knob and plan 78 Hole E owns any speed-aware pad work.
- Do NOT change the scoring weights or add new score terms (that is 92).
- Do NOT change the temporal horizon/step (that is 95).
- Do NOT change `UDodge.cpp` goal-construction or annulus/standoff LOGIC (that is
  93). The ONLY permitted `UDodge.cpp` edit in this plan is the mechanical rename
  of the `kUPocketMargin` reference at `:628-629` to `kUDurablePocketMargin`
  (value unchanged at 0.18 — behavior-identical); the standoff computation itself
  stays exactly as-is.
- Do NOT alter `PointSafety`/`SegmentSafety`/`EnemyBlocked` semantics.
</content>
