# 60 — Stage D1: Whole-Window Path Planner + Path Overlay

## Goal
After this plan, the worker thread runs a whole-local-window Dijkstra that routes
the player around walls, hazards, pending zones, and danger lanes to the autopilot
goal, and returns the full route as a plain-data polyline. The planned path is
drawn on the debug overlay ("paths around the map"). The game thread consumes the
route's first step as the autopilot intent; the per-frame dodge still overrides it
whenever a bullet threatens. This is the mechanism; boss-fight goal POLICY and
settings/UX come in plan 61.

## Dependencies
Plan 59 merged (worker thread + handoff). Touches
`internal/src/features/movement/udodge/UDodgePlanner.{h,cpp}`, `UDodge.cpp`,
`UDodgeTypes.h`, `UDodgeDebug.cpp`. Plan 61 builds on the route it produces.

## Current state (after 59)

- `PlannerSnapshot` carries only scalars + lock (plan 58). `Planner::Compute`
  returns an orbit `firstDir` (no routing, no walls). The worker runs it off-thread.
- A wall/danger-aware Dijkstra ALREADY EXISTS as `UDodge::Field::FindEscape`
  (`UDodgeField.cpp:70-158`): 21×21 half-tile grid, no corner-cutting
  (`:113-120`), hazard/zone/lane as traversable cost (`:122-133`), reconstructs a
  first step. But it reads the world through `in.env.canOccupy/isHazard`
  (`UDodgeField.cpp:37-45`) — IL2CPP-backed function pointers that CANNOT run on
  the worker thread, and it is a short-horizon ESCAPE search (nearest safe pocket),
  not a route-to-goal. It stays as the game-thread emergency escape (used by
  `Core::Evaluate` at `UDodgeCore.cpp:524-535`) — do NOT modify it here.

## Target design

### 1. Rasterized occupancy grid in the snapshot (game thread fills it)
In `UDodgePlanner.h`, add:
```cpp
constexpr int   kPlanGridRadius = 40;                       // cells from center
constexpr int   kPlanGridSize   = kPlanGridRadius * 2 + 1;  // 81
constexpr int   kPlanGridCells  = kPlanGridSize * kPlanGridSize;
constexpr float kPlanCellTiles  = 0.5f;                     // 40 tiles reach each way
constexpr int   kMaxPathPoints  = 48;

struct OccGrid {
    Vec2    center{};                 // world position of the grid center (= player)
    uint8_t flags[kPlanGridCells]{};  // bit0 = wall/blocked, bit1 = hazard
};
```
Extend `PlannerSnapshot` with `DangerMap map;` and `OccGrid grid;`. Extend
`PlanResult` with `Vec2 path[kMaxPathPoints]{}; int pathCount = 0;`.

The GAME thread fills `grid` in `Tick` before publishing: for each cell
`(gx,gy)`, world `= player + Vec2{(gx-R),(gy-R)} * kPlanCellTiles`; set bit0 from
`!Sensors::CanOccupy(wx, wy, false)` (walls only — `false` so hazard is cost, not
block, matching `UDodgeField::IsWall`), set bit1 from
`Sensors::IsHazardAt(wx, wy)`. Reuse the per-tick hazard memo already in
`UDodgeSensors` (`MemoFind/MemoInsert`). Copy `g_map` into `snap.map`.

**HOT PATH NOTE (respect this):** 81×81 = 6561 `CanOccupy` calls per publish is
the single largest new game-thread cost. `Sensors::CanOccupy`/`IsHazardAt` are
memoized per tile, so the cost is bounded, but to keep it off the frame budget:
rasterize the WALL bits only on `rebuiltThisFrame` (walls are static within a
server tick — `UDodge.cpp:309` already exposes `rebuilt`), and refresh HAZARD bits
each publish (cheap via memo). Guard the whole fill in the existing per-tick memo
lifetime. If profiling shows a regression, drop `kPlanGridRadius` to 24. Make the
radius a constant so plan 61 can expose it.

### 2. Worker-side whole-window Dijkstra (`Planner::Compute`)
Rewrite `Compute` to, when `in.hasGoal`:
- Map the goal world pos into the grid; clamp to the nearest in-window cell; that
  is the goal cell.
- Run Dijkstra from the player center cell over `in.grid` (8-neighbour, NO
  corner-cutting — port the exact rule from `UDodgeField.cpp:113-120` but reading
  `grid.flags` bit0 for walls), with step cost + penalties: hazard bit → high
  cost; for each cell, danger-lane cost (min-Chebyshev to `in.map.lanes` ≤ hitHalf)
  and pending-zone cost (inside `in.map.zones` where `!active`) — port the cost
  loop from `UDodgeField.cpp:122-133`, reading the PLAIN `in.map` (no env). Active
  zones and lanes cost heavily but stay traversable so a boxed goal is still
  reachable; the GOAL cell itself must be clear (lane-Chebyshev > hitHalf, outside
  active zones — a plain-data port of `Core::PointClear`).
- Reconstruct the path; downsample to ≤ `kMaxPathPoints` into `out.path/pathCount`
  (world coords). Set `out.firstDir = Normalize(path[1] - player)`; if the path is
  degenerate (goal == player cell), fall back to the straight orbit `firstDir`
  (keep the orbit helper from plan 58 as the fallback). `out.goalPos` = goal world.
- When `!in.hasGoal`: clear path, `firstDir = {}`.

All of this reads only plain data (`in.grid`, `in.map`, scalars) — thread-safe.

### 3. Draw the path (overlay)
Add `Vec2 path[kMaxPathPoints]; int pathCount;` to `DebugSnapshot`
(`UDodgeTypes.h:215-239`). In `Tick`, copy the consumed plan's path into the
published `DebugSnapshot` (`UDodge.cpp:291-317`). In `UDodgeDebug.cpp`
(`Debug::Render`), draw the polyline (world→screen via the existing camera params)
as a distinct color (e.g. cyan) with the goal marker. Reuse the existing
world-to-screen transform already used for the field target / candidate rays.

## Steps

1. **Extend the plain-data types** (`UDodgePlanner.h`): `OccGrid`, grid constants,
   `PlannerSnapshot.map/grid`, `PlanResult.path/pathCount`. Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

2. **Fill the grid on the game thread** in `Tick` (walls on rebuild, hazard each
   publish; copy `g_map` into the snapshot). Build + guardrail. Verify no framerate
   regression in-game (watch for stutter; if present, lower `kPlanGridRadius`).

3. **Implement the worker Dijkstra** in `Planner::Compute` (port the grid rules
   and cost from `UDodgeField.cpp`, reading `in.grid`/`in.map`). Keep the orbit
   fallback. Build + guardrail.

4. **Draw the path**: extend `DebugSnapshot`, copy path in `Tick`, render the
   polyline + goal in `UDodgeDebug.cpp`. Build + guardrail.

5. **In-game verify** (see Verification). The dodge must still pre-empt the path
   the instant a bullet threatens (this is inherent — the path only feeds
   `in.intentDir`, which `Core::Evaluate` overrides). Keep diagnostics.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

In-game (Autopilot on, boss present):
- A cyan planned path is drawn from the player, routing AROUND walls/hazards to the
  orbit goal, and it re-plans as the player/boss move.
- The player follows the path when safe, and BREAKS from it to dodge when a bullet
  approaches, resuming the path after.
- No framerate regression from the grid rasterization (compare FPS with UDodge on
  vs off; if a stutter appears, note it for the radius tuning in plan 61).
- No IL2CPP crash (the worker reads only `in.grid`/`in.map`).

## Out of scope
- Do NOT modify `UDodgeField.{h,cpp}` — the game-thread emergency escape stays.
- Do NOT add boss range-band POLICY, orbit hysteresis, or new client settings
  (plan 61).
- Do NOT move the dodge `Core::Evaluate` off the game thread.
- Do NOT introduce a raw position write.
