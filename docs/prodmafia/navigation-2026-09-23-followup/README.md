# Safer buffered travel and movement cost — 2026-09-23

Production change: `d136fd06e8050619ad324c6ee62f92e3ff79f6c8` on `feat/predictive-nexus-testlab`.
Baseline: `510554a3cad8dc818dad38cb6278e81d77b1073a`, the native source installed in private 1.0.41.

## Result and scope

The final shared-harness A/B ran 316 cases per revision and found no regression under its gates. Passing cases increased from 281 to 282; total projectile hits decreased from 7 to 6. The one changed gameplay case was `p_walk_pack_late_crossfire`, legacy collision, fixture profile:

| Metric | Before | After |
|---|---:|---:|
| Hits | 1 | 0 |
| Arrival | 8.62 s | 5.70 s |
| Path length | 49.0 tiles | 33.9 tiles |
| Paused travel frames | 26 | 4 |
| Heading reversals/sec | 0.12 | 0.00 |

This safety improvement requires **enemy-buffered navigation** (`udodgeEnemyStandoff=auto`; harness `HARNESS_ENEMY_STANDOFF=on`). The shipped profile has that option disabled: its gameplay measurements remain identical to baseline. No settings default changed. The redundant-scoring optimization applies to safe commanded travel in both profiles.

The preceding corridor improvement is retained: all 72 speed/start variants still pass, all eight remote-route cases pass, and boss engagement measurements are unchanged. There are still 34 failing cases across profiles, including dense-boss engagement limitations and unbuffered enemy-pack travel. This is a measured, limited improvement, not evidence that all dodging is solved.

## Implementation

A safe commanded route step now returns before generating and scoring its alternate polar dodge candidates. It still passes occupancy, swept terrain, swept enemy, active-zone and temporal checks. No safety floor was removed. A query-count regression ensures this path avoids the full alternate-heading search independently of host timing.

Emergency travel previously ranked time-to-danger over a fixed 200 ms even when the commanded move consumed that interval before its destination hold. Buffered travel now uses one common window covering the full move budget plus the 200 ms dwell, capped by the prediction horizon. It reuses each candidate's full temporal query from reflex admission instead of recalculating it. Candidates rejected before temporal admission are queried when needed. This remains an explicitly exposed fallback, not a claim of collision-free admission.

Combat and unbuffered movement preserve their earlier fallback ranking. Broader experiments were rejected: using the full horizon everywhere reduced boss engagement and added hits; scoping only to travel still caused a previously arriving unbuffered game-collision case to time out with two hits. Their summaries are retained as `rejected-*.json`. The final gate additionally rejects lost boss engagement fraction, beyond the prior hit, arrival, collision, stuck-time and speed checks.

## Validation

- `python3 internal/tests/scenario/benchmark_navigation.py --baseline-internal /home/jesse/rec-worktrees/navigation-benchmark-20260924/internal --output /tmp/nav-next-buffered-final`: exit 0, 316 matched cases, 281→282 passes, 7→6 hits, no regressions. Both binaries use the exact same unchanged harness. The recorded production-diff hash matches `git diff 510554a d136fd0 -- internal/src`.
- `python3 internal/tests/run_udodge_zone_tests.py`: exit 0 on the final source. Includes the new travel-prediction assertion and all native safety, temporal, navigation, worker, telemetry and input-focus checks. The optional-sidestep timing assertion that failed in 1.0.41 now passes without changing its threshold.
- New travel-prediction check against baseline: fails with one hit and 8.62 s. Final source: passes both collision rules with zero hits, no refused/overspeed moves and arrival within 6 s. Enemy buffers on; optional fallback sidestep off.
- New safe-travel occupancy-query guard against baseline: fails. Candidate: passes, alongside the existing navigation/ring-route checks. See `travel-cost-red-green.log`.
- `git diff --check`: passes.
- `bash internal/tools/check-raw-access.sh`: exits 1 identically in both revisions, reporting existing `EnemyTracker.cpp` and `CosmeticOverrides.cpp` findings. Normalized outputs match; those files were not changed.

Performance is measured separately from the parallel gameplay A/B, using serial pinned-CPU runs with warmups and alternating revision order. Timing evidence is recorded below; private delivery is verified below. No live game/account session was started, so these results do not establish live renderer FPS or survival against an actual boss.

## Native frame-cost comparison

Command: `python3 internal/tests/scenario/benchmark_frame_cost.py --baseline /tmp/nav-next-buffered-final/baseline-harness --candidate /tmp/nav-next-buffered-final/candidate-harness --repeats 5 --output /tmp/nav-buffered-frame-cost` — exit 0.

Shipped profile; seven scenarios × two collision rules × two revisions × five measured repeats = 140 runs, plus 28 warmups. Serial execution pinned to CPU 0, alternating revision order, no concurrent local build/test job. Values below are medians of each run's average/p95, in milliseconds. The harness executes the worker inline: these are **native simulation costs, not actual renderer frame times or FPS**. All gameplay measurements remain identical across revisions and repetitions. The timing gate flags an average or p95 increase exceeding both 10% and 0.05 ms; none occurred. Small sub-millisecond differences should not be overstated as live-game improvement.

| Scenario | Rule | Average before | Average after | p95 before | p95 after |
|---|---|---:|---:|---:|---:|
| c_u_wall | legacy | 0.041 | 0.033 | 0.141 | 0.125 |
| c_u_wall | game | 0.031 | 0.025 | 0.152 | 0.127 |
| n_rooms1_fullocc_forward | legacy | 0.096 | 0.086 | 0.252 | 0.242 |
| n_rooms1_fullocc_forward | game | 0.055 | 0.046 | 0.194 | 0.145 |
| d_boss_open_rings | legacy | 0.028 | 0.027 | 0.186 | 0.184 |
| d_boss_open_rings | game | 0.032 | 0.032 | 0.225 | 0.226 |
| d_boss_open_dense | legacy | 0.492 | 0.469 | 2.373 | 2.329 |
| d_boss_open_dense | game | 0.553 | 0.518 | 2.650 | 2.341 |
| d_boss_wall_dense | legacy | 0.521 | 0.504 | 2.354 | 2.225 |
| d_boss_wall_dense | game | 0.559 | 0.536 | 2.714 | 2.633 |
| p_walk_pack_late_crossfire | legacy | 0.672 | 0.675 | 1.344 | 1.333 |
| p_walk_pack_late_crossfire | game | 0.695 | 0.692 | 1.066 | 1.039 |
| f_lava_pressure | legacy | 0.036 | 0.029 | 0.132 | 0.088 |
| f_lava_pressure | game | 0.043 | 0.035 | 0.148 | 0.108 |

## Private delivery

Private **1.0.42** from `d136fd0` is verified and installed at `C:\realm-engine-testlab\rig\Realm Engine 1.0.42 Private (RotMG 86ad651b).exe`.

SHA256: `a7fb8c6dbdc0b8ff06ba5b8dc0791f2cc15949a156f542f2296ddbdf9dc34fb9`.

The drift-checked build mirrored only `UDodgeSolver.cpp`; its Windows source and isolated build snapshot hashes match the tested commit. Build status is private/non-publishable, `publish=false`; private TestLab features included, diagnostics off, bindings 143 fields / 41 methods / 17 omitted / 133 offsets proven. Antivirus detections remained 7→7. Installed executable hash independently matches the cache receipt, and the rig contains exactly one executable. The live GameAssembly/metadata hashes still match the pinned game. The normal owner portable was not replaced; no live launch, new character, push or deployment was performed.

The full evidence is also available under `C:\realm-engine-testlab\comparisons\20260923-navigation-followup`.
