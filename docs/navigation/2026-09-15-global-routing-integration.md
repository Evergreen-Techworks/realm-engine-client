# Persistent point routing integration — 2026-09-15

## Scope and integration order

Local branch `investigate/persistent-map-corners`, following `5c69428` (red remote-room regressions), `8d49213` (persistent memory), and `fba071f` (incremental global router). This slice integrates the router with the production unified movement owner, not merely a standalone planner. It requires the independent native/client status bridge `4e7ae770760f8dc32217e224839d80db012528df`; dashboard activation is `02388ab0c1ef6d103c068a31205795df3629be82`. Apply all pieces before native linking. No Windows source, build, push, or deployment is included.

This is experimental **point travel**, defaulting to `navNavigator=legacy`. D* supplies static global topology/corridors over the received map, without viewport/distance truncation. It is not Stage 3 whole-connected-boss-arena combat/ring repositioning or time-aware projectile planning. Existing shot/zone solver and collision/speed checks remain final movement authorities.

## Production path

- `navMapInfo` and `playerColliderSceneReset` create monotonic instance epochs even for equal dimensions/names. Atomic `scriptNavigationGoal` carries a JS-safe request ID and coordinates; malformed/overflowing input is refused. Native correlation distinguishes map epoch, goal identity and request revision.
- The game thread incrementally reads the received tile list without the old 65,536-entry cap or local-distance filter. Ground and static square occupants remain separate. Failed reads retry boundedly without starving subsequent entries or inventing empty terrain. Mutable nearby occupants are rechecked in bounded batches.
- The dedicated worker receives only detached plain data. It runs at 100 ms, applies bounded changed batches, updates D* Lite and returns epoch/request-stamped, locally unverified corridors. Game-thread result consumption is nonblocking and rejects stale epochs, goals and results older than 300 ms.
- A complete local raw-goal route retains priority: it already handles speed and enemy keep-outs. Global assistance begins after a matching local result is absent or partial. The local pathfinder marks clamped goals partial (`!goalInWindow`); reaching a window edge is not completion of a distant goal. Global points still go through the same local worker, swept follower, temporal solver and live collision veto.
- While global repair is pending, existing safe local planning continues. Unknown/frontier or map-pending results never authorize crossing unknown live squares. Off-center starts first obtain a safe cell-center anchor to avoid repeatedly publishing an unusable corner turn.
- Arrival/cancellation survives the native owner clearing `walkActive` before runtime update, including legacy mode without enabling global capture/routing. Scene reset invalidates the exact script ID even before its first update. Duplicate navigator setting is idempotent. Status deduplication includes epoch and reason.
- Ten-second no-progress detection only accrues with a usable published corridor, not during initial capture, unknown frontier, repair or paralysis. This slice does not implement the spec's full transient-overlay/three-stuck-events policy.

## Freshness ruling and limitations

The controller accepted the existing binding ruling 1 distinction: router optimism is not live execution permission. Known ground with structurally unknown occupancy can contribute to an advisory global route, with `requiresLocalVerification=true`; it is never converted into `ConfirmedEmpty`. Unknown ground has the specified 1.2 cost, but the executable corridor stops at a known-ground frontier. Live `0xFF` remains refused.

Pinned binary evidence shows the static square-cover null setter is shared by object movement and teardown, without a removal reason. Thus null, entity drops and proximity do not prove destruction. The adapter retains a previously observed blocker until a positive replacement observation; an opened/destructed door leaving null can conservatively stall. No new offsets or guessed authority were introduced.

After an epoch changes, the old world/list is refused until world/list replacement or a list shrink proves replacement activity. **If the game reuses both pointers and keeps an equal/larger count without an observed shrink, capture remains `map_pending`.** No trustworthy readiness discriminator was found, and `UDodge::OnEnter` is a mode-enter hook, not proof of a new scene. This fail-closed limitation is not claimed fixed.

Current ENEMYSHOOT handling describes packets received by this client. Missing owner/type data cannot recover projectile speed/lifetime; nothing in this integration establishes omniscience about unseen enemy shots.

## Regression evidence

Test-first failures included the four preexisting 120-second remote-room arrivals, unreadable-square capture starvation, goal/epoch lifecycle transitions, and experimental-mode regressions in learned keep-out and mixed-water speed routing. No assertions or existing safety floors were weakened. The local-raw-goal handoff fixes the latter two rather than exempting them.

- `python3 internal/tests/run_udodge_zone_tests.py`: focused router 350, memory 57, native runtime 19 checks, plus the existing collision/speed/solver suites and legacy-default scenario assertions.
- `python3 internal/tests/scenario/run_scenarios.py --navigator dstar --rule both --check`: normal scenarios preserve 43 asserted / 4 existing known limitations under legacy collision and 45 / 2 under game collision.
- `python3 internal/tests/scenario/run_scenarios.py --navigator dstar --rule both --stage2-regressions --check`: the two remote-room directions under both collision rules exercise the real production UDodge tick, local pathfinder, solver and collision path with production Router.
- The scenario runtime adapter deliberately schedules fixed 2,048-expansion repairs every simulated 100 ms. This makes simulated elapsed/path comparisons repeatable and is **not** a real-thread latency measurement. Native `Runtime.cpp` is separately compiled with the host memory-layout shim and actual worker thread.
- Large native runtime fixture: 174,724 received squares, distant goal, JS maximum-safe request ID, capture/worker lifecycle. Changed-vertex deduplication reduced an observed complete worker cycle maximum from 8.298 ms to 4.153 ms in a focused run. Final full sweep measured max 3.749 ms, p95 cycle 2.975 ms / repair 1.890 ms; the final 19-check focused rerun measured max 3.948 ms, p95 cycle 3.002 ms / repair 1.889 ms. Timing covers Apply, speed updates, repair and corridor construction, not just Repair.
- Router node cap produces a reachable advancing partial corridor; repeated door repair checks bound lazy heap growth. Stale-heap removal is capped at 256 entries per drain before yielding repair. Heap compaction/reset remain bounded by the node cap but are not a proof of a hard wall-clock maximum on every machine.

Remote deterministic results, reproduced after housekeeping optimization: legacy forward 103.42 s / 516.8 tiles, reverse 99.37 s / 501.4 tiles; game forward 103.18 s / 515.2 tiles, reverse 100.37 s / 500.4 tiles. All four have zero hits, collision refusals, overspeed and stuck time. The old local-only implementation failed all four at 120 s after roughly 719 tiles. These are not claimed fast: a relaxed mandatory-portal geometric lower bound is 497.50 tiles / 82.92 s at 6 tiles/s. Planning/following and corridor discretization explain remaining overhead; synthetic fixed repair scheduling is not an in-game frame-rate measurement.

The standalone `run_nav_global_route_reproducer.py` intentionally invokes the old local `Path::Compute` directly and still demonstrates its local-only limitation; it does not execute the new production global handoff. Combined client/native bridge checks and MSVC verification belong to the private integration worktree before any owner-approved build.
