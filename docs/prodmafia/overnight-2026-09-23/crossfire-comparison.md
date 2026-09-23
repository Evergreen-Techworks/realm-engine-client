# Shooter pack crossfire, 2026-09-23

Same production sources as 1.0.33; Tactician. Route commitment, fallback sidestep and frame budget off. New `p_walk_pack_crossfire` fires all nearby pack members together every 700 ms; original fixture fires only the first eligible enemy. Goal remains beyond the pack; existing arrival, zero-hit and spacing thresholds retained.

| Rule | Standoff | Reached goal | Hits | Time (s) | Path tiles | Nearest enemy | Time in band |
|---|---|---|---:|---:|---:|---:|---:|
| legacy | off | yes, spacing FAIL | 0 | 5.65 | 33.9 | 1.64 | 2.02 s |
| legacy | on | yes, pass | 0 | 5.53 | 33.3 | 4.21 | 0.40 s |
| game | off | yes, spacing FAIL | 0 | 8.32 | 40.1 | 2.75 | 1.02 s |
| game | on | yes, pass | 0 | 5.55 | 33.3 | 4.21 | 0.40 s |

Commands: `run_scenarios.py --only p_walk_pack_crossfire --policy tactician --rule both --binary-out /tmp/dodge-crossfire-harness`, with HARNESS_ROUTE_COMMIT=off, HARNESS_ENEMY_STANDOFF=on, HARNESS_FALLBACK_SIDESTEP=off, HARNESS_FRAME_BUDGET=off; rerun that binary per rule with only HARNESS_ENEMY_STANDOFF=off. This demonstrates better spacing and travel, not fewer hits (both were zero).
