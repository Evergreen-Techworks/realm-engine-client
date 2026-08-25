# 64 — UDodge: Per-Tick Safe-Position Solver (replace reactive heuristic dodge)

## Goal
Replace UDodge's reactive apparatus (35-candidate `ScoreOf` selection, the worker-thread
whole-map Dijkstra planner, path commitment, orbit weaving, field-escape search) with a
single **per-server-tick geometric solver**. Each server tick the solver computes the
player position — within the legal per-tick move budget — that lies **outside every
bullet's server hit region** and is best by a *smart-direction* objective, then drives the
player there through the game's own speed-clamped `MoveTo` so the position reported in the
outgoing MOVE packet is provably not inside any shot. Safety becomes a **hard constraint**;
goal/commitment/minimal-move are how we choose *among* the safe reachable points. This also
fixes a latent safety bug (the danger map omits the player half-extent, so today's "safe"
test is ~0.21 tiles too optimistic — a primary reason the player still gets clipped) and
retires the per-frame machinery that drops FPS.

After this plan: UDodge holds the player in a provably-safe reachable cell every tick when
one exists; when fully surrounded it falls back to the least-bad (max-min-clearance) cell
and says so honestly. No worker thread, no Dijkstra, no 35-candidate scoring on the hot path.

---

## Dependencies
None — parallel-safe with other workstreams. This plan is **self-contained inside
`internal/src/features/movement/udodge/`** plus two read-only references
(`.../dodge/MovementRuntime.h`, `.../dodge/DodgeHit.h`).

Files this plan touches (predict conflicts): everything under
`internal/src/features/movement/udodge/`. No other plan should be editing `udodge/`
concurrently. It does **not** touch `repp/`, `pjdodge/`, `zdodge/`, `dodge/DangerPlanner.cpp`
(beyond reading), or any GUI cleanup-wave files.

---

## Background: how movement actually reaches the server (verified pipeline)

Read this before touching code — the insertion point and the "MoveTo vs raw write" decision
depend on it.

1. **Game-update-thread dispatch.** The dodge tick runs inside the
   `AppEngineManager::Update` MinHook in
   `internal/src/features/movement/dodge/DangerPlanner.cpp`. It resolves the live player
   pointer (`GameState::GetLocalPtr()`, `DangerPlanner.cpp:755`), reads the live world
   position (`ReadLivePlayerPosition`, `DangerPlanner.cpp:768`), gets Unity `deltaTime`
   (`DangerPlanner.cpp:764`), then dispatches `UDodge::Tick(p, px, py, dt)` at
   `DangerPlanner.cpp:775`. **Do not change the dispatch** — UDodge already owns this entry.

2. **How a solved position reaches the server.** UDodge issues movement through
   `DodgeRuntime::CallMoveTo(player, x, y)` (`UDodge.cpp:393`), which calls the game's
   `FKALGHJIADI::DGLCONCOIBO` (`MoveTo`) via `MovementRuntime.cpp:139`. `MoveTo` is
   **virtual, speed-clamped, collision-checked, and packet-emitting** — it updates the
   player position that the game serializes into the next MOVE record. The MOVE packet
   (`client/packages/protocol/src/packets/outgoing/move-packet.ts`, records =
   `time` + `WorldPosData` in `move-record.ts`) is built by the *game*, not the client
   proxy; the proxy only forwards it. The server validates each record against a per-tick
   speed budget (`speed × tickTime`); exceeding it rubber-bands the player and flags
   speedhack. **`MoveTo` is therefore the correct and only safe insertion point.**

3. **The raw-write path is WRONG for continuous dodge.** `TestTAB` Ctrl+Click teleport
   raw-writes `PosX`/`PosY`/`KJ_Float3Pos` (`gui/tabs/TestTAB.cpp:801-804`). Per
   `dodge/DangerPlanner.h:31-34` this **bypasses ACTk's rigidbody sync and causes server
   snap-backs**; it is only tolerable there because it is ≤2 tiles and user-triggered.
   A per-tick solver that raw-wrote every tick would be flagged. **Use `CallMoveTo`, never
   the raw write.**

4. **Does `MoveTo`'s speed clamp interfere with the solve?** No — as long as the solved
   target `p` is within one tick's move budget of the tick-start position. `MoveTo` clamps
   each *frame* to the game's per-frame speed cap; calling it toward `p` every frame
   (~12 frames per 200 ms tick) converges the player onto `p` by the tick boundary without
   ever exceeding the budget. The clamp only *paces* convergence; it never refuses an
   in-budget target. This is exactly what today's code already relies on
   (`moveTarget = player + velocity × frameMs`, `UDodge.cpp:392`).

5. **Tick edge + danger map (KEEP all of this).** `Sensors::ReadWorldTick` reads
   `RuntimeOffsets::WM_TickId` (`UDodgeSensors.cpp:370`). On a tick change UDodge rebuilds
   the `DangerMap` (`Sensors::BuildMap`, `UDodgeSensors.cpp:274`); between ticks it
   re-anchors lanes to the game's own live bullet positions (`Sensors::ReanchorMap`,
   `UDodgeSensors.cpp:380`) — nothing is extrapolated by our clock. Lanes carry
   `hitHalf` = the projectile's runtime Chebyshev half (`UDodgeSensors.cpp:348-350`), and
   zones are active/pending discs. This sensing layer is correct and is retained wholesale.

6. **Move budget (no new setting).** `UDodge::Tick` already computes
   `in.stepTiles = clamp(tilesPerSec × kServerTickSec, 0.4, 3.0)` (`UDodge.cpp:352-354`,
   `kServerTickSec = 0.2f` in `UDodgeTypes.h:153`). `tilesPerSec` comes from
   `TestTAB::ReadDodgePlayerStats` → `DodgeRuntime::GetTilesPerSec` (server-authoritative
   SPD curve, `MovementRuntime.cpp:153-186`). **This value IS the per-tick move budget** —
   reuse it; introduce no new knob.

---

## The divergence bug this plan must fix (safety correctness)

**The danger-map hit test omits the player half-extent.** The game's real hit test
(`FUN_18015be50`, documented in `dodge/DodgeHit.h:12-15`) is:

```
hit  iff  |dx| < effR  &&  |dy| < effR      where  effR = bulletHalf·hitScale + kPlayerHalf
```

with `kPlayerHalf = 0.2139f` (`DodgeHit.h:22`) folded into `effR`.

But `UDodge::Core::PointClear` / `PointClearance` (`UDodgeCore.cpp:413-449`) test
`LaneDistCheb(L, pos) <= hitHalf·hitScale` with **no `kPlayerHalf` term**, and lanes are
built with `lane.hitHalf = runtimeChebyshevHalf` (bullet radius only,
`UDodgeSensors.cpp:348`). Consequently a position UDodge calls "safe" can still be inside
the server's hit square by up to ~0.21 tiles. **This is almost certainly why the current
dodge "still lets the player get hit."**

**Intended behavior (correct one): include the player half-extent.** The solver's safety
test must use `effHalf = hitHalf·hitScale + kPlayerHalf` for lanes, and
`radius + kPlayerHalf` for active zones. Do **not** silently bake `kPlayerHalf` into
`lane.hitHalf` (that would change the debug overlay's bullet-square rendering and any other
reader of the raw geometry) — add server-accurate safety functions instead and keep
`lane.hitHalf` as the raw bullet half. Add a small baked **latency pad**
(`kULatencyPad = 0.10f`) on top so a chosen point isn't sitting exactly on the hit boundary
when a bullet the server sees one RTT ahead of our read arrives. Both constants are baked
(NO user settings).

---

## Target design

### New/changed files (all under `internal/src/features/movement/udodge/`)

#### A. Server-accurate safety primitives — extend `UDodgeCore` (reuse existing geometry)

`UDodgeCore.cpp` already owns `LaneDistCheb` (min Chebyshev distance from a point to a lane
polyline, `UDodgeCore.cpp:55-67`) and the zone math. Add two public functions beside the
existing `PointClear`/`PointClearance` so the geometry stays in one place:

In `UDodgeTypes.h` (constants block, near `kServerTickSec`):
```cpp
// Server-accurate hit geometry. The game's IsHit (FUN_18015be50) folds the
// player half-extent into effR; our DangerMap lane.hitHalf is the BULLET half
// only, so the safety test must add this. Value mirrors DodgeHit::kPlayerHalf.
constexpr float kUPlayerHalf = 0.2139f;
// Baked command-latency safety pad (tiles): keep the chosen point this far
// clear of the server hit boundary so a bullet seen one RTT ahead of our read
// can't clip it. NO user setting.
constexpr float kULatencyPad = 0.10f;
```

In `UDodgeCore.h` / `UDodgeCore.cpp`:
```cpp
// Server-accurate clearance (tiles) at `pos`: the minimum over every lane
// (Cheb − (hitHalf·hitScale + kUPlayerHalf)) and every ACTIVE zone
// (Euclid − (radius + kUPlayerHalf)). >0 ⇒ pos is OUTSIDE the server hit
// region of all shots; ≤0 ⇒ pos would be hit. Walls/hazard NOT considered
// (caller probes occupancy). Pending zones are cost-only, excluded here.
float PointSafety(const MapInput& in, Vec2 pos);

// Hard safety predicate used by the solver: occupancy-clear AND
// PointSafety(pos) >= pad. `pad` lets the solver require the latency margin.
bool PointSafe(const MapInput& in, Vec2 pos, float pad);
```
`PointSafety` is `PointClearance` with `+ kUPlayerHalf` added to each subtracted half
(lanes) and radius (zones). `PointSafe` = `in.env.canOccupy(pos, safeWalk)` &&
`PointSafety(pos) >= pad`. Keep the existing `PointClear`/`PointClearance` untouched (other
callers / overlay rely on them).

#### B. The solver — new `UDodgeSolver.{h,cpp}`

Pure data + math over the plain-data `DangerMap` and the `Env` probes already in
`MapInput`. No IL2CPP, no globals, no worker.

```cpp
// UDodgeSolver.h
#pragma once
#include "UDodgeTypes.h"
namespace UDodge { namespace Solver {

struct Goal {
    bool  active = false;   // a soft target exists (lock standoff or WASD intent)
    Vec2  pos{};            // world target we would like to progress toward
};

enum class SolveKind : uint8_t {
    Hold,        // player is already safe and nothing better is worth moving for
    Safe,        // moved to a provably-safe reachable cell
    Fallback,    // no safe reachable cell — moved to the least-bad (max-min-clr) cell
    Surrounded,  // no reachable cell improves clearance — hold in place
};

struct SolveResult {
    SolveKind kind = SolveKind::Hold;
    Vec2      target{};       // world position to drive toward this tick
    bool      shouldMove = false;
    float     clearance = 0.f; // server-accurate clearance at target
};

// Solve for the best reachable position this server tick.
//   moveBudgetTiles = per-tick reach = tilesPerSec × kServerTickSec (in.stepTiles).
//   goal            = soft preference (lock standoff / WASD); never overrides safety.
//   state.lastMoveDir is read (commitment term) and updated (chosen heading).
void Solve(const MapInput& in, float moveBudgetTiles, const Goal& goal,
           CoreState& state, SolveResult& out);

} } // namespace UDodge::Solver
```

**Reachable candidate set (tiny, ≤~1.9 tiles).** Sample the reachable disk as the stand
point plus polar rings:
```
candidates = { player }
           ∪ { player + r·(cosθ, sinθ) : r ∈ {b·0.34, b·0.67, b}, θ = 2π·k/K, k∈[0,K) }
           ∪ { the goal-direction point clamped to budget b }   // if goal.active
b = moveBudgetTiles ;  K = 24 angles  →  1 + 3·24 + 1 = 74 candidates
```
Rationale: `b ≤ ~1.9` tiles, so three rings at 0.5–2 tile spacing resolve any gap the
player can physically fit through; 24 headings ≈ 15° resolution. Cost per tick =
74 candidates × (1 `CanOccupy` + ~laneCount Cheb-segment evals). With `kMaxProjectiles=96`
that is ≤ ~7.1k segment-distance ops **at 5 Hz** — an order of magnitude cheaper than the
retired worker (49×49 Dijkstra + ~2.4k `CanOccupy` rasterize per tick, `UDodgePlanner.h:10`,
`UDodge.cpp:156-181`). Use `Cheb` reach (`std::max(|dx|,|dy|)`) to match the game's square
movement, or Euclidean — either is within budget; recommend Euclidean rings as written
(the ring radius already bounds Chebyshev reach ≤ b).

**Hard constraint (safety) — filter first:**
For each candidate `p`: reject if `!in.env.canOccupy(p, safeWalk)` (walls, and hazard when
`safeWalk`). Compute `clr = Core::PointSafety(in, p)`. If `clr >= kULatencyPad` → **safe
set**; else keep it for the fallback pool with its `clr`.

**Objective over the SAFE set (soft; baked weights; smart direction — per coordinator).**
Safety is already guaranteed for every point scored here, so these only *choose among* safe
points and can never trade safety away:
```
score(p) =  wCommit · max(0, dot(dirTo(p), state.lastMoveDir))     // continuity — kills jitter
          + wGoal   · goalProgress(p) · headroomRamp(clr)          // advance toward goal…
          + wPerp   · |perp(dirTo(p), flowDir)|                    // …RePP-style sidestep tiebreak
          - wMove   · moveDist(p) / max(b, 1e-3)                   // minimal disruption
          + wClear  · min(clr, kClearComfort)                      // gentle comfort tiebreak, capped
```
where
- `dirTo(p)` = unit(p − player); for the stand point (`moveDist ≈ 0`) `dot` term = 0.
- `goalProgress(p)` = `dist(player, goal.pos) − dist(p, goal.pos)` (tiles gained), 0 if
  `!goal.active`.
- `headroomRamp(clr)` = `clamp((clr − kULatencyPad) / kUScoreStyleBand, 0, 1)` — the goal
  pull fades to zero as the point approaches the safety floor, so near danger the dodge
  never sacrifices comfort to chase the orbit line (reuse `kUScoreStyleBand`,
  `UDodgeTypes.h:53`).
- `flowDir` = normalized sum of (player − lane.anchor) over relevant lanes (aggregate
  incoming-threat direction); `perp` is the component of `dirTo(p)` orthogonal to it.
- `moveDist(p)` = `Len(p − player)`.

Baked constants (add to `UDodgeTypes.h`, NO user sliders — mirror the existing
`kUScore*` family, `UDodgeTypes.h:47-53`):
```cpp
constexpr float kSolveCommitW  = 1.0f;   // directional continuity (anti-jitter)
constexpr float kSolveGoalW     = 0.8f;  // goal/WASD progress (fades near danger)
constexpr float kSolvePerpW      = 0.35f; // lateral sidestep tiebreak
constexpr float kSolveMoveW       = 1.2f; // minimal-disruption penalty (prefer nearest safe)
constexpr float kSolveClearW      = 0.25f;// gentle comfort tiebreak, capped
constexpr float kSolveClearComfort= 1.0f; // clearance (tiles) above which comfort stops rewarding
constexpr float kSolveStandBias   = 0.15f;// score the stand point gets so we don't twitch off a safe stand
```
Give the **stand point** an additive `kSolveStandBias` so that when standing still is safe
and no candidate is clearly better, the solver holds (minimal disruption) instead of
twitching. Pick `argmax(score)` over the safe set → `kind = Safe` (or `Hold` if the winner
is the stand point). Update `state.lastMoveDir = dirTo(target)` when a non-stand point wins.

**Fallback (safe set empty — surrounded).** Pick the reachable candidate with the greatest
`clr` (max-min-clearance, least-bad). If even the best reachable `clr` is not strictly
greater than `PointSafety(player)` (nowhere improves), `kind = Surrounded`, hold in place.
Otherwise `kind = Fallback`, move to it. This is the ONLY place clearance is maximized as a
primary objective — and only because no safe point exists.

**Honest guarantee.** "Numerically impossible to get hit" holds **only** for the `Safe`
case: a provably-safe point existed within the move budget and we placed the player there.
When the reachable disk is fully covered (`Fallback`/`Surrounded`), the player *can* be hit;
the solver then minimizes exposure but cannot guarantee zero hits. This bound is a physical
consequence of the per-tick move budget and must be documented as such (see the header
comment in `UDodgeSolver.h`).

#### C. Goal construction (soft preference only) — in `UDodge.cpp`

Compute `Solver::Goal` on the game thread from data UDodge already has, replacing the whole
worker/plan pipeline:
- If `steer.active` (WASD): `goal.pos = player + steerDir · b`, `active = true`.
- Else if `g_map.hasLock` (user Shift+Click-locked a live enemy, `UDodgeSensors.cpp:316`):
  resolve orbit standoff = `weaponRange × 0.85` where `weaponRange` =
  `AutoAim::GetProjRangeTiles()` if `AutoAim::IsProjRangeResolved()` else `6.f` (same
  source the retired planner used, `UDodge.cpp:300-302`); `goal.pos` = point on the
  ray from `g_map.lockPos` toward the player at that standoff distance; `active = true`.
  (`SetOrbitRange` override, `UDodge.cpp:490`, still feeds the standoff distance when non-zero.)
- Else `goal.active = false` (pure dodge — never wanders).

The goal is consumed ONLY through the objective's `wGoal` term over the safe set — it can
never move the player into a shot. This is the elegant resolution of the old
"path-follows-into-bullets" tension: the orbit/goal is just how we rank *safe* options.

#### D. `UDodge::Tick` rewrite (the insertion point)

Replace the block from the intent-priority ladder through the auto-walk/MoveTo section
(`UDodge.cpp:266-410`) with:

1. Build/re-anchor the map exactly as today (`UDodge.cpp:249-264`, KEEP).
2. Build `Solver::Goal` (section C).
3. **Solve once per server tick.** On a tick boundary (`rebuilt == true`, i.e. the tick id
   changed or a structural projectile change forced a rebuild) call `Solver::Solve(in, b,
   goal, g_state, g_solve)` where `b = in.stepTiles`. Cache the result in a game-thread
   static (`g_solveTarget`, `g_solveKind`).
4. **Every frame** (tick boundary or not): if `g_solve.shouldMove`, re-validate the cached
   target against the *re-anchored* map with one `Core::PointSafe(in, g_solveTarget,
   kULatencyPad)`. If it is still safe (or we are in `Fallback`), drive toward it:
   ```
   Vec2 to = Sub(g_solveTarget, in.player);
   float d = Len(to);
   Vec2 dir = d > 1e-4f ? Mul(to, 1.f/d) : Vec2{};
   // per-frame step, clamped to the player's speed; MoveTo clamps again internally.
   Vec2 moveTarget = Add(in.player, Mul(dir, std::min(d, in.speed * frameMs)));
   DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y);
   ```
   If the cached target became unsafe mid-tick (a new shot re-anchored onto it) **and this
   frame did not rebuild**, force a same-frame re-solve (`Sensors::BuildMap` + `Solver::Solve`)
   so a mid-tick spawn is dodged immediately — this preserves today's "structural change
   forces immediate rebuild" reflex (`UDodge.cpp:255-259`) without any worker.
5. Keep the debug snapshot publish (`UDodge.cpp:412-450`) but populate it from `SolveResult`
   (decision → map a `SolveKind`, target, clearance, threat counts). Drop the `path[]` /
   worker-plan fields (no route any more) — leave the arrays zeroed.

`in.speed` is already tiles/ms (`UDodge.cpp:351`). `frameMs = clamp(dt·1000, 1, 250)`
(`UDodge.cpp:365`, KEEP). This keeps the per-frame drive identical in spirit to today, only
the *target* changes from a scored candidate/worker route to the solved safe point.

### Ownership / threading / caching
- **Game-update thread only.** The solver runs where `UDodge::Tick` runs (the
  `AppEngineManager::Update` detour). No worker, no cross-thread snapshot, no mutex on the
  hot path (the existing debug mutex for the render overlay is retained).
- **Cache lifetime = one server tick.** `g_solveTarget` is recomputed on every rebuild and
  on any mid-tick invalidation; between ticks it is held and merely re-validated + walked.
- **Sensors stay on the game thread** (`CanOccupy`/`IsHazardAt` touch live memory) — the
  solver calls them only through the `MapInput::env` function pointers, exactly as
  `Core::Evaluate` does today, so it remains host-independent and unit-testable.

### Hot-path notes
- Solve is **per tick (5 Hz)**, not per frame. Per-frame work is one `PointSafe`
  (≤96 Cheb evals) + one `CallMoveTo`. This is the FPS fix: the retired worker rasterized
  ~2.4k `CanOccupy` probes and ran a 49×49 Dijkstra **every publish**, plus the game thread
  scored 35 candidates with multi-probe segments every frame.
- Keep buffers fixed-size (no per-tick heap): candidates on the stack (74 `Vec2` + scores).

---

## Steps

Each step compiles and behaves correctly on its own. Build after every step with
`bash internal/tools/wsl-build.sh Debug` (expect 0 warnings / 0 errors) and
`bash internal/tools/check-raw-access.sh` (expect exit 0).

1. **Add baked constants + server-accurate safety primitives.** In `UDodgeTypes.h` add
   `kUPlayerHalf`, `kULatencyPad`, and the `kSolve*` weight block. In `UDodgeCore.h`/`.cpp`
   add `PointSafety` and `PointSafe` (reusing `LaneDistCheb` and the zone math, folding
   `+ kUPlayerHalf` into every lane half and active-zone radius). Do NOT modify the existing
   `PointClear`/`PointClearance`/`lane.hitHalf`. Build.

2. **Create `UDodgeSolver.{h,cpp}`** with the `Solve` API from section B, but with the
   objective stubbed to *safety-only* first: filter the candidate set, pick the safe point
   nearest the player (minimal-move), fallback = max-min-clearance. This gives a working
   provably-safe dodge before the smart-direction terms are added. Add the file to the
   VS project (`il2cpp-dll-injection.vcxproj` + filters) the same way the other `udodge/`
   files are listed. Build (not yet wired — no behavior change).

3. **Wire the solver into `UDodge::Tick`** (section D): build `Solver::Goal` with
   `goal.active = false` for now (pure dodge), solve on rebuild, cache, per-frame
   re-validate + `CallMoveTo` toward the cached target. Remove the `Core::Evaluate` call,
   the worker publish/consume block (`UDodge.cpp:281-340`), the auto-walk block
   (`UDodge.cpp:382-410`), and the `FillOccGrid`/`LanternIntent`/plan-freshness locals.
   Publish the debug snapshot from `SolveResult`. Build. **Manual test:** enable UDodge
   (DodgeMode::UDodge) in a realm — the player should hold in safe cells and step to safety
   within the move budget with no rubber-band.

4. **Add the smart-direction objective** to `Solver::Solve` (commitment, goal-progress with
   `headroomRamp`, perpendicular sidestep, minimal-move, capped comfort, stand bias). At
   this step `goal` is still inactive, so only commitment/minimal-move/sidestep/comfort are
   exercised — verify the dodge is smooth (no side-to-side flip) and does not wander. Build.

5. **Reinstate the goal as a soft preference** (section C): populate `Solver::Goal` from
   WASD steer and from `g_map.hasLock` orbit standoff (`weaponRange × 0.85`, honoring the
   `SetOrbitRange` override). Confirm: with a locked boss the player orbits at standoff
   **only through safe points**, and the instant a bullet threatens, safety wins (the goal
   term fades via `headroomRamp`). Build + manual test with a boss lock.

6. **Retire the worker + planner (dead-code removal, FPS win).** Delete the
   `Worker::Start/Stop/PublishSnapshot/TryGetLatestPlan` calls and the `g_lastPlan` /
   `g_lastPubSeq` state from `UDodge.cpp`; delete `UDodgeWorker.{h,cpp}` and
   `UDodgePlanner.{h,cpp}` and their project entries; delete the field-escape
   `UDodgeField.{h,cpp}` and the `kField*`/`Decision::FieldEscape` usage now that the
   fallback subsumes "boxed in". Remove `ProjectileTracking::Install`+`Worker::Start` from
   `SetEnabled`/`OnEnter` (keep `ProjectileTracking::Install` — sensors need it). Build +
   `check-raw-access.sh`. **This is the step that recovers the FPS.**

7. **Prune `UDodgeCore` to the primitives the solver uses.** The 35-candidate machinery
   (`ScoreOf`, `BuildProbes`, `Evaluate`, the compass-direction/intent/field candidate
   layout, `kUScore*` selection weights, tick-locked hysteresis) is no longer called. Either
   delete `Core::Evaluate` and its private helpers, or `#if 0` them out in one commit; keep
   `LaneDistCheb`, `PointClear`, `PointClearance`, `PointSafety`, `PointSafe`. Update
   `UDodgeTypes.h` to drop now-unused candidate constants only if nothing else references
   them (grep first). Build + `check-raw-access.sh`.

8. **Trim settings + debug to what remains.** In `RenderSettings`/`ReadSettings`
   (`UDodge.cpp:78-97,453-511`) remove controls that no longer drive anything (step distance,
   plan-window radius, draw-path, lock-follow legacy external goal, field-escape toggle).
   Keep: hit scale, safe-walk, orbit range, debug overlay, the lantern stand-on opt-in.
   **Add NO new settings.** Simplify the overlay (`UDodgeDebug.cpp`) to draw the danger map,
   the reachable ring, the chosen safe target, and the SolveKind label. Build.

9. **Final verification pass** (see below). Build Debug (0/0), run the raw-access guardrail,
   and run the completion greps. Commit on `refactor/unified-gameapi`.

---

## Verification
- Build: `bash internal/tools/wsl-build.sh Debug` → **0 warnings, 0 errors**.
- Guardrail: `bash internal/tools/check-raw-access.sh` → **exit 0** (the solver adds no raw
  memory access; it only calls the sanctioned `Sensors::`/`DodgeRuntime::` seams and pure
  math).
- Completion greps (must return **zero** results when the migration is done):
  - `command grep -rn "UDodgeWorker\|UDodge::Worker\|PublishSnapshot\|TryGetLatestPlan" internal/src/features/movement/udodge/` → empty (worker retired).
  - `command grep -rn "Planner::Compute\|OccGrid\|FillOccGrid\|g_lastPlan\|g_lastPubSeq" internal/src/features/movement/udodge/` → empty (whole-map planner retired).
  - `command grep -rn "Core::Evaluate\|ScoreOf" internal/src/features/movement/udodge/` → empty (35-candidate scoring retired).
  - `command grep -rn "kUPlayerHalf" internal/src/features/movement/udodge/UDodgeSolver.cpp` → **non-empty** (safety test folds in the player half-extent — proves the divergence fix is live).
- Manual (live Exalt, `refactor/unified-gameapi`): enable UDodge in a bullet-dense boss room.
  Expect: no speedhack rubber-band (every move within budget via `MoveTo`); the player parks
  in safe gaps and steps to safety within ~one tick; with a boss lock it orbits at standoff
  but breaks orbit to dodge; FPS is materially higher than the reactive build (the temp
  `TickTimer` in `UDodge.cpp:219-232` should report a much lower avg — remove it once
  confirmed).

## Out of scope
- **Do not touch** `repp/`, `pjdodge/`, `zdodge/`, `xdodge/`, `RolloutDodge`, or their GUI
  cleanup-wave files — this plan is UDodge-only.
- **Do not modify** `dodge/DangerPlanner.cpp` beyond leaving the `UDodge::Tick(p,px,py,dt)`
  dispatch line intact (`DangerPlanner.cpp:775`); the AStar/DangerPlanner engine is a
  separate mode.
- **Do not change** `MovementRuntime.cpp` / `CallMoveTo` / the `MoveTo` resolution — it is
  the correct insertion point as-is; only *call* it.
- **Do not introduce the raw position write** (`PosX`/`PosY`/`KJ_Float3Pos`) — it flags
  speedhack for continuous use.
- **Do not add any user setting.** All solver tuning is baked constants in `UDodgeTypes.h`.
- **Do not** re-bake `kUPlayerHalf` into `lane.hitHalf` in the sensors (keep the raw bullet
  half for the overlay); the player half-extent belongs only in the safety test.
- Any *additional* real bug found in `Sensors`/`ProjectileTracking` (e.g. a lane trace
  anomaly) is a separate plan — do not fold behavior changes into this refactor beyond the
  documented `kUPlayerHalf` safety fix.
