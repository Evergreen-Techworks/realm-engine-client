# 72 — Shared Temporal-Prediction Core (dedup the arrival-time model)

## Goal
After this plan, the arrival-time bullet-prediction model (sample each lane's
polyline over a bounded horizon, swept-segment clearance at arrival time) exists
in **exactly one place** — a new pure plain-data module in `UDodgeCore` — and
BOTH the game-thread solver (`UDodgeSolver.cpp`) and the worker pathfinder
(`UDodgePathfinder.cpp`) call it. Roughly 120 lines of copy-pasted temporal code
collapse to one implementation. Behavior is identical: the two current copies
already agree, so this is a mechanical merge, not a behavior change.

## Dependencies
None — parallel-safe (Wave A). It is the prerequisite for **75** (annulus),
which edits the same solver/pathfinder files; land 72 first so 75 edits the
post-dedup code. Files touched: `UDodgeCore.h`, `UDodgeCore.cpp`,
`UDodgeSolver.cpp`, `UDodgePathfinder.cpp`. No other plan in Wave A touches
these, so 72 has no inbound conflicts.

## Current state — the exact duplication
Two near-identical implementations of the same model:

**Solver copy** (`UDodgeSolver.cpp`, anonymous namespace):
- `SampleLaneOverTime(const LaneThreat&, Vec2* outPos)` — `UDodgeSolver.cpp:215-234`.
- `struct TempCtx { int count; Vec2 pos[kMaxProjectiles][kUTemporalSamples]; float half[kMaxProjectiles]; }` — `UDodgeSolver.cpp:205-209`.
- `BuildTempCtx(const MapInput&, TempCtx&)` — `UDodgeSolver.cpp:239-258` (culls
  relative to `in.player`).
- `TemporalPathClear(const MapInput&, const TempCtx&, Vec2 P)` — `UDodgeSolver.cpp:266-292`
  (player walks straight to P at `in.speed`, marches time, swept check).
- `IsDurablePocketTemporal(...)` — `UDodgeSolver.cpp:299-307` (wraps the above +
  occupancy + enemy + safe-now floor).
- `constexpr int kUTemporalSamples = kUTemporalSteps + 1;` — `UDodgeSolver.cpp:199`.

**Pathfinder copy** (`UDodgePathfinder.cpp`, anonymous namespace):
- `SampleLaneOverTime(const LaneThreat&, Vec2* outPos)` — `UDodgePathfinder.cpp:123-142`.
- `s_tcCount`, `s_tcPos[kMaxProjectiles][kTSamples]`, `s_tcHalf[kMaxProjectiles]`
  worker-static scratch — `UDodgePathfinder.cpp:116-118`.
- `BuildTempCtx(const PlannerSnapshot&)` — `UDodgePathfinder.cpp:148-170` (culls
  relative to `s.grid.center`, NOT `in.player`).
- `BulletPosAt(int li, float tMs)` — `UDodgePathfinder.cpp:175-183` (interpolate
  within the march grid).
- `ArrivalClear(Vec2 B, float tA, float tB)` — `UDodgePathfinder.cpp:192-202`
  (swept segment over the arrival window).
- `constexpr int kTSamples = kUTemporalSteps + 1; constexpr float kTHorizonMs = kUTemporalSteps * kUTemporalStepMs;` — `UDodgePathfinder.cpp:110-111`.

Both read the same constants (`kUTemporalSteps`, `kUTemporalStepMs`,
`kMaxProjectiles`, `kUPocketMargin`, `kUPlayerHalf`) and the same `hitScale`
clamp `[0.25, 2.5]`, and both build `half = clamp(hitHalf,0.05,2.5)*hitScale +
kUPlayerHalf`. `SampleLaneOverTime` is byte-for-byte identical logic.

### Divergence to preserve (do NOT silently unify away)
1. **Cull center differs on purpose.** The solver culls lanes by distance to
   `in.player`; the pathfinder culls by distance to `s.grid.center` (the boss
   when locked) so a lane threatening the far side of the in-range disk is kept.
   This is intentional and correct. The shared `BuildTempCtx` MUST take the cull
   center as a parameter, not hardcode the player.
2. **Cull radius differs on purpose.** Solver cull = `kUTemporalCullTiles`;
   pathfinder cull = `kUPathMaxRadCells * kUPathCellTiles + kUTemporalCullTiles`
   (window extent + margin). Keep both — pass the cull radius as a parameter.
3. **Query shape differs.** The solver asks `TemporalPathClear(P)` (player walks
   toward a single point P and holds). The pathfinder asks `ArrivalClear(B, tA,
   tB)` (edge relaxation over an explicit arrival window). These are two
   different *queries* over the *same context*. The shared module must expose
   BOTH query shapes over ONE context type; do not force one into the other.

## Target design
New shared module: **`UDodge::Core::Temporal`** in `UDodgeCore.{h,cpp}` (it is
already the home of the pure plain-data spatial primitives). All functions are
pure, plain-data, IL2CPP-free, and safe to call from the worker thread (they
take a caller-owned context; no globals).

```cpp
// UDodgeCore.h — inside namespace UDodge { namespace Core {
namespace Temporal {

constexpr int kSamples = kUTemporalSteps + 1;                 // incl. t=0
constexpr float kHorizonMs = kUTemporalSteps * kUTemporalStepMs;

// Culled arrival-time context: for each RELEVANT lane, predicted bullet
// position at each march sample + effective hit half (bullet half*scale +
// kUPlayerHalf). Fixed-size, no heap; caller owns the storage (stack in the
// solver, worker-static in the pathfinder). Single-writer per instance.
struct Ctx {
    int   count = 0;
    Vec2  pos[kMaxProjectiles][kSamples];
    float half[kMaxProjectiles];
};

// Sample one lane's spacetime polyline at each march time (clamp past the
// traced horizon). Extracted verbatim from the two identical copies.
void SampleLane(const LaneThreat& L, Vec2* outPos);   // outPos[kSamples]

// Build the context from a danger map: predict each lane once, cull lanes whose
// whole traced path stays > cullTiles from cullCenter over the horizon.
// cullCenter/cullTiles are PARAMETERS (solver: player/kUTemporalCullTiles;
// pathfinder: grid.center/window+margin) — see divergence note.
void Build(const DangerMap& map, float hitScale, Vec2 cullCenter,
           float cullTiles, Ctx& out);

// Bullet position at arbitrary t within the march grid (clamped to [0,horizon]).
Vec2 BulletPosAt(const Ctx& c, int li, float tMs);

// Query A (solver): player walks straight from `player` to P at `speed`
// (tiles/ms), arriving at tArrive, then holds; clear at every march step?
bool PathClear(const Ctx& c, Vec2 player, float speed, Vec2 P);

// Query B (pathfinder edge relaxation): standing at B, is every bullet clear
// over the arrival window [tA, tB] (swept)?
bool ArrivalClear(const Ctx& c, Vec2 B, float tA, float tB);

} } } // Temporal / Core / UDodge
```

Notes:
- `Build` folds the `hitScale` clamp `[0.25,2.5]` and the `half` formula exactly
  as both copies do today.
- `PathClear` reproduces `TemporalPathClear` exactly, including the
  `+ kUPocketMargin` slack on `half` and the final t=horizon hold sample
  (`UDodgeSolver.cpp:286-289`).
- `ArrivalClear` reproduces the pathfinder's swept `MinChebOnSegment` test
  exactly, including `+ kUPocketMargin`.
- The solver's `IsDurablePocketTemporal` (`UDodgeSolver.cpp:299`) stays in the
  solver — it composes `PathClear` with occupancy/enemy/safe-now checks that are
  solver-specific. Only its temporal call routes through `Temporal::PathClear`.

`kMaxProjectiles` bound: both copies already cap the context at
`kMaxProjectiles`; keep that cap in `Build`.

## Steps

1. Add the `Temporal` namespace declaration to `UDodgeCore.h` (signatures
   above) and implement `SampleLane`, `Build`, `BulletPosAt`, `PathClear`,
   `ArrivalClear` in `UDodgeCore.cpp` by moving the bodies verbatim from the two
   existing copies (use the solver copy for `SampleLane`/`Build`/`PathClear`,
   the pathfinder copy for `BulletPosAt`/`ArrivalClear`; they match). Parameterize
   the cull center/radius as designed. Do NOT wire any caller yet.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Migrate the **pathfinder** to the shared module. In `UDodgePathfinder.cpp`:
   - Replace worker-static `s_tcPos/s_tcHalf/s_tcCount` with a single
     worker-static `Core::Temporal::Ctx s_tctx;` (still worker-static — single
     thread).
   - Replace `BuildTempCtx(s)` calls with
     `Core::Temporal::Build(s.map, s.settings.hitScale, s.grid.center,
     kUPathMaxRadCells*kUPathCellTiles + kUTemporalCullTiles, s_tctx);`.
   - Replace `ArrivalClear(wB, tA, tB)` with
     `Core::Temporal::ArrivalClear(s_tctx, wB, tA, tB)`.
   - Replace `s_tcCount` reads (diagnostics `out.tempLanes = s_tcCount`) with
     `s_tctx.count`.
   - Delete the local `SampleLaneOverTime`, `BuildTempCtx`, `BulletPosAt`,
     `ArrivalClear`, and the `s_tc*` scratch + `kTSamples`/`kTHorizonMs`.
   Behavior is identical (same cull center/radius, same math).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Migrate the **solver** to the shared module. In `UDodgeSolver.cpp`:
   - Replace `struct TempCtx` + `SampleLaneOverTime` + `BuildTempCtx` +
     `TemporalPathClear` with calls into `Core::Temporal`.
   - `BuildTempCtx(in, ctx)` → `Core::Temporal::Build(*in.map, in.settings.hitScale,
     in.player, kUTemporalCullTiles, ctx)` where `ctx` is a stack
     `Core::Temporal::Ctx`.
   - `TemporalPathClear(in, ctx, target)` → `Core::Temporal::PathClear(ctx,
     in.player, in.speed, target)`.
   - Update `out.tempLanes = static_cast<uint8_t>(std::min(ctx.count, 255))`.
   - `IsDurablePocketTemporal` keeps its structure but calls
     `Core::Temporal::PathClear`.
   - Delete `kUTemporalSamples` (now `Core::Temporal::kSamples`).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. Confirm the two former copies are fully gone and only the shared module
   remains (see grep in Verification).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- Behavior parity (Release recommended): with a boss locked and shots incoming,
  the overlay's `tempLanes` count, route, and dodge decisions are identical to a
  pre-72 build in the same scenario. The pre-position / hold / fallback labels in
  the `[UDodge] MOVE` log are unchanged.
- Dedup complete — this grep must return **zero** hits in each of
  `UDodgeSolver.cpp` and `UDodgePathfinder.cpp` (the definitions now live only in
  `UDodgeCore.cpp`):
  ```
  command grep -n "void SampleLaneOverTime\|struct TempCtx\|void BuildTempCtx\|bool TemporalPathClear\|Vec2 BulletPosAt\|bool ArrivalClear" \
    internal/src/features/movement/udodge/UDodgeSolver.cpp \
    internal/src/features/movement/udodge/UDodgePathfinder.cpp
  ```
- `command grep -rn "Core::Temporal::" internal/src/features/movement/udodge/`
  returns hits in BOTH `UDodgeSolver.cpp` and `UDodgePathfinder.cpp`.

## Out of scope
- Do NOT change the cull center/radius values or the horizon constants — this is
  a lift-and-share, not a tuning pass.
- Do NOT touch `PointSafety`/`PointSafe`/`LaneDistCheb`/`EnemyBlocked` (the
  spatial primitives) — only the temporal model moves.
- Do NOT alter the in-range-disk gating or the annulus (that is plan 75).
- Do NOT change occupancy or grid rasterization (plan 73).
