# Test Lab session summary — 20260924T182702Z

- schema_version: 1
- version: **1.0.44**
- build: version=1.0.44 commit=b72f2a2 date=2026-09-24T18:27:02.101Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 12:27:02 local (2026-09-24T18:27:02.097000+00:00)
- end: 2026-09-24 12:34:15 local (2026-09-24T18:34:15.918000+00:00)
- duration: 7.2 min
- outcome: **INCONCLUSIVE** (< 5 active farmer minutes; excluded from version aggregates)

## Session
- active farmer minutes: 4.33
- maps visited (4): Nexus, Realm of the Mad God, Oryx's Castle, Oryx's Chamber
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 41.54
- frozen seconds/hour: 1137.86
- longest freeze: 56.9s
- flip_flops/hour: 0.00
- distinct quest targets/hour: 13.85
- raw: {'freeze_count': 3, 'frozen_seconds_total': 82.2, 'flip_flop_count': 0, 'distinct_quest_targets': 1, 'active_farmer_basis_hours': 0.072}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 41.49
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.072, 'ground_damage_steps': 0, 'packet_span_hours': 0.117}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 86.96
- damage/1000 near passes: 5978.26
- share of hits with enemy within 3 tiles: 0.88
- raw: {'near_passes': 92, 'near_passes_approx': 21, 'near_passes_from_hits': 1, 'hits': 8, 'damage_total': 550.0, 'shots_without_projdef': 555, 'shots_backfilled': 233, 'shots_unresolved': 540, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'fighting': {'near_passes': 26, 'hits': 3, 'hits_per_1000_near_passes': 115.38461538461539}, 'walking': {'near_passes': 9, 'hits': 0, 'hits_per_1000_near_passes': 0.0}}

## Auto Aim
- shots=1588 enemy_hits=1678 hits/shot=1.06 kills=130 kills/hour=1115.05 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (3)
### stall — waiting for encounter visibility — 25.2s — 2026-09-24 12:29:35 local
- target/place: Daughter of Limon
- held 25.2s, budget 10.0s
- excerpt:
```
[18:29:35.581] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1698.4,1090.6 goal=1693.8,1091.3 d=4.7 enemy=9.2 quest=260917
[18:29:40.605] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1697.4,1090.8 goal=1693.8,1091.3 d=3.7 enemy=16.5 quest=260917
[18:29:45.668] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1697.4,1090.8 goal=1693.8,1091.3 d=3.7 enemy=18.6 quest=260917
```

### hard_freeze — waiting for encounter visibility — 20.2s — 2026-09-24 12:29:40 local
- target/place: Daughter of Limon
- position moved 0.00 tiles over 20.2s, no status change (ctx)
- excerpt:
```
[18:29:40.605] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1697.4,1090.8 goal=1693.8,1091.3 d=3.7 enemy=16.5 quest=260917
[18:29:45.668] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1697.4,1090.8 goal=1693.8,1091.3 d=3.7 enemy=18.6 quest=260917
[18:29:50.711] [Script:farmer] [farmer] state: Daughter of Limon: waiting for encounter visibility | ctx pos=1697.4,1090.8 goal=1693.8,1091.3 d=3.7 enemy=18.2 quest=260917
```

### hard_freeze — (no farmer line) — 56.9s — 2026-09-24 12:32:20 local
- target/place: Oryx's Castle
- silent 56.9s in map 'Oryx's Castle'
- excerpt:
```
[18:32:20.707] [Script:farmer] [farmer] Realm Farmer — Castle: clearing route toward next encounter
[18:33:17.634] [Script:farmer] [farmer] Realm Farmer — Castle: Stone Guardian defeated
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Daughter of Limon | approach | 52.5 | 0 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 3.1 | 0 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | approach | 3.4 | 0 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 30.1 | 0 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | approach | 33.8 | 3 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 5.7 | 6 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | combat | 8.4 | 11 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 3.1 | 7 | 3 | 0 | target_changed | incomplete |
| Daughter of Limon | combat | 3.2 | 8 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 0.8 | 0 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | loot | 10.1 | 7 | 0 | 0 | target_changed | incomplete |
| Daughter of Limon | transition | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| The Plague Doctor | combat | 5.2 | 6 | 3 | 0 | disconnect | incomplete |
| The Plague Doctor | transition | 6.1 | 1 | 2 | 0 | disconnect | incomplete |
| The Plague Doctor | combat | 1.0 | 3 | 0 | 0 | disconnect | incomplete |
| The Plague Doctor | transition | 8.3 | 7 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
