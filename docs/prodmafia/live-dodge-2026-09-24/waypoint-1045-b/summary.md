# Test Lab session summary — 20260924T193926Z

- schema_version: 1
- version: **1.0.45**
- build: version=1.0.45 commit=26ec813 date=2026-09-24T19:39:26.491Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 13:39:26 local (2026-09-24T19:39:26.488000+00:00)
- end: 2026-09-24 13:46:28 local (2026-09-24T19:46:28.082000+00:00)
- duration: 7.0 min
- outcome: **OK**

## Session
- active farmer minutes: 5.75
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 20.88
- frozen seconds/hour: 2482.21
- longest freeze: 187.1s
- flip_flops/hour: 10.44
- distinct quest targets/hour: 10.44
- raw: {'freeze_count': 2, 'frozen_seconds_total': 237.7, 'flip_flop_count': 1, 'distinct_quest_targets': 1, 'active_farmer_basis_hours': 0.096}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 42.70
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.096, 'ground_damage_steps': 0, 'packet_span_hours': 0.114}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 94.49
- damage/1000 near passes: 9811.02
- share of hits with enemy within 3 tiles: 0.25
- raw: {'near_passes': 127, 'near_passes_approx': 35, 'near_passes_from_hits': 5, 'hits': 12, 'damage_total': 1246.0, 'shots_without_projdef': 100, 'shots_backfilled': 225, 'shots_unresolved': 85, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 43, 'hits': 4, 'hits_per_1000_near_passes': 93.02325581395348}}

## Auto Aim
- shots=1606 enemy_hits=1305 hits/shot=0.81 kills=348 kills/hour=3062.50 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (2)
### stall — travelling to central realm — 50.7s — 2026-09-24 13:42:15 local
- target/place: Level 20
- held 50.7s, budget 15.0s
- excerpt:
```
[19:42:15.438] [Script:farmer] [farmer] state: Level 20: travelling to central Realm | ctx pos=600.3,1438.3 goal=1024.0,1024.0 d=592.6 enemy=19.1 quest=-
[19:42:15.629] [DefenseCheck] DEFENSE(21)=18 == DLL memory 18 → stat 21 is EFFECTIVE; 'pd.defense + pd.defenseBonus' (27) double-counts. AutoNexus already uses the memory value.
[19:42:20.496] [Script:farmer] [farmer] state: Level 20: travelling to central Realm | ctx pos=618.5,1421.5 goal=1024.0,1024.0 d=567.8 enemy=4.0 quest=-
```

### flip_flop — beacon teleport <-> realm farmer: searching other beacon areas for purple white bosses — 187.1s — 2026-09-24 13:43:10 local
- target/place: Beach Beacon
- 31 alternations over 187.1s
- excerpt:
```
[19:43:10.374] [Script:farmer] [farmer] state: Beacon teleport → Beach Beacon (Rookie) | ctx pos=799.6,1232.2 goal=1024.0,1024.0 d=306.1 enemy=6.4 quest=-
[19:43:13.456] [Script:farmer] [farmer] Realm Farmer: teleport confirmed — moved 289 tiles to "Beach Beacon (Rookie)".
[19:43:13.460] [Script:farmer] [farmer] state: Realm Farmer: searching other beacon areas for purple/white bosses | ctx pos=605.5,1446.5 goal=686.5,1758.5 d=322.3 enemy=16.0 quest=-
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Beer God | approach | 53.4 | 3 | 1 | 0 | auto_nexus | needs_review |
| Beer God | transition | 3.1 | 0 | 0 | 0 | auto_nexus | needs_review |
| Beer God | approach | 23.6 | 15 | 3 | 0 | auto_nexus | needs_review |

## Deaths (0)
(none)
