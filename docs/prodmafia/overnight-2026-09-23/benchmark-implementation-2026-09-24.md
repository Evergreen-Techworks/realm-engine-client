# Benchmark implementation — 2026-09-24

Implemented the benchmark-review recommendations in the TestLab and client feature worktrees. This changes measurement and acceptance, not the production dodge algorithm. No new live session, portable build, Windows source mirror, installation, push or deployment was performed.

## Changes

- Deaths and failed safety guardrails block A/B conclusions, including tied deaths and runner-reported deaths outside scored arm windows. Failed final evidence is retained. Legacy sequential hit-rate direction is explicitly exploratory.
- Boss scorecards now expose 100/250/500 ms hit/damage bursts, observed and ledger HP, confirmed escape latency/outcome, actual boss distance, player-only retreat, positional coverage, nominal firing-band time and reentry, damageable phases, and separate network-gap/renderer timing evidence. Unknown damage stays unknown. Whole-attempt survival windows span escape and phase boundaries.
- The private recorder captures synchronized player/boss positions and an explicit settings/loadout allowlist. New live fields require a future private build; old recordings cannot acquire missing observations.
- Fixed-budget boss comparisons require declared builds/settings/loadout/server/script, verified level 20, balanced observed ordering, matched maps/ping, complete attempts and sufficient position coverage. Failed attempts cannot be replaced. Death/reset/ground/damage regressions veto acceptance; whole-encounter bootstrap intervals must support a meaningful contact-rate reduction.
- Added a non-destructive external renderer-frame CSV importer. Network gaps are not FPS measurements.
- Native scenarios now separate world truth from delayed visibility, preserve sensor-overflow and invulnerable hazards, model delayed health/escape and controller stalls, and validate fixtures. Eight structural families cover moving bosses/adds, corner exits, doorways, streamed routes, changing routes, untargetable hazards, curved bullets/ground overlap and sensor saturation.
- Added explicit Tactician acceptance, source/binary provenance, independent-seed plan inputs, meaningful controller-disabled checks, and p99/worst native cost checks. Identical-binary timing flags are inconclusive environment noise. The previously tuned holdout is labeled a regression set.

Usage and evidence requirements: `/home/jesse/realm-engine/.worktrees/testlab/testlab/BENCHMARKS.md`.

## Verification

- TestLab: `python3 -m unittest discover -s testlab/tests` — **1103 passed** (118.732 s). Initial acceptance tests reproduced three failures before the safety fix.
- Client focused recorder/runner tests: **124 passed**; `npm run typecheck` passed.
- Full client `npm test`: **1036 passed, 20 failed assertions in five files**. The isolated unchanged baseline reproduced the same 20 failures (1035 passed); no new failure labels. Existing failures concern AutoNexus expectations, an auto-dodge label and supplyCore test discovery.
- Full native movement host suite passed, including 1,922,250 broad-phase checks. Added truth model compiled with warnings as errors and passed; eight Python benchmark tests passed; harness self-check passed.
- Expanded identical-binary control: **80 cases, zero relative gameplay regressions, 30 absolute scenario failures, 48 Tactician acceptance failures**. These are intentionally visible failures of the current controller, not an improved candidate.
- Independently rechecked stricter controller-disabled discrimination: **16/16 mutations worsened a measured metric**. The full-run summary used the earlier mutation predicate; `mutation-discrimination.json` is the authoritative stricter check.
- Native timing control: 84 samples across 14 scenario/rule combinations, three repeats per arm, identical binaries. Eight flags remain recorded as **inconclusive environment noise**. Classification was reapplied to preserved raw measurements without claiming a new timing run. This does not establish stable live FPS.

## Current structural results

Each row includes both collision rules and five controller-stall durations. Counts below aggregate candidate results; the baseline is identical.

| Scenario | Completed | Synthetic deaths | Contacts |
|---|---:|---:|---:|
| q_moving_boss_adds | 2/10 | 0 | 2 |
| q_corner_exit | 10/10 | 0 | 0 |
| q_doorway_volley | 8/10 | 0 | 0 |
| q_streamed_route | 6/10 | 0 | 0 |
| q_route_becomes_unsafe | 5/10 | 0 | 5 |
| q_untargetable_hazard | 9/10 | 0 | 4 |
| q_curved_ground_overlap | 10/10 | 0 | 0 |
| q_sensor_saturation | 0/10 | 10 | 364 |

Prioritize saturation handling, moving-boss engagement, and maintaining safe progress when streamed/changing routes become unsafe. Those now have measurable failures to target without rewarding repeated resets or running away.

## Limits and retained evidence

`benchmark-evidence-2026-09-24/` retains the expanded result, stricter mutations, native timing measurements/classification and archived last-death rescore. The archived death showed two hit claims inside 100 ms, observed HP minimum 284 and logged ledger HP 92, with no escape request; server damage amounts, actual boss-position coverage and renderer timing remain unknown. This is a rescore of existing evidence, not a new live test.

The synthetic health/escape model is not production AutoNexus, the untargetable fixture is not exact Ravenous Rot behavior, weapon reach does not prove line of sight, and inline native execution does not reproduce all asynchronous scheduling. Reserved seeds require procedural sealing before tuning. Actual server, ping and script identity still need verified external evidence. No survival or live dodge improvement is claimed from these benchmark-only changes.
