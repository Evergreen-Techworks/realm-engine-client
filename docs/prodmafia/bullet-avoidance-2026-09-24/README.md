# Bullet avoidance investigation — 2026-09-24

No production change accepted. Private 1.0.43 remains installed. This turn adds a reproducible bullet-focused benchmark and preserves rejected experiments; it does not claim improved live dodging or frame rate.

The baseline is `befb15e` (production `a52ea76`, private 1.0.43), pinned in `/home/jesse/rec-worktrees/navigation-baseline-1043`. The previous navigation update retained six hits in its 316-case comparison. Those hits occur in shipped-switches, legacy-collision delayed six-shooter crossfire.

## What the hit trace showed

At 6.667 seconds, the baseline emergency fallback moves back into a visible shot. At 9.300 seconds, three delayed shots already overlap the player's vicinity when first observed, followed by another hit one frame later. The current point-blank hazard protects short-range shooters but exempts long-range shooters even at close distance. These are two distinct mechanisms; changing prediction duration alone did not fix both.

The original six-hit trace and the near-source-only candidate trace are retained here. The latter's remaining hits occurred on shots aged 917 ms, showing that keeping distance alone does not fix the escape decision.

## Benchmark retained

`benchmark_navigation.py --suite bullets` runs 72 matched encounters: two explicitly pinned settings profiles, both collision rules, delays of 0/100/200 ms, first-volley offsets of 0/150/350 ms, and original/mirrored layouts. Shots, truth collision, speed, start, destination and time limit are identical within each old/new pair. The optional changes do not alter the ordinary scenario definitions when unset.

The scorecard now exposes actual hits, completed encounters, hit-free completions and worst-case hits. Existing standoff-band `success` is retained separately: a zero-hit completion can fail that stricter proximity criterion. A new candidate must reduce total hits, without new per-case hits, lost arrivals, increased stuck time, or materially slower completions. A completion counts for the timing gate even if the legacy standoff proximity score failed; previously such a case could get slower without being rejected. Existing navigation-suite gates are unchanged.

All runs below use the same 72 encounters. These are simulated shooter-pack tests, not live per-boss measurements.

| Variant | Hits | Completed | Hit-free completions | Worst case hits | Cases failing comparison gates |
|---|---:|---:|---:|---:|---:|
| 1.0.43 baseline | 30 | 71/72 | 59/72 | 6 | — |
| Refined collision time + longer travel window | 27 | 72/72 | 57/72 | 5 | 12 |
| Near-source protection only | 15 | 72/72 | 66/72 | 4 | 5 |
| Near-source + longer travel window | 15 | 72/72 | 66/72 | 4 | 5 |
| Near-source + refined time + longer travel window | 8 | 72/72 | 67/72 | 2 | 5 |
| Near-source + refined time, original short unbuffered window | 11 | 72/72 | 64/72 | 2 | 7 |

Every experimental candidate was rejected. In particular, the 30→8 result is a 73% aggregate reduction, but the mirrored legacy encounter with 200 ms delay / 150 ms first-volley offset changes from zero hits in 10.53 s to one hit in 44.42 s. Another variant adds three individual hit regressions despite a lower total. Those are not acceptable evidence for replacing the installed build.

The first refined-window candidate also ran the full 316-case navigation comparison: 282→287 proximity passes and 6→4 hits, but worse boss engagement and new stuck time. This illustrates why aggregate hits and pass counts alone are insufficient.

## Experiments and reproduction

The near-source experiment adds a keepout of the known shot speed times one 200 ms visibility tick plus the existing 0.5-tile margin, capped by reach and the existing 6-tile maximum. It preserves the stronger short-range rule and the locked-target exemption. This is an unaccepted model, not a proven bound on live latency.

The time-refinement experiment distinguishes collision times within a 100 ms temporal interval for fallback ranking, leaving normal safety admission unchanged. The saved code is experimental and has not undergone release review or final cost validation.

The two `reaction-*.patch.gz` production patches were hashed and matched exactly to their corresponding benchmark metadata before restoring production source. To reproduce in an isolated checkout, apply one production patch plus `experiment-harness-adapter.patch.gz`; that adapter supplies shot speed only when the source revision supports it. `reaction-unit-tests.patch.gz` preserves the new hazard-policy regressions. Do not apply both alternative production patches together.

Commands used (output directories must be new):

```sh
python3 internal/tests/scenario/benchmark_navigation.py \
  --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1043/internal \
  --suite bullets --output /tmp/bullet-investigation

python3 internal/tests/scenario/benchmark_navigation.py \
  --baseline-internal /home/jesse/rec-worktrees/navigation-baseline-1043/internal \
  --output /tmp/bullet-navigation-investigation
```

Each experiment directory retains provenance, comparison summary, CSV and compressed raw results; `binary-hashes.json` identifies the actual native binaries used. The experimental regression suites exit 1 as intended. The null control also exits 1, solely for `no reduction in projectile hits`: old and new both produce 30 hits, 71 completions and 59 hit-free completions. All per-case comparison gates pass for that control, proving that unchanged behavior is not reported as a bullet improvement.

The focused near-source policy tests failed before the helper existed, then passed 54 checks. An initial full-native attempt stopped at a missing test include; that include was corrected for the focused passing run. No full-suite success is claimed for the experimental implementation. Production source and experimental unit additions were subsequently restored; only benchmark tooling, documentation and saved evidence remain changed.

No private build, Windows source mirror, installation, live game/account session, settings default change, push or deployment occurred. Serial frame-cost validation was not reached because the gameplay candidates failed acceptance.

Final fixture control: ran all 316 original cases with the previously accepted 1.0.43 harness and the rebuilt harness against unchanged production code. Every tracked gameplay metric matched exactly: 282 proximity passes, 6 hits, zero differences. `default-fixture-control.json` and binary hashes record this check. All four saved patches pass `git apply --check`.
