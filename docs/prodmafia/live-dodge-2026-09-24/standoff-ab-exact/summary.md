# Test Lab session summary — 20260924T190707Z

- schema_version: 1
- version: **1.0.44**
- build: version=1.0.44 commit=b72f2a2 date=2026-09-24T19:07:07.901Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 13:07:07 local (2026-09-24T19:07:07.898000+00:00)
- end: 2026-09-24 13:16:09 local (2026-09-24T19:16:09.948000+00:00)
- duration: 9.0 min
- outcome: **OK**

## Session
- active farmer minutes: 7.82
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 23.03
- frozen seconds/hour: 2736.57
- longest freeze: 210.3s
- flip_flops/hour: 15.35
- distinct quest targets/hour: 7.68
- raw: {'freeze_count': 3, 'frozen_seconds_total': 356.5, 'flip_flop_count': 2, 'distinct_quest_targets': 1, 'active_farmer_basis_hours': 0.13}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 33.21
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.13, 'ground_damage_steps': 0, 'packet_span_hours': 0.147}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 71.94
- damage/1000 near passes: 8345.32
- share of hits with enemy within 3 tiles: 0.40
- raw: {'near_passes': 139, 'near_passes_approx': 13, 'near_passes_from_hits': 2, 'hits': 10, 'damage_total': 1160.0, 'shots_without_projdef': 207, 'shots_backfilled': 231, 'shots_unresolved': 141, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 53, 'hits': 6, 'hits_per_1000_near_passes': 113.20754716981132}}

## Auto Aim
- shots=1798 enemy_hits=1459 hits/shot=0.81 kills=242 kills/hour=1643.91 **[LOW SPAN]**

## A/B experiments (1)
### udodgeEnemyStandoff — A='off' vs B='auto'
- blocks: 4, block_minutes=2, seed=1790276891944, ended_by_stop=True
- A: exposure=3.84min near_passes=82 hits=8 hits/1000np=97.56
- B: exposure=3.79min near_passes=50 hits=2 hits/1000np=40.00
- verdict: **INCONCLUSIVE (under-exposed)** (B-A diff 95% CI: [-0.14576235091503226, 0.048202401899714205])

## Freezes (3)
### stall — travelling to central realm — 35.4s — 2026-09-24 13:09:53 local
- target/place: Level 20
- held 35.4s, budget 15.0s
- excerpt:
```
[19:09:53.341] [Script:farmer] [farmer] state: Level 20: travelling to central Realm | ctx pos=708.9,1433.5 goal=1024.0,1024.0 d=516.7 enemy=13.6 quest=-
[19:09:58.345] [Script:farmer] [farmer] state: Level 20: travelling to central Realm | ctx pos=727.8,1414.3 goal=1024.0,1024.0 d=489.9 enemy=19.5 quest=-
[19:10:03.434] [Script:farmer] [farmer] state: Level 20: travelling to central Realm | ctx pos=750.5,1391.7 goal=1024.0,1024.0 d=458.3 enemy=12.0 quest=-
```

### flip_flop — beacon teleport <-> realm farmer: searching other beacon areas for purple white bosses — 110.8s — 2026-09-24 13:10:33 local
- target/place: Undead Forest Beacon
- 18 alternations over 110.8s
- excerpt:
```
[19:10:33.807] [Script:farmer] [farmer] state: Beacon teleport → Undead Forest Beacon (Rookie) | ctx pos=863.9,1285.4 goal=1024.0,1024.0 d=306.5 enemy=3.8 quest=-
[19:10:36.892] [Script:farmer] [farmer] Realm Farmer: teleport confirmed — moved 244 tiles to "Undead Forest Beacon (Rookie)".
[19:10:36.896] [Script:farmer] [farmer] state: Realm Farmer: searching other beacon areas for purple/white bosses | ctx pos=671.5,1435.5 goal=605.5,1446.5 d=66.9 enemy=270.8 quest=-
```

### flip_flop — realm farmer: searching other beacon areas for purple white bosses <-> beacon teleport — 210.3s — 2026-09-24 13:12:30 local
- target/place: Deep Sea Abyss Beacon
- 34 alternations over 210.3s
- excerpt:
```
[19:12:30.627] [Script:farmer] [farmer] state: Realm Farmer: searching other beacon areas for purple/white bosses | ctx pos=1081.4,146.6 goal=1072.5,151.5 d=10.1 enemy=15.5 quest=-
[19:12:35.719] [Script:farmer] [farmer] state: Realm Farmer: searching other beacon areas for purple/white bosses | ctx pos=1061.1,163.7 goal=378.5,951.5 d=1042.4 enemy=2.8 quest=-
[19:12:36.918] [Script:farmer] [farmer] Realm Farmer: beacon TP -> "Deep Sea Abyss Beacon (Veteran)" #174988 · me->goal 1036, target->goal 0 (saves 1036)
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Ethereal Shrine | approach | 51.5 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | transition | 3.0 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | approach | 19.0 | 33 | 6 | 0 | auto_nexus | needs_review |

## Deaths (0)
(none)
