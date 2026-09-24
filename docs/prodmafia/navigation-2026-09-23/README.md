# Navigation benchmark, 2026-09-23

Candidate: `ad65161` (including initial implementation `9e2c244`), compared with pinned `1404b06` (private 1.0.39 source).
Native Tactician scenarios, using the same corrected harness for both revisions.
This measures simulated navigation and collision outcomes, not live-game survival.

## Changes

- Travel through a nearby one-tile passage with opposed FullOccupy walls samples
  the local collision grid around the player. Its former
  half-cell lattice omitted the clear centreline in a one-tile FullOccupy corridor,
  causing repeated waits for the stuck timer despite a usable strategic route.
- Near these constrained passages, the follower finishes a nearby forward bend before projecting onto the outgoing
  leg. Collision's 0.01-tile centreline tolerance must not cause an early turn.
- A small safe remainder is still a movement step. Navigation's arrival handling
  remains responsible for stopping; all projectile, body, zone, ground, speed and
  occupancy checks still apply. The driver lands exactly on the validated endpoint
  when the remaining distance fits the frame allowance.
- Locked combat retains its previous grid, handoff and movement behavior. An early
  candidate that applied exact movement broadly changed dense boss outcomes and
  was rejected. The intermediate broad grid also regressed a wide U-wall under the corrected
  harness. Both grid recentering and precise completion are now scoped to opposed
  FullOccupy passages; the final paired run checks that candidate.

## Benchmark contract

`internal/tests/scenario/benchmark_navigation.py` compiles both source revisions
with this checkout's harness, then runs 316 matched cases per revision:

- 118 existing scenarios under both collision rules, for each of two profiles;
- 36 one-tile connected-room variants (forward/reverse, 4/6/9 tiles per second,
  start shifts -0.2/0/+0.2), for each profile;
- four long-distance D* room routes, for each profile.

The fixture profile pins route commitment and enemy standoff on. The shipped
profile pins both off. Both pin fallback sidestep and frame budget off. Every case
runs in a fresh process, with inherited HARNESS variables cleared. Timing results
are simulated arrival times; host CPU timings are not scored. The baseline is an
untouched detached client worktree, and neither build changes production defaults.

Four independent pairs run concurrently to shorten the test. Each pair retains
separate processes and deterministic simulation time.

The comparison refuses new hits, overspeed, wall refusals, damaging-ground exposure,
increased stuck time, lost successes/arrivals, or successful arrivals slowed by
more than both 5% and 0.25 seconds. Individual failures remain visible in results.csv;
a clean comparison does not mean all scenarios pass.

The threat-free connected-room success gate now additionally permits at most
60 paused frames (one second at 60 Hz), identically for old and new. Existing
arrival, hit, stuck, refusal and speed gates remain in force. The prior gate
accepted repeatedly waiting out the stuck timer as long as the run eventually
arrived.

## Harness corrections, applied equally

The first speed sweep used 3 tiles/second, which maps to invalid negative SPD and
triggers the unknown-speed fallback. That sweep was discarded. The retained sweep
uses valid game speeds, and the fixture clamps its override to 4–9.6.

The simulator also accumulated rounded 0.05-tile movement substeps. An unobstructed
command to x=35.5 could land at 35.499996 instead, falsely blocking the next
FullOccupy turn. It now samples the original segment and uses its exact endpoint
when unobstructed, matching the modeled MoveTo contract. Collision clipping and
strict truth collision tests remain active. The strengthened `z_moveto_no_clamp`
check fails when the accumulated-substep behavior is restored.

Earlier numbers from the uncorrected harness are exploratory only; the retained
paired results use the same corrected harness for both versions. These corrections
are not counted as production navigation gains.

## Reproduce

From the candidate client worktree:

```sh
python3 internal/tests/scenario/benchmark_navigation.py \
  --baseline-internal /home/jesse/rec-worktrees/navigation-benchmark-20260923/internal \
  --output /tmp/navigation-ab-new
python3 internal/tests/run_udodge_zone_tests.py
```

The output directory must not already exist. It contains both native binaries,
compile logs, provenance metadata, raw metrics, a compact CSV and comparison summary.
The source diff digest in the retained metadata identifies the pre-commit candidate;
it matches `git diff 9e2c244 ad65161 -- internal/src`.

## Focused verification

The original new room-pause assertion failed against the baseline and passed with
the grid fix. The exact-corner regression also failed before its fix. Three isolated
source mutations now fail at their intended assertions, with the unmodified control
passing: premature step consumption, skipped bend completion, and dropped tiny
safe steps. A separate harness mutation restores rounded substep accumulation and
fails the endpoint check. Logs are retained alongside this report.

## Final paired results

Command above, output `/tmp/navigation-ab-20260923-accepted`, exit **0**.
The candidate production diff in metadata was verified against committed
`ad65161`; no production files changed while that run was compiling or executing.

| Matched cases | Baseline | Candidate |
|---|---:|---:|
| All passing cases | 235 / 316 | 281 / 316 |
| Speed/start variants, both profiles | 30 / 72 | 72 / 72 |
| Long-distance D* routes | 8 / 8 | 8 / 8 |
| Projectile hits across all cases | 7 | 7 |
| Detected regressions | — | 0 |

Twenty cases that previously failed to arrive now reach the destination. The other
26 gained successes satisfy the stricter no-threat pause/efficiency gates.

Selected fixture-profile, legacy-collision results (simulated seconds):

| Scenario | Baseline | Candidate | Paused frames, before → after |
|---|---:|---:|---:|
| One-tile FullOccupy corridor | 12.78 | 4.82 | 480 → 2 |
| Connected rooms, forward | 23.67 | 13.98 | 576 → 1 |
| Connected rooms, reverse | 23.85 | 13.95 | 588 → 0 |
| U-shaped wall | 4.73 | 4.73 | 0 → 0 |
| Remote rooms, forward | 86.20 | 86.20 | 0 → 0 |

The corridor is 62% faster and the connected-room forward trip is 41% faster.
See `results.csv` for every case, `summary.json` for the comparison verdict,
`metadata.json` for provenance, and `raw.jsonl.gz` for the original measurements.

### Remaining limitations and full-suite result

**The full native runner exits 1**, at the existing optional fallback-sidestep
speed criterion. With the corrected shared harness, both pinned baseline and
candidate produce the same late-crossfire result: optional sidestep on arrives
without a hit in 9.15 s; off takes a hit and arrives in 8.62 s. The test requires
sidestepping to be no slower. Its threshold was not changed. The optional switch
remains off in both benchmark profiles and in the shipped defaults. See
`optional-sidestep.csv`; the baseline checker was also run directly and returned
the identical failure text. This fixture correction exposes an existing timing
tradeoff; it is not a production navigation regression.

Everything before that check passes: zone, temporal, admission, speed/expiry,
commitment, navigation, timed escape, exact pruning (80,000), pathing rules (43),
worker clock/snapshot (13), telemetry (60), prediction error (350), temporal broad
phase (1,922,250), fallback unit tests, collision (36), speed model (18), map memory
(57), router (350), runtime (24), enemy tracking (76), AutoFire (79), classic
end-to-end scenarios (legacy 51 asserted / 8 limitations; game 53 / 6), decision
telemetry and route commitment. Input focus, which follows the stopping check,
was run separately from the runner's unchanged final compile/run block: 29 checks,
0 failures. See `native-suite.log` and `input-focus.log`.

The old route-commit check assumed the off variant must have churn. It now allows
both variants to have zero replans; positive baseline churn must still improve.
It additionally refuses extra paused frames or more than 0.25 s of added travel.
This was required because the navigation fix removes the underlying stalls even
when route commitment is off, rather than making the off variant worse to satisfy
the old comparison.

Four native mutation checks fail at the intended assertions (including loss of
exact-corner intent across the worker snapshot), and the simulator mutation fails
its exact-endpoint assertion. The controls pass. Test logs are retained here.

The 35 remaining benchmark failures are unchanged dense-boss engagement,
legacy diagonal pinches, and enemy-pack/crossfire limitations. They are included
in the denominator and visible in the CSV. This change does not improve those
combat cases or claim real-game survival, AutoNexus tuning, or FPS gains.

## Private build

Private 1.0.40 (`9e2c244`) was superseded during regression testing and was never
installed in the rig. Private 1.0.41 (`ad65161`) passed the private build gates and is installed only in
`C:\realm-engine-testlab\rig\Realm Engine 1.0.41 Private (RotMG 86ad651b).exe`.
Its SHA256 is `c34786e75a039357ce1f9a29eec5da99e5bede47895ef058621d509a4401962c`.

The rig contains one executable, its installed bytes match the cached build,
and all six changed native source files in the build snapshot match the tested
commit. The live game pin was rechecked and still matches. Build status is
`private_build_not_publishable`, publish=false, diagnostics off, bindings
143 fields / 41 methods / 17 omitted / 133 proven, and antivirus detections
unchanged (7 → 7). See `build-verification.json` and `built-source-hashes.json`.
The incremental mirror changed only the checked native files; seven protected
owner paths were left intact. The normal portable was not replaced.

This executable has not had a live-game validation session.
No upload, push, deployment or live account session is part of this run.
