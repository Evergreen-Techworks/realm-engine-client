# 59 — Stage C2: Move the Planner to a Background Worker Thread (FPS-decoupled)

## Goal
After this plan, `Planner::Compute` runs on a dedicated background worker thread
instead of inline in `UDodge::Tick`. The game-update thread publishes a plain-data
`PlannerSnapshot` (lock-free / non-blocking) and reads the worker's latest
`PlanResult` to use as the autopilot intent. Planning cadence is decoupled from
render/update frame rate; the game thread never blocks on the planner. The
per-frame dodge (`Core::Evaluate`) stays on the game thread, so bullet-reaction
latency is unchanged. Behavior is otherwise identical to Stage C1.

## Dependencies
Plan 58 merged (creates `PlannerSnapshot`/`PlanResult`/`Planner::Compute`).
Touches `internal/src/features/movement/udodge/UDodge.cpp`, `UDodgePlanner.{h,cpp}`,
and adds `UDodgeWorker.{h,cpp}`. Plans 60-61 build on the worker.

## Current state (after 58)

`UDodge::Tick` (game-update thread) builds a `PlannerSnapshot`, calls
`Planner::Compute` synchronously, and feeds `result.firstDir` to `Core::Evaluate`.
The worker lifecycle does not exist yet. The overlay already uses a proven
mutex-guarded publish pattern for `DebugSnapshot` (`UDodge.cpp:86-90`,
`g_debugMutex`; render-thread read at `:375-377`) — the worker handoff mirrors it.

## Target design

### Thread-boundary contract (mandatory — see plan 55)
Only `UDodge::Tick` (game thread) touches IL2CPP. The worker touches ONLY the
copied plain-data `PlannerSnapshot` and writes a plain-data `PlanResult`. Nothing
that crosses carries a `void*`/IL2CPP handle (verified: `PlannerSnapshot` and
`PlanResult` are pure per plan 58; `Env` function pointers are NOT in the
snapshot).

### Handoff (mutex + non-blocking game thread — mirrors `g_debugMutex`)
New file `internal/src/features/movement/udodge/UDodgeWorker.{h,cpp}`, namespace
`UDodge::Worker`:
```cpp
namespace UDodge { namespace Worker {
    void Start();                                  // idempotent; spawns the thread
    void Stop();                                   // joins the thread; idempotent
    void PublishSnapshot(const Planner::PlannerSnapshot& snap);  // game thread, non-blocking
    bool TryGetLatestPlan(Planner::PlanResult& out);            // game thread, non-blocking
} }
```
Implementation:
- Two `std::mutex` + one `std::condition_variable`. `g_snapMutex` guards a single
  `PlannerSnapshot g_pendingSnap` + `bool g_haveSnap`. `g_planMutex` guards
  `PlanResult g_latestPlan` + `bool g_havePlan`.
- `PublishSnapshot`: `std::unique_lock lk(g_snapMutex, std::try_to_lock);` — if
  not acquired, RETURN immediately (drop this frame's publish; the worker keeps
  the previous snapshot — never block the game thread). If acquired, move-assign
  `g_pendingSnap`, set `g_haveSnap`, `notify_one` the CV.
- Worker loop: `wait` on the CV for `g_haveSnap || g_stop`; on wake, copy
  `g_pendingSnap` out under `g_snapMutex`, clear `g_haveSnap`, release the lock,
  run `Planner::Compute` on the LOCAL copy (no lock held during compute), then
  publish into `g_latestPlan` under `g_planMutex`.
- `TryGetLatestPlan`: `std::unique_lock lk(g_planMutex, std::try_to_lock);` — if
  not acquired, return false (game thread keeps its own last-known plan). If
  acquired and `g_havePlan`, copy out and return true.
- The game thread thus NEVER blocks; the worker may block only on its own CV wait
  and brief lock hold during memcpy-out. This is the exact safety profile of the
  existing render-overlay publish.

### Lifecycle
- `Worker::Start()` from `UDodge::OnEnter` and `SetEnabled(true)`
  (`UDodge.cpp:164-181`). `Worker::Stop()` from `SetEnabled(false)` and from the
  feature teardown path. Guard against double-start with an atomic. The worker
  thread must be JOINED before DLL unload — hook `Stop()` into the same place
  `SetEnabled(false)` is called and ensure it is reached on disable. (The worker
  holds no IL2CPP state, so a late join is safe.)

### Tick rewiring
`UDodge::Tick` autopilot branch (from plan 58): build the `PlannerSnapshot`,
`Worker::PublishSnapshot(snap)`, then `Worker::TryGetLatestPlan(plan)`; if a plan
is available and `plan.hasGoal`, use `plan.firstDir` as `in.intentDir`
(and `apHasTarget/apTarget` from `plan.hasGoal/goalPos`). If no plan yet (worker
cold on the first frames), `in.intentDir = {}` — pure dodge until the first plan
lands (safe, transient). Keep the lantern stand-on path inline and game-thread as
in plan 58 (it pre-empts the worker plan, unchanged priority).

**Staleness is acceptable:** the plan is a GOAL intent, always overridable by the
dodge; a plan one or two frames old only shifts the orbit heading imperceptibly.
The dodge safety layer (Core::Evaluate, game thread, every frame) is NOT stale.

## Steps

1. **Add `UDodgeWorker.{h,cpp}`** implementing the handoff + lifecycle above.
   Include `<thread>`, `<mutex>`, `<condition_variable>`, `<atomic>`. Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

2. **Start/stop the worker** from `UDodge::OnEnter`, `SetEnabled(true/false)`
   (`UDodge.cpp:164-181`). Verify the join happens on disable. Build + guardrail.

3. **Rewire `Tick`** to publish the snapshot and consume the latest plan instead
   of calling `Planner::Compute` inline (remove the inline call added in 58).
   Build + guardrail.

4. **In-game verify** (see Verification) — autopilot orbit still works and is now
   fed by the worker; toggling UDodge off/on cleanly starts/stops the worker with
   no crash or hang; framerate is smooth. Keep `DBG_FILE_LOG` diagnostics; add one
   throttled worker heartbeat log (`[UDodge] Worker plan seq=... hasGoal=...`) so
   the handoff is observable in dll-trace (plan 62 removes it).

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

In-game:
- Autopilot orbit behaves as in Stage C1 (worker now drives the goal intent).
- Enable → disable → enable UDodge repeatedly: no crash, no hang on disable
  (worker joins), no stale-thread. dll-trace shows the worker heartbeat while
  enabled and stops on disable.
- No IL2CPP crash under load (proves nothing IL2CPP crosses the boundary).

## Out of scope
- Do NOT add whole-map pathfinding or the occupancy grid yet (plan 60) — the
  worker payload stays the cheap orbit computation this stage.
- Do NOT move `Core::Evaluate` (the dodge) off the game thread — it stays there
  for latency, by design.
- Do NOT introduce any raw position write.
