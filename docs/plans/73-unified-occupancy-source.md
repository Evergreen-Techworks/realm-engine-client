# 73 — Unified Occupancy Source (one bulk reader, one footprint)

## Goal
After this plan, "is this cell walkable?" is answered from **one source
(`WorldTAB::s_blockedMap`) through one bulk-locked reader with one agreed
footprint semantics**, for BOTH the dodge occupancy grid and the nav occupancy
grid. The per-cell `Sensors::CanOccupy` mutex storm in `FillOccGrid` (up to
~2401 cells × several `s_tileMapMutex` acquisitions per tick) collapses to a
single bulk-locked pass, matching how the nav grid is already filled. This is
the largest measurable per-tick perf win in the subsystem and it removes the
three-way divergence in how walkability is computed.

## Dependencies
None to start — parallel-safe (Wave A). **Plan 74 depends on this** (both edit
`UDodge.cpp`). Files touched: `WorldTAB.cpp`, `WorldTAB.h`, `UDodge.cpp`
(`FillOccGrid` / `FillNavGrid`), and `UDodgeSensors.cpp` (only if the footprint
decision changes `CanOccupy`; see below). `WorldTAB.cpp` edits are **purely
additive** (a new bulk reader beside the existing `CopyNavBlocked`) to minimize
any conflict with other work on that file.

## Current state — the three-way divergence
There are three different walkability computations, all ultimately over
`WorldTAB::s_blockedMap` (`WorldTAB.cpp:99`) but with different footprints:

1. **Dodge grid fill** — `FillOccGrid` (`UDodge.cpp:135-155`) calls
   `Sensors::CanOccupy(wx, wy, false)` **per cell** (2401 cells):
   ```cpp
   if (!Sensors::CanOccupy(wx, wy, false)) f |= 0x1;   // UDodge.cpp:148
   ```
   `CanOccupy` (`UDodgeSensors.cpp:511-517`) →
   `TestTAB::IsWalkPositionBlocked(x,y)` → `IsPositionBlocked`
   (`TestTAB.cpp:308-323`): a **player-box footprint** — it floors
   `cx ± kPlayerChebyshevScale (0.2285)` and returns blocked if ANY tile in that
   1-2 tile box is `WorldTAB::IsTileBlocked` — PLUS a noclip override
   (`NoclipWalkabilityOverride`). Each `IsTileBlocked` locks `s_tileMapMutex`
   (`WorldTAB.cpp:2205-2209`). So one cell = up to ~4 tile-mutex acquisitions.

2. **Nav grid fill** — `FillNavGrid` (`UDodge.cpp:162-168`) calls
   `WorldTAB::CopyNavBlocked(minTx, minTy, side, safeWalk, flags)`
   (`WorldTAB.cpp:2217-2230`): a **single-tile** read per cell (`floor` only, no
   player box, no noclip), one bulk `s_tileMapMutex` lock for the whole grid.

3. **Worker** re-reads the rasterized bits: `GridBlocked`
   (`UDodgePathfinder.cpp:207-214`, dodge) and `NavBlocked`
   (`UDodgePathfinder.cpp:509-515`, nav) — these just read the plain flags, so
   they inherit whichever footprint the fill used.

Consequences:
- The dodge search and the nav search disagree on which cells are walkable near
  a wall (player-box vs single-tile). The user reported walking into walls in
  one mode and being over-conservative in another; this split is a root cause.
- The dodge grid pays the mutex storm every tick; the nav grid does not.

`FillOccGrid` also folds hazard as a SEPARATE bit (bit1) refreshed every call
via `Sensors::IsHazardAt` (the per-tick memo), while walls (bit0) rebuild only
on a full map rebuild (`rebuildWalls`). `CopyNavBlocked` folds hazard INTO the
blocked bit when `safeWalk` (`WorldTAB.cpp:2226`). Preserve the dodge grid's
separate-bit design (the worker folds `safeWalk` itself to match `CanOccupy`).

## Target design

### Decision: the correct footprint
Adopt the **player-box footprint** (semantics #1) as the single truth for BOTH
grids, because it is the one that matches the game's own walkability
(`kPlayerChebyshevScale` mirrors the player's environment-collision half-edge)
and is what keeps the dodge from clipping wall corners. The nav grid moving from
single-tile to player-box makes walk-to slightly more conservative near walls —
correct, since the current single-tile nav routinely routes the player edge into
a wall the game then blocks. State this as the intended behavior change (it is
the fix for "walk-to walks into walls").

Noclip override: `IsPositionBlocked` also consults `NoclipWalkabilityOverride`.
Noclip is a movement cheat rarely combined with auto-dodge; to keep the bulk
reader lock-simple, the bulk reader reads `s_blockedMap` (+ optional damaging)
directly and does NOT consult noclip. If noclip is active, the dodge already
lets the player pass walls; leaving noclip out of the planner's occupancy only
makes the planner treat walls as solid while noclip lets the player through —
conservative, never a safety regression. Document this in the reader's comment.

### New bulk reader in WorldTAB (additive)
Add beside `CopyNavBlocked` (`WorldTAB.cpp:2217`) a **player-box bulk reader**
that fills a grid at an arbitrary cell size, taking `s_tileMapMutex` **once**:

```cpp
// WorldTAB.h (namespace WorldTAB)
// Bulk player-box occupancy over a grid of `side`×`side` cells, cell size
// cellTiles, centered so cell (gx,gy) maps to world
// (originX + gx*cellTiles, originY + gy*cellTiles). A cell is blocked if the
// player-box footprint (± kPlayerHalfEdge, matching the game's collision
// half-edge) over it touches any blocked tile; when foldHazard, damaging tiles
// count too. ONE tile-mutex acquisition for the whole grid. Undiscovered tiles
// are walkable (optimistic). Noclip is intentionally NOT consulted (planner
// treats walls as solid; noclip lets the player through anyway — never unsafe).
void CopyBoxBlocked(float originX, float originY, int side, float cellTiles,
                    float playerHalfEdge, bool foldHazard, unsigned char* out);
```

Implementation: lock `s_tileMapMutex` once; for each cell compute its world
center, floor `center ± playerHalfEdge` on each axis, and test that small tile
box against `s_blockedMap` (and `s_damagingMap` when `foldHazard`). Reuse
`BlockedKey`. This is the `IsPositionBlocked` box logic, hoisted out of the
per-cell path and run under a single lock.

Expose the collision half-edge constant so the caller passes the same value the
game uses: reuse `kUPlayerHalf`-style constant — but note `IsPositionBlocked`
uses `kPlayerChebyshevScale = 0.2285` (`TestTAB.cpp:123`), NOT `kUPlayerHalf =
0.2139`. Use **0.2285** here to exactly match the existing dodge occupancy
(`TestTAB::IsWalkPositionBlocked`), so the dodge grid's walkability is unchanged
by this migration. Add a named constant `kUOccPlayerHalfEdge = 0.2285f` in
`UDodgeTypes.h` and pass it.

Divergence warning: do NOT use `kUPlayerHalf` (0.2139, the *bullet-hit* player
half) for occupancy — that is a different quantity. The occupancy footprint is
`kPlayerChebyshevScale` (0.2285, the *collision* half-edge). Keeping them
distinct is correct; conflating them would subtly change wall clearance.

### Rewire the two fills
- `FillOccGrid` (`UDodge.cpp:135`): when `rebuildWalls`, replace the 2401 per-cell
  `CanOccupy(...,false)` calls with ONE
  `WorldTAB::CopyBoxBlocked(originX, originY, kUPathMaxSide, kUPathCellTiles,
  kUOccPlayerHalfEdge, /*foldHazard=*/false, wallScratch)` into a temporary
  `uint8_t[kUPathMaxCells]`, then set bit0 from `wallScratch`. Hazard bit1 stays
  per-cell via `Sensors::IsHazardAt` (unchanged — it uses the cheap per-tick
  memo, not the tile mutex per cell in a storm). `originX/originY` = the
  world position of cell (0,0) = `player - R*cell` on each axis (matching the
  current `player.x + (gx-R)*cell`).
- `FillNavGrid` (`UDodge.cpp:162`): replace `CopyNavBlocked` with
  `CopyBoxBlocked(originX, originY, kUNavSide, kUNavCellTiles,
  kUOccPlayerHalfEdge, /*foldHazard=*/safeWalk, grid.flags)`. `originX/originY`
  = `floor(player) - kUNavRadCells` (keep the existing integer origin so cell
  centers land on tile centers as before; note the box now samples the footprint
  around each 1-tile cell center).

Keep the worker's `GridBlocked`/`NavBlocked` unchanged — they read the plain
bits, which now come from one source.

`CopyNavBlocked` becomes unused by udodge after this. Leave it in `WorldTAB` if
other callers exist; grep first. If nothing else uses it, you may delete it in a
final step (optional; not required).

## Steps

1. Add `kUOccPlayerHalfEdge = 0.2285f` to `UDodgeTypes.h` (near `kUPlayerHalf`,
   with a comment distinguishing collision half-edge from bullet-hit half).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Add `WorldTAB::CopyBoxBlocked` (declaration in `WorldTAB.h`, definition in
   `WorldTAB.cpp` beside `CopyNavBlocked`). One `s_tileMapMutex` lock; player-box
   footprint over `s_blockedMap` (+ `s_damagingMap` when `foldHazard`). Do NOT
   wire any caller yet.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Rewire `FillNavGrid` (`UDodge.cpp:162`) to `CopyBoxBlocked` with
   `foldHazard = safeWalk`. Build + in-game: walk-to still produces a corridor;
   near walls it now hugs slightly less (the intended fix).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. Rewire `FillOccGrid` (`UDodge.cpp:135`) wall bits to `CopyBoxBlocked`
   (`foldHazard=false`) into a scratch buffer, keeping the per-cell hazard bit
   via `Sensors::IsHazardAt`. Preserve the `rebuildWalls` gating (walls only on
   full rebuild). Verify the dodge grid walkability is byte-identical to before
   (same footprint constant 0.2285, same source) — this step is pure perf, no
   behavior change.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. Grep for other `CopyNavBlocked` callers. If none remain, remove the now-dead
   `CopyNavBlocked` from `WorldTAB.{h,cpp}`; if others exist, leave it.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

6. Perf validation (Release, using plan 71's per-phase timer if merged, else the
   lumped timer): record `raster` phase avg/max before vs after. Expect a clear
   drop in the rasterize cost (the mutex storm is gone).

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/wsl-build.sh Release` → 0 errors; record `raster` timing.
- `bash internal/tools/check-raw-access.sh` → exit 0 (the new reader lives in
  `gui/tabs/WorldTAB.cpp`, which already owns tile-map access; no raw IL2CPP is
  added in `features/`).
- Behavior: dodge grid walkability unchanged (same footprint); walk-to routes no
  longer send the player edge into walls (visible on the nav overlay corridor).
- One-source check — `FillOccGrid`/`FillNavGrid` must no longer call the
  per-cell walkability path for the grid fill:
  ```
  command grep -n "Sensors::CanOccupy" internal/src/features/movement/udodge/UDodge.cpp
  ```
  should show `CanOccupy` no longer used inside `FillOccGrid`'s wall loop (it may
  still be referenced as the worker's contract comment / `in.env.canOccupy` — do
  not remove the Env plumbing). And:
  ```
  command grep -n "CopyBoxBlocked" internal/src/features/movement/udodge/UDodge.cpp
  ```
  shows both fills routing through the one reader.

## Out of scope
- Do NOT remove `Sensors::CanOccupy` itself — the solver/core still use it via
  `in.env.canOccupy` for the *single-point* re-validation of the actual step
  (`UDodgeSolver.cpp:401`, `UDodge.cpp` step re-check). Only the bulk grid FILL
  moves off it.
- Do NOT change the hazard model, the memo, or `IsHazardAt`.
- Do NOT merge the two grids into one physical array or change grid
  radii/resolutions (rejected on the hot path — see plan 70).
- Do NOT touch the worker search logic or the temporal model (plan 72).
