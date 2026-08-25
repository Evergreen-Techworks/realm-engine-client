# 57 — Stage B: Fix Emergency / Field Zero-Velocity

## Goal
After this plan, when UDodge is surrounded (emergency) or boxed in, it always
issues a non-degenerate move if ANY escape exists. The failure
`[UDodge] MOVE dec=6(EmergencyOverride) ov=1 |v|=0 -> (target==player)` — override
active but velocity zero because the selection picked the stand candidate
(dir {0,0}) while the field escape's pocket marker (`fieldTarget`) was still being
drawn — no longer happens. The chosen escape direction is guaranteed non-zero.

## Dependencies
Plan 56 MUST be merged first (Stage A — the map must actually contain threats for
emergency logic to trigger meaningfully, and 56 touches the same files). Touches
`internal/src/features/movement/udodge/UDodgeField.cpp` and
`internal/src/features/movement/udodge/UDodgeCore.cpp`. Later plans (58-61) also
touch `UDodgeCore.cpp`, so this must merge before them.

## Current state

Two independent defects combine into the zero-velocity move:

1. **Degenerate field first-direction.** `UDodgeField.cpp:144-157`:
   ```cpp
   int step = goal;
   while (s_prev[step] != start && s_prev[step] != -1) step = s_prev[step];
   const int sgx = step % kSize, sgy = step / kSize;
   const Vec2 stepWorld = CellWorld(player, sgx, sgy);
   if (!Core::PointClear(in, stepWorld)) return res;
   res.found = true;
   res.target = stepWorld;
   res.firstDir = Normalize(Sub(stepWorld, player));   // can be {0,0}
   ```
   `Normalize` returns `{0,0}` when its argument is shorter than `1e-4`
   (`UDodgeTypes.h:49`). When the reconstructed first-step cell coincides with the
   player cell (e.g. the goal itself is adjacent-but-effectively-collocated after
   rounding, or the path degenerates), `firstDir` is zero even though `found` is
   true and `target` is drawn. The field candidate then has dir {0,0}.

2. **Emergency can select the stand candidate.** In `Core::Evaluate`, emergency is
   `c.clearance[kStandCandidate] <= 0` (`UDodgeCore.cpp:563`). `choice` starts as
   `proposed = SelectProposed(c)` (`:549`), and `SelectProposed`
   (`:230-248`) seeds `best = KeyOf(..., kStandCandidate, ...)` and only replaces
   it when `BetterCandidate` strictly wins — so when the player is surrounded and
   every moving candidate is as bad as standing, `proposed` stays
   `kStandCandidate` (dir {0,0}). The emergency blend branches
   (`:578-601`) only run `if (hasIntent ...)`; with no intent they are skipped and
   `choice` remains stand. `FinishMap` then emits
   `Mul(c.dirs[kStandCandidate], speed) = {0,0}` while `overrideActive=true` and
   `decision=EmergencyOverride` — the exact failing log. The field candidate may
   have been generated (`out.fieldTarget` set, `:532-533`) but was not selected
   because a zero-`firstDir` field candidate can never beat stand.

## Target design

**Fix 1 — non-degenerate field direction (`UDodgeField.cpp`).** After computing
`stepWorld`, if `Sub(stepWorld, player)` is shorter than a small epsilon
(`1e-3` tiles), fall back to the direction toward the GOAL cell, then to the
direction toward `res.target`; only if BOTH are still degenerate return
`res.found=false` (no usable escape). Concretely:
```cpp
Vec2 dir = Normalize(Sub(stepWorld, player));
if (LenSq(dir) < 1e-6f) dir = Normalize(Sub(CellWorld(player, ggx, ggy), player)); // goal cell
if (LenSq(dir) < 1e-6f) return res;   // truly nowhere to go — leave found=false
res.found = true; res.target = stepWorld; res.firstDir = dir;
```
where `ggx,ggy` are the goal cell coords (`goal % kSize`, `goal / kSize`). This
guarantees a found escape always has a unit `firstDir`.

**Fix 2 — emergency never emits a zero move when an escape exists
(`UDodgeCore.cpp`).** After the existing emergency selection (the block ending at
`:601`) and before `FinishMap` (`:628`), add a final guard: if
`decision == EmergencyOverride` (or any override decision) and
`LenSq(c.dirs[choice]) < 1e-6f` (i.e. `choice == kStandCandidate` / degenerate),
re-pick the best MOVING candidate by clearance among all valid candidates
(reusing the `BetterCandidate`/`KeyOf` ladder but excluding `kStandCandidate`),
preferring the field candidate when `out.fieldActive`. Only if NO valid moving
candidate exists at all does it fall back to stand (genuinely nowhere to move).
This makes "emergency + any escape ⇒ a real move" an invariant.

**Divergence note:** Fix 2 changes surrounded-and-no-intent behavior from
"freeze" to "flee toward the least-bad opening". This is the intended dodge
behavior (freezing in a bullet-covered tile is the bug). It only activates when
`standClearance <= 0`, so it never perturbs the calm/gentle paths.

## Steps

1. **Fix the field direction.** Edit `UDodgeField.cpp:144-157` per Target design
   Fix 1 (capture goal cell coords, epsilon-guard `firstDir`, fall back to
   goal-ward direction, else `found=false`). Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

2. **Add the emergency non-zero-move guard.** In `UDodgeCore.cpp`, just before
   the final `FinishMap` at `:628`, add the "re-pick a moving candidate when the
   chosen override direction is degenerate" block described in Fix 2. Factor the
   moving-candidate re-pick as a small local lambda that scans
   `cand ∈ [0,kCandidateCount)`, skips `!c.valid[cand]` and
   `LenSq(c.dirs[cand]) < 1e-6f`, and keeps the `BetterCandidate` winner; bias to
   `kFieldCandidate` when `out.fieldActive && c.valid[kFieldCandidate]`. Build +
   guardrail.

3. **In-game verify** the surrounded case (see Verification). Keep all
   `DBG_FILE_LOG` diagnostics in place.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

In-game (DodgeMode 7), deliberately get surrounded / boxed in:
- No `[UDodge] MOVE dec=6(EmergencyOverride) ... |v|=0 -> (target==player)` lines
  while `fieldActive`/an escape exists — every emergency MOVE has `|v|>0`.
- When the orange pocket marker (`fieldTarget`) is drawn, the player actually
  moves toward it instead of standing still.

## Out of scope
- Do NOT change emergency THRESHOLDS (`kEmergencyIntentBand`, the
  `standClearance <= 0` definition) — only the zero-velocity degeneracy.
- Do NOT begin the worker-thread / planner work (Stages C/D).
- Do NOT remove diagnostics (plan 62).
