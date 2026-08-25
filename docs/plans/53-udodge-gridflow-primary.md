# 53 — UDodge Stage 3: Grid-Flow Search as the Primary Selector

## Goal

After this plan, the Dijkstra field-escape search (`UDodgeField.{h,cpp}`) is the
PRIMARY geometry brain of UDodge rather than a boxed-in-only fallback: it runs
every server tick over a WIDENED local danger window, returning the safest
reachable pocket and the first step toward it, cached across the tick and
re-derived cheaply between ticks. The fixed 32-compass scorer stays as a fast
path / tie-break (when a straight compass step already clears the reaction
margin and aligns with intent, it is preferred for smoothness). This gives the
engine real geometry-aware routing (around walls, out of pockets, threading the
true local layout) instead of only eight/thirty-two straight rays.

Scope of "whole map" = the LOCAL danger window (~20 tiles across), NOT the
realm. No new A* and no ZDodge: this generalizes the Dijkstra already present.

## Dependencies

Plans 51 and 52 MUST be merged first (this plan reads `c.reactMargin` from
Stage 1 and runs inside the tick-locked pipeline from Stage 2). Files touched:
`UDodgeField.h`, `UDodgeField.cpp`, `UDodgeCore.cpp`, `UDodgeTypes.h`
(`CoreState` fields). Plan 54 also touches `UDodgeTypes.h`/`UDodge.cpp` but not
`UDodgeField`/`UDodgeCore` internals — merge this plan first.

## Current state

- `UDodgeField.cpp` Dijkstra grid: `kRad = 10` (±5 tiles), `kCellTiles = 0.5f`,
  `kSize = 21`, `kCells = 441` (`UDodgeField.cpp:11-14`). Linear-scan pop
  (`:91-95`) with early-exit at the first standable goal cell (`:100-104`).
  Static scratch `s_cost/s_prev/s_done` (`:25-27`), game-update thread only.
- Invocation (`UDodgeCore.cpp:506-534`): the field runs ONLY when `boxedIn`
  (no compass candidate clears `c.reactMargin`, `:509-514`) OR `hazardStuck`
  (`:515-521`). When it runs, it installs candidate `kFieldCandidate`
  (`:525-531`) which then competes in the normal lexicographic selection
  (`BetterCandidate`, `UDodgeCore.cpp:219-227`).
- `CoreState` (`UDodgeTypes.h:201-211`) holds only
  `selectedCandidate`/`selectedTick`/`haveTick`. It is passed mutably to
  `Evaluate` and persists across frames on the game-update thread.
- The map already carries a per-tick stamp: `in.tickId` (== `g_map.tickId`),
  and `state.selectedTick` is compared against it for hysteresis
  (`UDodgeCore.cpp:604`). Same-tick detection is therefore already available
  inside `Evaluate` via `state.selectedTick == in.tickId`.

## Target design

Two changes: (A) widen the grid; (B) run the field every tick and cache it.

### (A) Widen the search window

In `UDodgeField.cpp`, raise the radius so the search covers the local danger
window instead of ±5 tiles. Set `kRad = 20` (±10 tiles → `kSize = 41`,
`kCells = 1681`), keeping `kCellTiles = 0.5f` for wall/pocket precision near the
player. The linear-scan Dijkstra is O(cells²) worst case (~2.8M ops) but
early-exits at the first standable cell — in the common threatened case the
goal is a few cells away, so typical cost is a few thousand ops. Because the
search is gated to tick rate (≈5 Hz) plus on-demand recompute (below), worst
case is ~14M ops/s on the game-update thread — acceptable. Do NOT switch to a
heap or coarsen cells in this plan (keep the change mechanical and the
wall-slide precision intact); note the perf envelope in a comment.

### (B) Field runs every tick; cache across the tick

Promote the field from fallback to primary by running it whenever there is a
threat, but compute it at most once per tick (or when its cached pocket goes
unsafe), reusing the cached first-step direction between ticks.

Add to `CoreState` (`UDodgeTypes.h`):
```cpp
bool     fieldValid  = false;   // a cached escape pocket is live
uint32_t fieldTick   = 0;       // tick the pocket was computed on
Vec2     fieldTarget{};         // cached pocket (world)
Vec2     fieldFirstDir{};       // first-step direction toward the pocket
```
and reset them in `CoreState::Reset()`.

Replace the invocation block `UDodgeCore.cpp:506-534` so that, when
`in.settings.fieldEscape && speed > 0.f` AND there is a threat (the block is
already past the `threatCount == 0` early-return at `:499`):

1. Determine whether to RECOMPUTE the field this frame:
   - `tickChanged = !state.haveTick || state.fieldTick != in.tickId || !state.fieldValid`
   - `pocketUnsafe = state.fieldValid && !PointClear(in, state.fieldTarget)`
   - also recompute when boxed-in/hazard-stuck (keep the existing `boxedIn` /
     `hazardStuck` computation `:509-521` — a mid-tick box-in must react now).
   - `recompute = tickChanged || pocketUnsafe || boxedIn || hazardStuck`
2. If `recompute`: `const Field::EscapeResult esc = Field::FindEscape(in);`
   - if `esc.found`: cache it —
     `state.fieldValid = true; state.fieldTick = in.tickId;
      state.fieldTarget = esc.target; state.fieldFirstDir = esc.firstDir;`
   - else: `state.fieldValid = false;`
3. If `state.fieldValid`: install the field candidate from the cache, deriving
   the first-step direction from the CURRENT player position toward the cached
   pocket (so between-tick frames ride toward the same pocket without a new
   search):
   ```cpp
   Vec2 fdir = Normalize(Sub(state.fieldTarget, in.player));
   if (LenSq(fdir) <= 1e-6f) fdir = state.fieldFirstDir;   // already on the pocket
   const int fc = kFieldCandidate;
   c.dirs[fc] = fdir;
   c.valid[fc] = true;
   BuildProbes(c, fc);
   ScoreCandidate(c, fc);
   out.fieldActive = true;
   out.fieldTarget = state.fieldTarget;
   ```

The field candidate then competes in the existing selection unchanged: because
`BetterCandidate` (`:219-227`) ranks by clearance first, the field route wins
automatically whenever it is safer than every compass ray, and the compass
fast-path wins when a straight step is at least as clear (the tie-break `dot`
keeps intent alignment). This is the "grid is the brain, compass is the fast
path" behavior with no change to `BetterCandidate` or the ladder.

Invalidate the cache on disable: in `SetEnabled(false)`/`OnEnter`,
`g_state.Reset()` is already called (`UDodge.cpp:166,176`) and now clears the
new fields via `Reset()`.

Thread-safety / hot path: `FindEscape` and the cache live entirely on the
game-update thread (same as today). The per-tick gating keeps the widened grid
off the 60 Hz path except when the cached pocket is invalidated by a new
threat, which is exactly when a fresh route is worth computing.

## Steps

1. **`UDodgeTypes.h`** — add the four `field*` fields to `CoreState`
   (`:201-211`) and clear them in `Reset()` (`:205-210`). Build:
   `bash internal/tools/wsl-build.sh Debug`.

2. **`UDodgeField.cpp`** — change `kRad` from `10` to `20` (`:11`). Update the
   header comment on `kRad`/`kSize` to say ±10 tiles / 41×41. Add a one-line
   comment noting the O(cells²) worst case is bounded by tick-rate gating in the
   core. Build. (Behavior: the field, wherever it is still called, searches a
   wider window — otherwise identical.)

3. **`UDodgeField.h`** — update the doc comment (`:15-24`) to say the grid is
   41×41 (±10 tiles) and that the caller now invokes it as the primary
   per-tick selector, not only when boxed in. (Comment only.) Build.

4. **`UDodgeCore.cpp`** — replace the invocation block `:506-534` with the
   recompute-or-reuse logic from Target design (B). Keep the `boxedIn` and
   `hazardStuck` computations; fold them into the `recompute` predicate; add the
   cache read/write and the current-position first-step derivation. Build.

5. Run Verification, commit on `refactor/unified-gameapi` (message:
   `refactor(plan53): udodge grid-flow (widened Dijkstra) promoted to primary selector (Stage 3)`),
   and **test in-game**: in open space the dodge should still take smooth
   straight steps (compass fast-path); near walls / in pockets it should route
   AROUND them toward a real safe spot instead of stop-starting against the
   wall. The `fieldActive` overlay indicator should light whenever routing.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0

# Widened grid:
grep -n "kRad *= *20" internal/src/features/movement/udodge/UDodgeField.cpp   # 1 hit
# Field is cached in CoreState:
grep -n "fieldTarget" internal/src/features/movement/udodge/UDodgeTypes.h     # >= 1 hit
grep -n "state.fieldValid\|state.fieldTarget" internal/src/features/movement/udodge/UDodgeCore.cpp  # >= 2 hits
```

Success = clean build, guardrail exit 0, in-game routing behavior as described,
and no per-frame stutter (the widened search must not run every frame in open
combat — confirm via the debug overlay that `fieldActive` is not thrashing and
frame timing is stable).

## Out of scope

- Do NOT replace the linear-scan Dijkstra with a heap or coarsen the cells
  (defer any perf rework to its own plan if profiling demands it).
- Do NOT change `BetterCandidate`, the intent ladder, or hysteresis.
- Do NOT touch `Field::PointClear` semantics (pending zones stay cost-only,
  active zones/lanes block — that is the merged Stage-0 contract).
- Do NOT add any teleport / direct position write (Stage 4).
- Do NOT add a client setting in this plan (the field on/off toggle
  `udodgeFieldEscape` already exists and still gates the whole block).
</content>
