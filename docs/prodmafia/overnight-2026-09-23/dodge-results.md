# Dodge refinement results — 2026-09-23

## Decision

Use the private candidate for further validation. The best controlled profile is Tactician, legacy navigator, enemy standoff auto, travel commitment on, fallback sidestep off, frame budget off. All experimental defaults remain unchanged. Neither persistent-map navigation nor fallback sidestepping has earned a default-on recommendation.

The work improves specific navigation failures. It does not establish general live superiority, solve dense-boss engagement, or establish that 1%/5% AutoNexus is safe.

## Directed changes

- Keep a reachable forward corridor bend after a reflex detour instead of discarding a usable route.
- Keep a stable approach bearing for each farmer target, inside the combat acquisition radius. Rechoose it when blocked, invalidated, or crossed to the opposite side.
- Restrict travel route commitment to travel; do not apply it to short combat approaches, where it reduced engagement.
- Restrict optional fallback sidestepping to unlocked point travel. Global use increased dense-fight hits from 6 to 30 and was rejected.
- Identify event/boss target IDs in status context. TestLab now distinguishes progressing through distinct targets from repeatedly switching around one target or revisiting prior targets.
- Bound optional fallback near-ties against the globally best safety time. A pairwise chain could exceed its documented 60 ms budget. This correctness fix alone does not cure the delayed-shot stress regression; leave the option off.

## Controlled results

The 118-case comparison uses the same harness and both collision rules. Thirteen preferred-profile failures remain visible as existing dense-fight or legacy diagonal-collision limitations plus the delayed legacy crossfire case. No assertions or acceptance thresholds were relaxed. The separate strict Tactician acceptance command still fails **52 of 96 thresholds**, including engagement, radial retreat, replanning and reversals; the old baseline fails the same 52 thresholds. This is not release-ready proof. See `candidate36-acceptance.txt`.

| Configuration | Successful cases | Hits |
| --- | ---: | ---: |
| Old 1.0.32, shipped switches, Tactician | 101 / 118 | 7 |
| Preferred candidate: standoff + travel commitment, fallback off | 105 / 118 | 7 |
| Candidate with scoped fallback on (not selected) | 106 / 118 | 6 |

A separate stress sweep varies added projectile age through 0, 100, 150, 200, 250 and 300 ms. These are 12 timing variants of **one** six-shooter travel scenario, not 12 independent encounters.

| Configuration | Successful timing variants | Hits |
| --- | ---: | ---: |
| Old shipped profile | 2 / 12 | 24 |
| Candidate standoff + travel commitment, fallback off | 10 / 12 | 2 |
| Candidate scoped fallback on | 10 / 12 | 3 |
| Candidate without fallback displacement override (rejected) | 10 / 12 | 13 |

The fallback-off candidate never increases a timing variant's hit count against the old profile. Enabling fallback fixes the 200 ms legacy case and 250 ms game case, but regresses both 300 ms cases. That tradeoff is why it stays off. Anchoring the safety tie band fixes its unit regression but leaves these scenario results unchanged.

## Live evidence

All runs use actual HP 25%, forecast 10%, BurstGuard on. The earlier 5%/5% trial died; lower settings are not recommended. The following are short pilots, with changing enemies and unequal exposure. Hit/near-pass ratios are useful diagnostics but cannot by themselves establish a winner; retain kills, damage, path progress, Nexus exits and deaths.

| Run / build | Comparison | Results | Interpretation |
| --- | --- | --- | --- |
| 161424Z / 1.0.32 | Classic vs Tactician, 12.1 min | 21/297 vs 62/475 hits/near-passes; no deaths | Character leveled during run; under-exposed |
| 163407Z / 1.0.33 | Classic vs Tactician, 12.1 min | 26/293 vs 16/270; no deaths | Different event-farming mix; not proof against old build |
| 164931Z / 1.0.32 | Same-level Tactician control, 6.1 min | 43.24 hits/1000 near-passes; no deaths | Old control remains competitive; no blanket improvement claim |
| 165850Z / 1.0.34 | Standoff off vs auto | 24/211 vs 0/18; no deaths | Interrupted by server failure/disconnect; insufficient exposure |
| 171114Z / 1.0.34 | Legacy vs Dstar, 8.1 min | 8/97 vs 21/223; kills 106 vs 18; no deaths | Under-exposed; no evidence to switch navigator |
| 172519Z / 1.0.35 | Standoff off vs auto, 10.1 min | 3/43 vs 24/209; ground-damage steps 151 vs 47; kills 1 vs 208; no deaths | Mixed, under-exposed; auto fought more and reset less, but projectile-hit rate was higher |
| 173826Z / 1.0.36 | Route commitment off vs on | Server failure/disconnect after ~1 minute; no deaths; automatic no-movement shutdown | Invalid for route comparison; reported 4.3 min includes disconnected time |
| 174432Z / 1.0.36 | Route commitment off vs on, 6.1 min | 4/96 vs 12/122; kills 114 vs 42; Nexus exits 0 vs 2; no ground-damage steps or deaths | Under-exposed, unequal combat exposure; no live winner |

The interrupted standoff run's nominal duration includes disconnected time. Its freeze and per-minute measurements cannot be interpreted as active gameplay rates. Beacon search/teleport flip-flop flags also require manual interpretation: travelling among new beacons is not automatically a physical freeze.

Raw live reports and log snapshots are preserved in `C:\realm-engine-testlab\comparisons\20260923-dodge`. Offline JSONL, rejected candidates, red/green regression evidence and reproduction script are adjacent to this report. Nothing was pushed, uploaded or deployed.

The 1.0.35 standoff run recorded 12 Nexus exits while off and 9 while auto, across roughly four and six scheduled minutes respectively. Auto also progressed to another event. The large activity and hazard differences prevent a clean causal projectile-dodge conclusion. The main damage-per-near-pass metric covers projectile hits and must not hide ground-damage failures.

Metric limitation found during review: `testlab/lib/ab.py` excludes approximate/non-straight projectiles from its near-pass denominator but counts all recorded projectile hits in the numerator. Treat the reported ratio as a diagnostic, not a calibrated hit probability across different attack mixes. All live A/Bs here are already under-exposed, so no statistical winner is claimed. Matching eligible hit/projectile cohorts and clipping disconnected exposure are follow-up measurement work before trusting a future conclusive label.

## Validation and delivery

- `python3 internal/tests/run_udodge_zone_tests.py`: passed, including 1,922,250 temporal differential checks, 11 fallback-ranking assertions, collision/router/runtime checks, telemetry and both travel-scope regressions. Default Classic scenario assertions: 51 legacy / 53 game; known limitations retained.
- Explicit Tactician matrices: 118 cases each, both rules, as shown above. Strict acceptance remains 44 met / 52 unmet for both old and preferred profiles.
- `npm run typecheck`: passed. Farmer, dead-church and bag-loot tests: 152 passed. Earlier full client comparison retained the same 19 failing AutoNexus assertions plus one existing test-runner mismatch on baseline and candidate; it is not described as a fully green client suite.
- `python3 -m unittest discover -s testlab/tests`: 1,046 passed after the freeze-detector fixes.
- Private build verifications passed: non-publishable status, publish=false, matching executable SHA256, expected bindings receipt, diagnostics default off, unchanged antivirus state and clean private build pipeline.

Final native source commit: `0073ca58caa8ca8668757cb05e4e79b719032147` on `feat/predictive-nexus-testlab`. Earlier directed changes: `c1e878a` (corridor rejoin), `98e97a8` (farmer approach), `8ffe30a` (travel-only commitment), `076c202` (travel-only fallback); `0073ca5` anchors safety ties. TestLab detector commit: `8297135a` on `feat/testlab`.

Private executable: `C:\realm-engine-testlab\rig\Realm Engine 1.0.36 Private (RotMG 86ad651b).exe`.
SHA256: `bec283060d840ec606ea5076a8dfccf88d8be06fac7072a77fb9554115a4a525`.
The selected experimental overrides are in `preferred-test-profile.json`; packaged defaults remain unchanged. The owner portable was not replaced.

The final route retry completed and the rig shut down normally. Off had 3.755 washout-adjusted minutes and on 1.920; near-passes/min and shots-landed/min were higher during on. On also had more projectile damage and Nexus exits. This does not validate enabling commitment by default. Reported fighting/phase-transition freezes are not automatically physical pathing failures. The preferred profile is a controlled-test candidate, not a live-certified recommendation.


## Later boss and AutoNexus investigation

The earlier completion above covers the initial movement comparison only. Subsequent owner feedback identified an untargetable Ravenous Rot tentacle and continued early escapes. Native commit825aa4b preserves XML-invincible projectile attackers lacking authored HP (Rot Path/Cyst), with four reproduced classifier failures corrected and76 enemy-tracker checks passing. The full native host suite passes. Retaining those entities is not yet a demonstrated complete feet-attack avoidance solution.

Client commit1a9993d separately fixes AOE impacts being kept as persistent forecast zones using condition duration. Acknowledged in-radius impacts now enter the health ledger once; missed and already-settled blasts cannot be forecast again. Nine directed regressions and48 recorder tests pass; typecheck passes. Broader AutoNexus tests retain exactly19 named baseline failures (83 candidate passes versus74 parent passes).

Live tests did not establish survival improvement: old1.0.36 actual5%/forecast1% died to Ethereal Shrine; replacement1.0.37 actual25%/forecast10%/BurstGuard on died to Ent Ancient. The latter recorded no area attacks/ground contacts and no requested escape: confirmed280/325, estimated130, threshold81. The unexplained damage gap needs synchronized health/DAMAGE/condition and threat evidence. The3/3 character-creation cap prevents further live testing today; it was not bypassed. The rig runner override was restored and all owned sessions ended.

Full boss report: /home/jesse/realm-engine/.worktrees/testlab/testlab/boss-testing-2026-09-23.md. Rescored artifacts: C:\realm-engine-testlab\comparisons\20260923-bosses. TestLab1068 tests passed; currentuint16 bullet matching and explicit death outcomes are included. No public portable replacement, default flip, upload, push or deploy. Private1.0.38 contains both code corrections but still requires live validation.
