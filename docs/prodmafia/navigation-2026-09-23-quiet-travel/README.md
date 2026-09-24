# Quiet travel continuation — 2026-09-23

Source: `a52ea768bb8710fa3804f587b4bffa38f5f06204`, branch `feat/predictive-nexus-testlab`.
Baseline: `b815a88`, whose production code is the installed private 1.0.42 (`d136fd0`).

## Measured outcome

The final shared-harness A/B ran **316 cases per revision**, with **no regression under its safety, arrival and engagement gates**. Both revisions pass 282/316 historical scenario assertions and incur six total hits. The new quiet-route acceptance gate improves from **4/8 to 8/8**: every remote route, both collision rules, both profiles, now pauses for at most one second.

Representative results with **game collision** and the **shipped feature switches** (route commitment, enemy buffers, optional sidestep and frame budget off):

| Scenario | Before | After | Paused frames before → after |
|---|---:|---:|---:|
| Remote rooms forward | 103.52 s | 86.58 s | 1063 → 36 |
| Remote rooms reverse | 100.37 s | 83.97 s | 978 → 40 |
| Hidden-blocker detour | 5.25 s | 4.80 s | 56 → 37 |

The long routes have zero hits, refused moves, overspeed or stuck time in both revisions. Their improvement is about 16% less arrival time and 96% fewer paused frames, not a substantially shorter geometric path. Forward path length changes 514.8→516.7 tiles; reverse stays 500.5. Hidden-blocker travel shortens 22.9→22.4 tiles. With fixture switches, reverse is 101.37→83.97 s and 1038→40 paused frames; forward matches the shipped-switch figures.

Legacy-collision gameplay and boss results remain unchanged. No settings default changed; the largest demonstrated improvement is in game collision mode. The previous buffered-crossfire and narrow-corridor gains are retained. The 34 historical failures, including dense-boss engagement limitations and unbuffered enemy-pack travel, remain unresolved.

## What changed

- A consumed safe step may request an immediate live safety solve during **quiet game-rule travel**, instead of waiting for the next server update. Eligibility requires a complete available danger map, no tracked enemy/projectile/damage zone or boss lock, and terrain clearance along the next corridor segment. The ordinary solver still validates the actual move; this does not authorize a stale command or bypass collision/projectile checks. Existing legacy continuation is unchanged.
- The extra clearance uses the existing 0.15-tile navigation wall margin at four swept offsets. It is evaluated only after a safe target is consumed. It does not change the game's collision footprint or limit emergency dodge candidates.
- A completed point route now refreshes when its current goal is still outside the real arrival tolerance. Previously the three-tile goal-change threshold also suppressed finishing a small destination update: the reverse scenario stopped at (102.5,100.5), roughly two tiles short, until the stall timer expired. Locked approaches retain their previous tolerance.
- A safe commanded travel step no longer computes an unused standing-still horizon forecast before returning. If it needs a dodge, the forecast is still computed before holding or choosing an alternative.

## Rejected experiments and regression coverage

Broad game-rule continuation changed exposure to a shooter pack and added hits. Quiet-only continuation without sufficient terrain gating added refused moves around trees/U-walls. Exact coordinate equality then left the player stopped roughly 0.00001 tile short on open ground; see `rejected-exact-completion-trace.txt`. Checking only current-position clearance still missed a U-wall transition. None of those versions was built for delivery. Their summaries are retained as `rejected-*.json`.

The final version keeps the existing consumed-step tolerance on ordinary clear ground, retains exact narrow-corner handling, sweeps the clearance along the upcoming segment, and fixes the separate short-destination stall. The one-second remote pause limit was not relaxed to admit an intermediate result.

## Validation

- `python3 internal/tests/scenario/benchmark_navigation.py --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1042/internal --output /tmp/nav-1043-swept-final`: **exit 0**, 316 pairs, no regressions. The recorded production-diff hash matches `git diff b815a88 a52ea76 -- internal/src`. Both revisions use the same unchanged harness.
- `remote_travel_acceptance` over the recorded paired rows: baseline fails all four game-rule rows; candidate passes all eight rows. See `remote-acceptance.json`.
- `python3 internal/tests/run_udodge_zone_tests.py`: **exit 0** on the final production source, including navigation, temporal admission, worker, collision, speed, scenario, telemetry, prior buffered-crossfire and input-focus checks.
- Targeted mutation checks: control passes; restoring old game-rule cadence fails quiet-travel eligibility; removing the enemy gate fails combat-cadence protection; removing clearance fails the nearby-terrain check. Tests also cover missing/truncated data, projectiles, zones, boss locks, swept endpoint clearance and the observed floating-point remainder.
- `git diff --check`: passes.
- Raw-access checker: exits 1 with the same existing `EnemyTracker.cpp` / `CosmeticOverrides.cpp` findings as baseline. Normalized outputs match; no new raw access was introduced.

## Frame-cost evidence

The broad timing run used serial execution pinned to CPU 0, warmups, alternating revision order and five measured repetitions of seven scenarios under both collision rules: 140 measured runs. The command was:

`python3 internal/tests/scenario/benchmark_frame_cost.py --baseline /tmp/nav-1043-swept-final/baseline-harness --candidate /tmp/nav-1043-swept-final/candidate-harness --repeats 5 --allow-movement-change --output /tmp/nav-1043-frame-cost`

The flag permits the independently A/B-validated route changes; it still rejects new safety failures and variation between repetitions. Timing thresholds remain an increase exceeding both 10% and 0.05 ms for average or p95 tick cost.

**The initial timing run exited 1**: delayed crossfire/game had median p95 0.985→1.170 ms while average cost stayed 0.679→0.679 ms. Delivery was held. That scenario was repeated for eleven additional paired repetitions under both rules, using the same script with `SCENARIOS=('p_walk_pack_late_crossfire',)` and `--repeats 11`. The repeat run exited 0. All initial and repeat samples were retained and combined; none was discarded.

Across all 16 paired repetitions per rule:

| Collision | Average before | Average after | p95 before | p95 after |
|---|---:|---:|---:|---:|
| Legacy | 0.655 ms | 0.653 ms | 1.308 ms | 1.301 ms |
| Game | 0.695 ms | 0.688 ms | 1.107 ms | 1.028 ms |

The enlarged comparison has no flagged timing regression. Other cases passed the initial timing gate. This is **184 measured native runs plus warmups**, not a live renderer FPS test: the harness executes worker work inline. The initial alert and its raw data remain in the report. These results support stable measured native cost; they do not establish in-game FPS or survival.

## Delivery

Private **1.0.43** from `a52ea76` is verified and installed at `C:\realm-engine-testlab\rig\Realm Engine 1.0.43 Private (RotMG 86ad651b).exe`.

SHA256: `ba7d9d7051fa932c84383e237906866eeb336884ea8d3053bdab95ac9299b360`.

The drift-checked build mirrored only the three changed production navigation files. Their Windows source and isolated build snapshot hashes match the tested commit. Tests and seven protected owner paths were excluded. Build status is private/non-publishable, `publish=false`, private features included, diagnostics off; bindings 143 fields / 41 methods / 17 omitted / 133 offsets proven. Antivirus detections remained 7→7. Installed hash independently matches the verified cache, the rig contains one executable, and the live game/metadata pin still matches. The normal owner portable was not replaced. No live account/game session, push or deployment occurred.

Evidence is also available under `C:\realm-engine-testlab\comparisons\20260923-quiet-travel`.
