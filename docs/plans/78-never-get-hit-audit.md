# 78 — "Never Get Hit" Safety-Pipeline Audit & Fixes

## Goal
After this plan, the full dodge safety pipeline is audited end to end and the
concrete gaps that let shots through are closed: every frame the player is
actually standing/moving on a re-validated safe point, the swept motion (not just
the endpoint) is clear, holds are re-checked against the re-anchored map, and the
`CallMoveTo` landing is confirmed to match the validated target. This is a
behavior plan (safety-positive changes only), scoped to the enumerated holes.

## Dependencies
Depends on **72, 73, 75, 76** — it audits the consolidated, post-annulus,
post-commitment pipeline so the fixes land on the shipped code, not an interim
version. Files touched: `UDodge.cpp` (the drive + re-validation block),
`UDodgeSolver.cpp` (segment-safety of the reflex step), `UDodgeCore.{h,cpp}`
(a swept-segment safety helper if not already present), `UDodgeTypes.h`
(latency-pad tuning). Run LAST.

## Background: the safety contract as built
- Server-accurate hit geometry: `Core::PointSafety` folds the bullet half ×
  `hitScale` **plus** `kUPlayerHalf` (`UDodgeCore.cpp:81-98`), and active zones
  fold `+ kUPlayerHalf`. The solver requires `>= kULatencyPad`
  (`UDodgeSolver.cpp:186`). This endpoint test is correct.
- NewTick sync re-anchors lanes to live positions each frame
  (`Sensors::ReanchorMap`, `UDodgeSensors.cpp:419`); a structural change
  (spawn/retire) forces a full `BuildMap` + re-solve.
- Per-frame drive: `moveTarget = player + dir·min(d, speed·frameMs)` toward the
  cached `g_solve.target`, then `CallMoveTo` (`UDodge.cpp:526-533`).

## The concrete holes (each with a fix)

### Hole A — a HOLD is never re-validated between ticks
`UDodge::Tick` only runs the mid-tick re-validation + forced re-solve when
`g_solve.shouldMove` is true (`UDodge.cpp:499`). When the solve is `Hold` /
`Surrounded` (`shouldMove == false`), nothing re-checks the stand between server
ticks. The stand was chosen as a *durable temporal pocket* at tick start, but:
- re-anchoring rides the game's own bullet interpolation, which can diverge from
  our traced polyline (prediction error), and
- a lane already in the map can re-anchor CLOSER to the stand without a
  structural change (no rebuild is forced).

So a hold can be clipped mid-tick and we do not react until the next tick's
`BuildMap`. **This is a prime "still getting hit while standing" cause.**

**Fix A:** every frame, regardless of `shouldMove`, re-check the stand against the
re-anchored map. If `Core::PointSafety(in, in.player) < kULatencyPad` (the stand
is now covered) OR the temporal durability of the stand fails on the re-anchored
lanes, force a same-frame `BuildMap` + `Solver::Solve` and drive the new result.
Structurally: hoist the "re-validate + maybe re-solve" logic so it runs for the
Hold/Surrounded branch too, keyed on the stand becoming unsafe.

### Hole B — the reflex step validates only the endpoint, not the swept path
The conservative reflex picks a ring candidate whose ENDPOINT passes
`PointSafety >= kULatencyPad` (`UDodgeSolver.cpp:186`, `Evaluate`), but the
straight segment `player → candidate` (up to ~1 budget ≈ 1-1.5 tiles) is not
checked against the lanes. A thin lane crossing between the player and the
candidate is not caught for the reflex path (the pre-position path DOES check the
swept path via `Temporal::PathClear`, but the plain reflex candidates do not).
A player driven along that segment can be clipped mid-step.

**Fix B:** add a swept-segment endpoint-safety check to the reflex candidate
acceptance. Add to `UDodgeCore`:
```cpp
// Min server-accurate clearance of the player-swept segment A→B against all
// lanes/active zones (folds kUPlayerHalf). >= pad ⇒ the whole straight move is
// clear, not just the endpoint. Reuses MinChebOnSegment between the moving
// player segment and each lane segment.
float SegmentSafety(const MapInput& in, Vec2 a, Vec2 b);
```
Implement it as the min over lanes of (min-Chebyshev between segment `a→b` and
each lane polyline segment) − (half + kUPlayerHalf), and over active zones of
(min distance from the zone center to segment `a→b`) − (radius + kUPlayerHalf).
In the reflex acceptance (`UDodgeSolver.cpp` `Evaluate` / the safe-set loop),
require `SegmentSafety(in, player, cand.pos) >= kULatencyPad` in addition to the
endpoint `PointSafety`. (For a one-budget step this is cheap: a handful of
segment-segment tests per candidate; keep it to the candidates actually scored,
not all 131 — or accept the small cost since candidates are already O(100).)

Note: the temporal pre-position path already does the swept check in TIME; this
fix closes the SPATIAL reflex path, which is the conservative floor.

### Hole C — the driven `moveTarget` is a fraction toward a validated point, but its own segment is unvalidated
`moveTarget` is `player + dir·min(d, speed·frameMs)` — a point ON the segment to
`g_solve.target`. With Fix B the full segment `player → target` is validated for
the reflex, so any point on it is covered. But the PRE-POSITION / FALLBACK
targets deliberately skip the spatial veto (`UDodge.cpp:513-517`) and rely on the
solve-time temporal check. Between frames within a tick, those are driven without
re-check. Combined with Hole A's fix (re-check the stand every frame), also:

**Fix C:** for a prePosition/fallback target that is being driven, re-run the
cheap `Temporal::PathClear(ctx, player, speed, target)` against the RE-ANCHORED
lanes each frame (rebuild the small temporal ctx from the re-anchored map — it is
already cheap and now lives in the shared `Core::Temporal` from plan 72). If it
fails on the re-anchored map, force a same-frame re-solve. This preserves the
time-gap threading (we still allow a spatially-unsafe-now step) while catching a
re-anchor that invalidates the threaded gap. Today only a STRUCTURAL change forces
this; a re-anchor that closes the gap does not.

### Hole D — `CallMoveTo` landing is not confirmed
`DodgeRuntime::CallMoveTo` (`UDodge.cpp:533`) clamps internally to the game's
walkability and may land the player somewhere other than `moveTarget` (wall
slide, sub-tile clamp). The code trusts the call and never reads back the actual
post-move position to confirm it is still safe.

**Fix D (audit + guard):** after `CallMoveTo`, read the player's actual position
(the same live read the sensors use) and, if it diverges from `moveTarget` by
more than a small epsilon, re-validate the LANDED position's safety next-frame
(it is re-read at the top of the next `Tick` anyway, so the main requirement is
that Hole A's every-frame stand re-check covers a clamped landing). Confirm via
audit that the next-frame re-anchor + Fix A re-check catches a clamped landing
that ended up unsafe. If `CallMoveTo` returns a landed position (check its
signature), prefer validating that directly. Document the finding; only add code
if the audit shows the next-frame re-check is insufficient (e.g., a fast bullet
in the same frame).

### Hole E — fixed latency pad vs bullet speed
`kULatencyPad = 0.10` tiles (`UDodgeTypes.h:40`) is a constant, independent of
bullet speed. A fast bullet covers more than 0.10 tiles per read-latency window,
so the fixed pad under-protects against fast shots and over-protects against slow
ones.

**Fix E (tuning, gated):** consider a speed-aware pad
`pad = max(kULatencyPad, bulletTilesPerMs · kAssumedLatencyMs)` folded per-lane
in `PointSafety`, or a global pad derived from the fastest relevant lane. This
changes the safety margin, so make it a SEPARATE, clearly-flagged step and
validate it does not make the dodge so conservative it gets pinned. If testing
shows the fixed pad is adequate once Holes A-C are fixed, DEFER E (record the
finding). Do not ship E blind.

## Steps

1. **Audit pass (no code):** with the overlay + `[UDodge]` logs on, reproduce
   "got hit while it should have dodged" and classify each hit against Holes A-E.
   Record which holes actually fire in practice. This ordering matters — fix the
   holes that reproduce first.
   (No build needed; this is investigation. Use a Release build for realistic
   timing.)

2. **Fix A (hold re-validation):** hoist the per-frame stand re-check so it runs
   for Hold/Surrounded too; force a same-frame `BuildMap` + re-solve when the
   stand goes unsafe. Keep the existing shouldMove re-validation for the moving
   case.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: standing
   in a stream, a re-anchored bullet closing on the stand now triggers a dodge
   the same frame, not next tick.

3. **Fix B (segment safety):** add `Core::SegmentSafety` and require it in the
   reflex safe-set acceptance.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors. In-game: a thin
   lane between the player and the chosen step no longer clips mid-step.

4. **Fix C (pre-position re-temporal-check):** re-run `Core::Temporal::PathClear`
   against the re-anchored map each frame for prePosition/fallback drives; force a
   re-solve on failure.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. **Fix D (landing confirmation):** audit `CallMoveTo`'s return/landing; add a
   post-move position read + next-frame guard only if the audit shows the
   next-tick re-check is insufficient. Document the outcome either way.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

6. **Fix E (latency pad):** ONLY if step 1's audit showed fast-shot clips
   surviving A-C. Implement the speed-aware pad as a gated, separately-tested
   change, or record a DEFER decision with rationale.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step;
  `bash internal/tools/wsl-build.sh Release` → 0 errors for the final in-game
  validation.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- In-game (Release): the reproduction cases from step 1 no longer result in hits.
  Specifically: standing in a stream (Hole A), a thin crossing lane (Hole B), a
  threaded time-gap that a re-anchor closes (Hole C) — none produce a hit.
- Regression: the dodge is not so conservative it gets pinned in dense patterns
  more than before (the honest Fallback/Surrounded case from `UDodgeSolver.h`
  still applies — this plan closes gaps, it does not claim to defeat a fully
  covered reachable disk).
- No new grep target (this is a fix plan). The `Core::SegmentSafety` symbol must
  exist and be called from `UDodgeSolver.cpp`:
  `command grep -n "SegmentSafety" internal/src/features/movement/udodge/`.

## Out of scope
- Do NOT re-architect the sync/solve/worker structure — only close the enumerated
  holes.
- Do NOT change the annulus, commitment, occupancy, or temporal-core designs
  (they are prior plans) except to CALL their APIs.
- Do NOT change AutoNexus (plan 77 owns it) — though A-C should reduce how often
  the last-resort nexus is needed.
- Do NOT ship Fix E without its own validation; defer if unproven.
