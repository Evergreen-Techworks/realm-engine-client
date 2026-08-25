# 95 — Arrival-Time Horizon & Swept-Step Robustness (harden the never-accept-an-unsafe-gap invariant)

## Goal
After this plan the shared arrival-time model (`Core::Temporal`) judges holds and
threaded gaps over a longer, better-sampled horizon so a slow-closing wall is not
under-counted and a fast bullet cannot slip between march samples. This is a
SAFETY-POSITIVE hardening: it can only make the temporal test see MORE danger,
never less. It is the guardrail under 91's tighter arrival margin and 92's
thread-preference — with those leaning harder on `PathClear`/`ArrivalClear`, the
horizon/step must be trustworthy.

## Dependencies
Depends on **91 merged** (uses `kUArrivalMargin`; both edit `UDodgeCore` temporal
and `UDodgeTypes.h`). Concern-disjoint from 92/93/94 (they edit the solver
objective; this edits the temporal core), so it MAY be authored in parallel with
them — BUT builds are serial (shared `C:\rebuild\Debug`; see 90 build-infra note),
so schedule the build after 91 and not concurrently with another implementer.
Files touched: `UDodgeCore.cpp`/`UDodgeCore.h` (`Temporal` horizon/step/sampling),
`UDodgeTypes.h` (the horizon constants). Note `Temporal::Ctx` sizing
(`UDodgeCore.h:69-79`) depends on `kUTemporalSteps` — changing it resizes the
fixed `pos[][]` buffer; verify the stack/worker-static footprint stays bounded.

## Current state — 500 ms horizon, frozen beyond it, coarse fixed step
- `kUTemporalSteps = 5`, `kUTemporalStepMs = 100.f` → horizon = **500 ms**
  (`UDodgeTypes.h:139-142`; `kHorizonMs`/`kSamples` derived in
  `UDodgeCore.h:69-70`).
- Beyond the traced horizon, `SampleLane` CLAMPS to the last polyline point
  (`UDodgeCore.cpp:218-219`) and `BulletPosAt` clamps to `pos[kUTemporalSteps]`
  (`:255-260`). So a bullet still APPROACHING at 500 ms is treated as FROZEN at
  its 500 ms position for the hold-durability test — a slow-closing wall can read
  "durable" when it will actually arrive at, say, 650 ms.
- The march step is a fixed 100 ms; the swept-segment check between samples
  (`MinChebOnSegment`, `UDodgeCore.cpp:284`, `:307`) is what prevents a fast
  bullet tunneling across a candidate between two samples. At 100 ms a very fast
  shot (e.g. 12 tiles/s ≈ 0.012 tiles/ms → 1.2 tiles/step) sweeps a long segment;
  the swept check handles the ENDPOINT-to-segment distance correctly, but a
  bullet passing DIAGONALLY very close still relies on the segment approximation
  of a curved path within the step.
- `Ctx::pos[kMaxProjectiles][kSamples]` (`UDodgeCore.h:77`) with
  `kSamples = kUTemporalSteps + 1 = 6` → 96×6 `Vec2` = ~4.6 KB per Ctx (the
  solver stack-allocates one per solve; the worker holds a static one). Raising
  the sample count raises this linearly.

## Target design

### 1. Extend the horizon so holds see the full closing wall
Raise the horizon to ~800 ms (≈4 server ticks) so a hold is judged long enough to
catch a slow-closing wall, keeping the 100 ms step (swept between). In
`UDodgeTypes.h`:
```cpp
constexpr int   kUTemporalSteps  = 8;      // 8 × 100 ms = 800 ms horizon (~4 server ticks)
constexpr float kUTemporalStepMs = 100.f;  // unchanged; swept-segment checks bridge samples
```
This resizes `Ctx::pos` to 96×9 `Vec2` ≈ 6.9 KB — still small; confirm the
solver's stack `Ctx` and the worker static `s_tctx` are fine (they are fixed
buffers, no heap). Because the tracer only fills lanes out to their real traced
length (`SampleLane` clamps past the traced path), a longer horizon never invents
danger — it only stops FREEZING a bullet that is still within its traced path at
500-800 ms. If lane tracing does not reach 800 ms for most shots (lane length is
capped by `settings.laneTiles` / bullet lifetime, `UDodgeSensors.cpp`), the extra
samples simply clamp to the path end as today — no false danger, and the longer
horizon helps exactly the slow/long-range shots where the path DOES extend.

### 2. Make the clamp-beyond-horizon explicit and conservative (audit + comment)
Confirm (and comment) that clamping a not-yet-arrived bullet to its last traced
position is the intended conservative behavior for the HOLD test: it assumes the
pattern is frozen where prediction runs out, which under-counts a still-closing
wall only OUTSIDE the (now longer) horizon. Do NOT change the clamp to
extrapolate (extrapolating a curved shot past its trace is how ghost lanes appear
— see `ClampLaneToAnchor`, `UDodgeSensors.cpp:268-282`). The fix for the
under-count is the longer horizon (step 1), not extrapolation.

### 3. (Optional, gated) adaptive sub-stepping for very fast lanes
Only if step-1 in-game testing shows a fast-shot clip that the 100 ms swept check
misses: add a per-lane sub-step when a lane's inter-sample travel exceeds a
threshold. In `PathClear`/`ArrivalClear`, when
`Len(pos[k+1]-pos[k]) > kUTemporalMaxSweepTiles`, subdivide that step and re-check
the intermediate points against the player position. This is a SAFETY-positive
refinement (more checks). Add:
```cpp
constexpr float kUTemporalMaxSweepTiles = 1.0f;  // sub-step a lane whose bullet moves
                                                 // more than this per march step
```
Keep it OFF unless testing proves a tunneling clip — the existing swept-segment
check already covers straight-line tunneling; sub-stepping only helps a bullet
that CURVES sharply within a 100 ms window (rare). Document the decision either
way (implement or DEFER with rationale) in this plan's completion note.

### Divergence / safety warnings
- This plan can ONLY increase the danger the temporal test reports (longer
  horizon = more samples where a bullet is seen; sub-stepping = more checks). It
  therefore cannot regress "never get hit"; the risk is the opposite —
  over-conservatism (breaking holds too early, fleeing more). Watch for the dodge
  becoming twitchy or leaving range more (93 mitigates the range side).
- The horizon change affects BOTH the solver hold/thread AND the worker route
  arrival gate (they share `Core::Temporal`). That is intended — both should
  reason over the same, longer horizon. Verify the worker's per-cell cost
  (`ArrivalClear` per edge) does not blow the frame budget: pops are bounded and
  the check is O(lanes × samples); with 8 samples vs 5 it is ~1.6× the per-edge
  temporal cost. Re-check the worker timing logs (`computeDodgeMs`).
- Do NOT change the CULL radius here (that is a relevance filter, not a horizon).
  Do NOT change `kUArrivalMargin` (91 owns it).

## Steps

1. Raise `kUTemporalSteps` to `8` in `UDodgeTypes.h`. Verify `kSamples`/
   `kHorizonMs` (derived in `UDodgeCore.h`) update and `Ctx::pos` sizing is fine.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Update/confirm the clamp comments in `SampleLane`/`BulletPosAt`
   (`UDodgeCore.cpp:206-261`) to state the conservative-freeze contract and that
   the longer horizon is the intended under-count fix.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: a
   slow-closing wall now triggers a pre-position OUT of the pocket earlier (the
   hold stops reading "durable" while the wall is 600-800 ms away), and holds are
   never clipped by a wall that used to be frozen-out of the 500 ms window.

3. Perf check (Release): read `computeDodgeMs` in the `[UDodge] Worker route` log
   and the `g_tSolve` phase timer — confirm the ~1.6× temporal cost does not
   regress the frame budget. If it does, reduce to `kUTemporalSteps = 7` (700 ms)
   and re-check.

4. (Optional) Only if step-2/3 testing surfaces a fast-shot tunneling clip:
   implement the adaptive sub-step (design §3) and re-test. Otherwise record a
   DEFER note with the reasoning (swept check sufficed).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step;
  `bash internal/tools/wsl-build.sh Release` → 0 errors for in-game validation.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- `command grep -n 'kUTemporalSteps' internal/src/features/movement/udodge/UDodgeTypes.h`
  → value is 8 (or the tuned 7).
- In-game (Release): a slow-approaching wall that previously clipped a "durable"
  hold no longer does; NO new hit is introduced; the dodge is not measurably
  twitchier and does not leave weapon range noticeably more than after 93. Worker
  `computeDodgeMs` stays within budget (no FPS regression).

## Out of scope
- Do NOT change `kUArrivalMargin`/`kUDurablePocketMargin` (91).
- Do NOT change the cull radius, lane tracing, or `ClampLaneToAnchor`
  (sensor-side; tracing horizon is bounded by `laneTiles`/lifetime by design).
- Do NOT extrapolate bullets past their traced path (ghost-lane risk).
- Do NOT change the solver objective (92/93) or commitment (94).
- Do NOT implement the speed-aware LATENCY pad (plan 78 Hole E, deferred) here —
  that is a different, aggression-trading knob.
</content>
