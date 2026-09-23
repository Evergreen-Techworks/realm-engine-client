# Travel fallback refinement — 2026-09-23

The global sidestep heuristic made dense combat worse. Keep combat on its existing latest-danger-time fallback ranking and apply lateral tie-breaking only during unlocked point travel. `goal.fromLock` alone cannot identify combat: lock approaches are point goals, so the production map lock must also exclude them.

| Tactician configuration | Successful scenarios | Total hits |
| --- | ---: | ---: |
| 1.0.34, commitment + standoff, fallback off | 104 / 116 | 6 |
| Rejected global fallback on | 103 / 116 | 30 |
| Travel-only fallback on, expanded suite | 106 / 118 | 6 |

All 116 shared scenarios retain identical success, hits, arrival time, stuck time and engagement. The two additional cases inject 200 ms of projectile age into simultaneous six-shooter crossfire, using the existing shotgun fixture's delayed-packet model. The legacy-rule control takes one hit and fails; the travel-only candidate takes zero hits and reaches the goal in 8.02 s versus 8.28 s. Game-rule arrival remains 5.73 s with zero hits. Existing thresholds, collision rules and known-limitations lists are unchanged. This is a targeted deterministic improvement, not proof of all-scenario live superiority.

Regression: `python3 internal/tests/scenario/run_scenarios.py --travel-fallback-check` failed before the fix (combat damage increased), and passed afterward. Full comparison: `HARNESS_ROUTE_COMMIT=on HARNESS_ENEMY_STANDOFF=on HARNESS_FALLBACK_SIDESTEP=on HARNESS_FRAME_BUDGET=off python3 internal/tests/scenario/run_scenarios.py --policy tactician --profile fixture`. See adjacent raw JSONL and red/green outputs. The experimental switch remains off by default, with a travel-specific dashboard label.
