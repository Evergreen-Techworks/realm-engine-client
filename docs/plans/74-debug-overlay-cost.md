# 74 — Debug-Overlay Cost Reduction

## Goal
After this plan, the debug weight-heatmap draws far fewer primitives per frame
(only the cells the user can actually see, or a capped subset), and the
per-frame `PhaseTimer`/`TickTimer` probe is behind a diagnostic flag so it is
not paid in shipped Release play. The heatmap stays a correct, useful debug view
when on, and is provably zero-cost when off — but its ON-cost stops being a
2401-quad-per-frame drag. No gameplay behavior changes.

## Dependencies
Depends on **73** (both edit `UDodge.cpp`; 73 owns the grid fills, 74 owns the
TickTimer + debug publish, so they must not be rebased against each other
blindly). If plan 71 merged, this plan also touches the `PhaseTimer` it added;
coordinate by landing 71 and 73 first. Files touched: `UDodgeDebug.cpp`,
`UDodge.cpp` (timer gating + the debug-publish block).

## Current state
The heatmap `DrawWeightGrid` (`UDodgeDebug.cpp:96-145`):
- Recomputes 2401 cells' `PointSafety` + `WorldTAB::IsTileBlocked` ONLY when the
  tick id or window center changes (already cached — `UDodgeDebug.cpp:107-136`).
  This part is fine.
- **Draws 2401 `DrawCellQuad` every frame** (`UDodgeDebug.cpp:139-144`). Each
  `DrawCellQuad` projects 4 world corners to screen (`ToScreen` ×4,
  `UDodgeDebug.cpp:68-77`) and emits an `AddQuadFilled`. At 60 fps that is
  ~576k world-to-screen projections/second plus 2401 filled quads/frame in the
  ImGui draw list — a real render-thread cost, and it is drawn for cells far
  outside the viewport too.

The perf probe in `UDodge::Tick` (`UDodge.cpp:263-276`, or the `PhaseTimer` from
plan 71) calls `QueryPerformanceCounter` several times per tick unconditionally.
Cheap, but it is pure diagnostics with no runtime gate.

The heatmap is opt-in (`settings.debugWeights`, default OFF — `UDodge.cpp:41`),
so when off there is genuinely no cost. The problem is the ON cost and the
always-on timer.

## Target design

### Heatmap: draw only visible cells, capped
Two changes to `DrawWeightGrid` (`UDodgeDebug.cpp:96`):
1. **Viewport cull per cell.** `DrawCellQuad` already computes screen positions
   via `ToScreen`. Add an early reject: if the cell's projected center is outside
   the screen rect (plus a one-cell margin), skip the quad. `ToScreen` returns
   the screen point; compare against the ImGui display size
   (`ImGui::GetIO().DisplaySize`). This alone drops the drawn-quad count to just
   the on-screen window (typically a few hundred, not 2401).
2. **Batch the projection.** The cached recompute loop
   (`UDodgeDebug.cpp:117-134`) already iterates all cells to compute colors; keep
   that (it is tick-gated). The per-frame loop should only project + draw the
   cells that pass the viewport cull. Do not add a second full-grid pass.

Keep the color computation exactly as-is (server-accurate `PointSafety`, goal-cell
highlight). This is a draw-count reduction, not a semantics change.

### Perf probe: gate behind a diag flag
The `PhaseTimer`/`TickTimer` logging is a developer aid. Gate the whole timing
block behind a compile-time-cheap runtime flag so it can be disabled without a
rebuild:
- Add `std::atomic<bool> g_diagTiming{ false };` to the `UDodge` anon namespace
  and a `SetDiagTiming(bool)` setter (or reuse `g_debugWeights` if the user wants
  timing tied to the same debug toggle — prefer a dedicated flag).
- When `g_diagTiming` is false, skip the `QueryPerformanceCounter` calls and the
  accumulation (guard the `PhaseTimer` construction). The simplest correct form:
  the `PhaseTimer` ctor early-returns (records nothing) when timing is off, and
  the 120-tick log is skipped.
Default OFF in Release play; a developer flips it on to measure. This resolves
grievance (d) "any remaining per-frame cost" for the probe itself.

If plan 71 is NOT merged when this runs, apply the same gate to the existing
`TickTimer` struct instead.

## Steps

1. In `UDodgeDebug.cpp`, add a viewport-cull early-out inside `DrawCellQuad` (or
   a small `OnScreen(ImVec2)` helper): reject cells whose projected center is
   outside `DisplaySize` expanded by ~2 cell widths. Apply it in the per-frame
   draw loop (`UDodgeDebug.cpp:139-144`) so only visible cells emit quads.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Verify the heatmap still renders correctly when on (colors + goal cells) and
   that off-screen cells are no longer drawn (draw-list size drops). In-game with
   `debugWeights` on, pan the camera — the heatmap should fill the viewport and
   nothing beyond it.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. In `UDodge.cpp`, add `g_diagTiming` (default false) + `SetDiagTiming`/
   `GetDiagTiming` accessors (mirror the existing bool setters at
   `UDodge.cpp:747-750`). Gate the `PhaseTimer` (plan 71) or `TickTimer`
   construction and the 120-tick log behind it so timing is skipped when off.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. (Optional, only if a UI surface is wanted) add a "Diag timing" checkbox in
   `RenderSettings` (`UDodge.cpp:648`) next to the weight-grid checkbox. Not
   required — the setter can be driven from IPC/console. Skip if it widens scope.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. Perf validation (Release): with heatmap ON, compare the render-thread cost /
   frame time before vs after (draw-list quad count is the direct proxy — log it
   once per 120 frames if a quick counter helps). With `g_diagTiming` off, the
   Tick per-phase timing calls are gone.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/wsl-build.sh Release` → 0 errors.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- Heatmap ON: fills the viewport, colors + goal-cell highlight unchanged, no
  quads drawn off-screen; frame time with heatmap on is materially lower than a
  pre-74 build.
- Timing OFF (`g_diagTiming` false, the default): no per-phase log line appears
  and no `QueryPerformanceCounter` is called in `Tick` (confirm via the missing
  log line).
- No gameplay change: dodge behaves identically with the overlay off.

## Out of scope
- Do NOT remove the heatmap or change its color/semantics.
- Do NOT change the cached recompute (it is already tick-gated and correct).
- Do NOT touch the danger-lane / route / enemy-circle / nav overlays — only the
  weight-grid draw count and the timer gate.
- Do NOT change any solver/pathfinder/occupancy logic.
