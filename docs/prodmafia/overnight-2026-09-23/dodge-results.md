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

The 118-case comparison uses the same harness and both collision rules. Twelve candidate failures remain visible as existing dense-fight or legacy diagonal-collision limitations. No assertions or acceptance thresholds were relaxed.

| Configuration | Successful cases | Hits |
| --- | ---: | ---: |
| Old 1.0.32, shipped switches, Tactician | 101 / 118 | 7 |
| Candidate, standoff + scoped commitment + scoped fallback | 106 / 118 | 6 |

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

The interrupted standoff run's nominal duration includes disconnected time. Its freeze and per-minute measurements cannot be interpreted as active gameplay rates. Beacon search/teleport flip-flop flags also require manual interpretation: travelling among new beacons is not automatically a physical freeze.

Raw live reports and log snapshots are preserved in `C:\realm-engine-testlab\comparisons\20260923-dodge`. Offline JSONL, rejected candidates, red/green regression evidence and reproduction script are adjacent to this report. Nothing was pushed, uploaded or deployed.
