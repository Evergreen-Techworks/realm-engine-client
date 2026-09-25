# Dodge benchmark review — 2026-09-24 (America/Denver)

Scope: native scenario/scorecard/frame-cost code at client `d4e854f`, live TestLab scoring and runner in the TestLab worktree, and the recorded recent death investigations. This is a review and proposed acceptance design, not a new dodge build or live survival result.

The suite is useful for reproducible regressions, but currently permits conclusions stronger than its evidence. Fix acceptance and simulation validity before increasing parameter sweeps. Preserve the existing per-case hit/ground/arrival checks, environment isolation, alternating timing runs, recording fingerprints, and live fight-avoidance guardrails.

## Findings, in implementation priority order

### 1. High: safety qualifications do not control A/B success

TestLab `lib/ab.py:499` evaluates safety/progression guardrails, but explicitly treats their result as display-only. `lib/run.py:845` advances the conclusive streak using the raw hit-rate verdict. A failed or under-exposed guardrail can therefore count toward the automatic conclusive stop. Also, `ab.py:527` returns under-exposed before evaluating a winning arm's additional death when either arm has fewer than 20 kills.

Reproduced directly using `ArmStats`: A=200/1000 hits, B=10/1000, B has one death. With zero kills each, the guardrail returns under-exposed; with 20 kills each, it returns fail/deaths +1. Both raw verdicts count as conclusive. Existing tests pass because they encode the current separation.

Change: keep statistical direction separate from candidate acceptance. Safety failure must be evaluated before exposure sufficiency, must veto promotion, and must stop an unsafe experiment with an explicit rejected outcome rather than continue farming samples. Insufficient data must never count as accepted. Add runner tests for lower hit rate plus death, lower hit rate plus insufficient combat, and a valid improvement. Retain both arms' deaths: a tie at nonzero deaths is not evidence of safe performance.

### 2. High: count damage bursts and survival, not just bullet contacts

The native harness counts contacts but does not model actual HP depletion/death or AutoNexus request-to-exit latency. A low total hit count can still contain one lethal cluster. The recorded deaths make this a practical gap, not a hypothetical one.

Add per-boss/phase live maximum damage and hit count over rolling 100/250/500 ms, minimum observed and ledger HP, ground/AoE damage, and time from escape request to confirmed transition/death. Report unavailable fields as unknown. Keep deaths, escape failures, and AutoNexus exits separate. Do not credit an aborted fight as a completed safe encounter.

Add deterministic survival fixtures with damage, HP/defense, delayed HP observations, and escape latency. Include a multiple-hit server batch and damage during a frame stall. Native movement tests remain useful but cannot prove survival until that model exists. Do not infer that a threshold would have saved a character merely because it crosses a recorded ledger value.

### 3. High: broaden encounter structure and validate the simulator

`benchmark_navigation.py:50` and `:62`: the 72 primary and 64 holdout bullet cases all use `p_walk_pack_late_crossfire`. The shared fixture (`udodge_scenario_harness.cpp:2026`) has six stationary shooters in an open room. Rotation, phase, speed and delay variations are useful stress tests, but do not cover streamed mobs, changing bosses, corners or hazards. The holdout has also been repeatedly consulted during tuning; treat it as a regression set now.

Harness validity gaps:

- `:2080` backdates a newly created bullet for late visibility. The bullet does not exist in world truth before delivery, so pre-visibility contact cannot be scored. Separate world spawn time from sensor delivery time.
- `:470–479` sets `limited=false` and silently skips lanes above capacity. Add a saturated-sensor case with faithful truncation/availability flags and independent truth collisions.
- `:509` omits enemies with HP <= 0 before considering invulnerability. Add an untargetable damaging hazard fixture whose damage exists independently of targetability. Validate actual Ravenous Rot tentacle mechanics from captures before claiming parity.
- Clock starts at 100000 ms (`:109`, `:1231`); default floor covers only +/-40 (`:1469`). Assert script events fired, start/goal are valid, required hazards actually spawned, and the intended dangerous window was reached. Use elapsed scenario time for triggers.

New scenario families: a moving boss with adds; Ravenous Rot-style untargetable foot hazards; walls/corners with one safe exit; a doorway crossed by volleys; streamed enemies along a long route; a safe route becoming unsafe mid-commit; and late/curved projectiles with ground/AoE overlap. Confirm each fixture catches an intentionally broken controller. Reserve new layouts/seeds for final validation before tuning; do not keep selecting against the same holdout.

### 4. Medium: current distance statistics measure a goal proxy

TestLab `lib/encounters.py:165` consumes `ctx.dist_to_goal`; `:265` sums positive successive differences. This is distance to the farmer goal, which can be a waypoint. It does not establish distance from a moving boss, or separate player retreat from boss/goal movement. Existing field names correctly say goal distance; avoid presenting them as direct boss-distance measurements.

Add synchronized boss and player positions keyed by map generation/object ID, sample age/coverage, and weapon range. Measure time in an effective firing band while the boss is damageable, player movement radially away from the boss, and time to re-enter firing range after a dodge. Reject stale samples and split target changes. Keep approach, active combat, invulnerable waiting and loot separate. Optimize proximity only after survival/damage gates pass; closest possible distance is not the target.

### 5. Medium: performance and configuration coverage miss live failure modes

`benchmark_frame_cost.py:5,45,71` measures inline worker execution, shipped settings and average/p95 native tick time. This is not a render-FPS or asynchronous-worker test. Record p99/worst stalls and stale-plan age, and add controlled 50/100/250/500 ms pauses while world truth continues advancing. Correlate live render and packet gaps with damage; do not label every intentional stationary boss phase a freeze.

`benchmark_navigation.py:99` tests routeCommit/enemyStandoff both on or both off, with fallbackSidestep/frameBudget off. It does not cover the recent live routeCommit=off/enemyStandoff=auto combination. Add an explicit profile copied from the measured run, including policy, collision/navigator, speed and all movement switches. Store full settings, script/native hashes and character readiness alongside results.

`run_scenarios.py:15,330`: normal `--check` excludes separate Tactician acceptance and defaults to classic policy. Require the explicit Tactician acceptance command for a Tactician candidate; list known limitations and changed failures in the candidate report instead of equating a green general suite with Tactician acceptance.

### 6. Medium: make live comparisons encounter-matched

The pooled near-pass hit-rate metric is descriptive and useful, but encounter mix can change across timed arms. Bullets in the same volley/encounter are correlated, and steering changes which bullets enter the near-pass denominator. Estimated avoided near-passes do not establish controller-caused dodges.

Prefer complete boss attempts as comparison units. Balance arm order across repeated encounters, record boss/phase/gear/speed/ping and readiness, and compare matched groups with encounter-level uncertainty. Keep a fixed, declared evaluation budget or a calibrated sequential method; two consecutive significant pooled checkpoints alone do not establish controlled false-positive risk. Use short development fixtures, but do not shorten final live exposure until evidence disappears. No independent live survival improvement is established by the existing under-exposed runs.

## Proposed candidate acceptance order

1. Valid measurement: verified level 20, fixed loadout/settings, matching fingerprints, enough comparable boss attempts and telemetry coverage. Preparation, disconnects and unsupported analysis remain explicitly separate.
2. Safety veto: no new deterministic deaths, escape failures or hazardous-ground regressions; any observed live death blocks a safe-improvement claim pending investigation. Zero deaths in a small sample is not proof of safety.
3. Engagement: boss completions, AutoNexus/abandonment rate and damage dealt must show the candidate still fights. No reward for retreating indefinitely or resetting encounters.
4. Dodge quality: reduce damage/bursts and supported contact rate in matched encounters, with per-boss and worst-case results visible. Require a declared meaningful improvement, not just baseline=candidate=zero on an easy pack.
5. Navigation and cost: improve useful firing-band time, route progress and recovery without increased damage; respect native tail-cost and measured live frame-stall budgets.

Implementation sequence: repair verdict gating; add burst/survival scorecard fixtures; correct sensor truth and hazard fixtures; add actual boss-relative telemetry and live settings coverage; then evaluate one directed dodge change against a new reserved scenario set and matched live encounters.

## Verification and evidence limits

- TestLab: `python3 -m unittest tests.test_ab_guardrail tests.test_encounters` from `testlab/`: 36 passed.
- Client: `python3 -m unittest discover -s internal/tests/scenario -p test_bullet_scorecard.py`: 4 passed.
- Direct guardrail reproduction produced the unsafe/under-exposed conclusive behavior described above. No production changes or new live sessions were performed for this review.
- The last run's 1,298 observed projectiles were accumulated observations, not simultaneous active bullets. Its 434 unsupported projectiles are analyzer coverage, not proof the native controller missed them. Absence of the previous long freeze in that run does not prove the new recovery branch activated or fixed it.
