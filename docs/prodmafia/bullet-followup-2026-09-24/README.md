# Private dodge candidate 1.0.44 — 2026-09-24

This candidate improves measured projectile avoidance substantially, but **does not pass the entire expanded acceptance suite**: seven holdout encounters arrive slower. It is intended for private TestLab evaluation, not public release approval. No live boss, renderer FPS, AutoNexus, account, or survival result is claimed.

## Changes and cause

- Near a non-locked shooter, reserve the distance a known-speed projectile covers in two server ticks (visibility delay plus movement commitment), with the existing contact margin and six-tile cap. Unknown speed retains the old policy; short-range shotgun protection and locked-target engagement remain. Observed AOEs are inserted before inferred shooter envelopes so inferred zones cannot displace them at capacity.
- In unlocked point-travel fallback only, estimate contact within a temporal bin instead of treating all contacts in its first 100 ms as equal. Scan all lanes in that bin. These are ranking estimates, not admission/safety certificates; hard safety and dwell queries retain conservative times.
- When already in contact, favor continuing the escape over reversing among nearly equal-clearance alternatives. A later estimated contact still ranks first.
- Make route following and invalidation use the same swept enemy-zone check. Previously A* routed around a hazard but the follower shortcut checked only walls, cut back across it, and invalidated the valid route. The regression test reproduces that unsafe shortcut and verifies connected progress around the hazard.

No settings defaults, AutoNexus thresholds, combat-lock policy, or public release gate changed.

## Paired results against installed 1.0.43

One current harness compiles both source trees. Baseline is the pinned `navigation-baseline-1043` worktree at `befb15e` (production `a52ea76`); candidate production diff SHA256 is `219c1528aa56a8e07f5bd262831c9d76b44f5d3d8fd947f646a2c05c818273c7`, saved in `production.patch.gz`. Results include both collision rules and fixture/shipped setting profiles.

| Suite | Projectile hits old → new | Arrivals old → new | Hit-free arrivals old → new | Acceptance |
|---|---:|---:|---:|---|
| Primary 72 crossfire encounters | 30 → 0 | 71 → 72 | 59 → 72 | Pass, no per-case regressions |
| Original 316 navigation encounters | 6 → 0 | See raw results | See raw results | Pass, 282 original assertions passed in each revision |
| 64 holdout encounters | 2,038 → 153 | 51 → 64 | 26 → 32 | **Fail: seven arrival-time regressions** |

The holdout changes shot speed to 6/12 tiles/s, visibility delay to 150/250 ms, phase to 225 ms, and includes 90-degree rotations and mirroring. It was first run after candidate selection and was not used to tune the retained production source. Its 92.5% total hit reduction is dominated by avoiding repeated baseline failures; it does not imply that percentage improvement per boss or in live play. No holdout case takes more hits, loses an existing arrival, or increases stuck time, damaging-ground frames, movement refusals, or overspeed moves. Half the holdouts still take hits.

All seven time failures remain in `holdout/summary.json`; the timing threshold was not loosened:

| Case | Arrival seconds old → new | Hits old → new |
|---|---:|---:|
| 10 | 11.28 → 19.25 | 0 → 0 |
| 11 | 5.45 → 11.15 | 0 → 0 |
| 20 | 15.32 → 16.53 | 13 → 4 |
| 22 | 7.95 → 9.03 | 7 → 1 |
| 25 | 5.68 → 12.65 | 0 → 0 |
| 29 | 28.30 → 51.62 | 19 → 7 |
| 43 | 6.22 → 11.18 | 0 → 0 |

The bullet scorecard now scores actual zero-damage arrivals independently of the optional standoff-distance metric. `proximity_passed` preserves the old score: primary 36→40, holdout 14→32. In particular, primary cases 51/62 previously appeared as lost passes solely for entering the disabled soft standoff band despite arriving faster without damage. Original navigation assertions and all per-case damage/completion/time/terrain gates remain unchanged. Four Python tests verify actual outcomes and isolation of harness environment overrides.

## Alternatives retained as evidence

`exploratory/` retains intermediate raw outcomes, not separately reproducible production releases. Broad continuity alone produced 20 primary hits; immediate frame/tick guards produced 31/40; enabling timed advice for travel lost arrivals (48/72). The 400 ms shooter budget alone produced four hits; adding temporal refinement reduced it to two; zero-time escape continuity reduced it to zero. The swept follower fix removed the primary timing failure. Hold-wakeup probing and removing stand bias did not fix it and were discarded.

The final ablation removing shooter envelopes but retaining local timing/continuity/shortcut changes produced 19 primary hits and only 48/64 holdout arrivals (753 hits), with regression gates failing. Retain the better combined candidate for private evaluation, while explicitly carrying the seven detour failures forward. Further work should focus on navigating overlapping shooter envelopes without oscillating or over-detouring; it must not erase the new holdout failures from the scorecard.

The previous report's saved `experiment-harness-adapter.patch.gz` was repaired: its text replacement accidentally touched an unrelated scenario's preprocessor branch. The live harness used for the previous measurements was correct. The corrected adapter targets only the crossfire scenario.

## Verification and reproduction

Run from the client worktree:

```
python3 -m unittest discover -s internal/tests/scenario -p test_bullet_scorecard.py -v
python3 internal/tests/run_udodge_zone_tests.py
python3 internal/tests/scenario/benchmark_navigation.py --suite bullets --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1043/internal --output /tmp/primary-new
python3 internal/tests/scenario/benchmark_navigation.py --suite bullets-holdout --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1043/internal --output /tmp/holdout-new
python3 internal/tests/scenario/benchmark_navigation.py --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1043/internal --output /tmp/navigation-new
```

Full native suite exits 0 (`native.log`). Focused temporal 44 checks and pathing 56 checks pass, including capacity preservation; navigation shortcut/route/ring tests pass (`focused.log`). The full suite ran before the two additive capacity assertions, which were then included in the focused rerun. Three isolated mutations fail as intended (`mutations.log`): disable refined contact, allow every enemy shortcut, halve the reaction budget. No production files were mutated during measurements. Sensor AOE insertion order is source-reviewed; the pure capacity test does not execute Windows sensor capture.

Serial pinned-CPU frame-cost comparison exits 0: 140 measured runs plus warmups, five repeats across seven scenarios and both rules, no timing or behavior-stability flags. Crossfire native tick average: legacy 0.687→0.482 ms, game 0.696→0.597 ms; p95 1.461→0.739 and 1.148→0.689 ms. Dense-boss p95 is approximately unchanged (maximum reported candidate median 2.583 ms). `frame-cost/` retains all samples. Worker work runs inline; these are not live renderer FPS measurements.

```
python3 internal/tests/scenario/benchmark_frame_cost.py --baseline /tmp/bullet-navigation-1044/baseline-harness --candidate /tmp/bullet-navigation-1044/candidate-harness --repeats 5 --allow-movement-change --output /tmp/bullet-1044-frame-cost
```

Private build receipt follows after verification. This candidate is not certified for live FPS or death prevention.
