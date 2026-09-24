# Test Lab session summary — 20260924T185705Z

- schema_version: 1
- version: **1.0.44**
- build: version=1.0.44 commit=b72f2a2 date=2026-09-24T18:57:05.083Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 12:57:05 local (2026-09-24T18:57:05.080000+00:00)
- end: 2026-09-24 13:06:07 local (2026-09-24T19:06:07.245000+00:00)
- duration: 9.0 min
- outcome: **OK**

## Session
- active farmer minutes: 7.78
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 38.57
- frozen seconds/hour: 783.71
- longest freeze: 43.7s
- flip_flops/hour: 23.14
- distinct quest targets/hour: 38.57
- raw: {'freeze_count': 5, 'frozen_seconds_total': 101.6, 'flip_flop_count': 3, 'distinct_quest_targets': 5, 'active_farmer_basis_hours': 0.13}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 86.32
- killers: (none)

## Navigation
- no_progress_walks/hour: 15.43
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 2, 'active_farmer_basis_hours': 0.13, 'ground_damage_steps': 0, 'packet_span_hours': 0.147}

## Dodge
- outcome: **OK**
- hits/1000 near passes: 70.12
- damage/1000 near passes: 7789.63
- share of hits with enemy within 3 tiles: 0.17
- raw: {'near_passes': 328, 'near_passes_approx': 94, 'near_passes_from_hits': 8, 'hits': 23, 'damage_total': 2555.0, 'shots_without_projdef': 77, 'shots_backfilled': 411, 'shots_unresolved': 28, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 165, 'hits': 12, 'hits_per_1000_near_passes': 72.72727272727272}, 'fighting': {'near_passes': 115, 'hits': 6, 'hits_per_1000_near_passes': 52.17391304347826}}

## Auto Aim
- shots=2806 enemy_hits=2930 hits/shot=1.04 kills=218 kills/hour=1481.90 **[LOW SPAN]**

## A/B experiments (1)
### udodgeEnemyStandoff — A='off' vs B='auto'
- blocks: 4, block_minutes=2, seed=1790276291318, ended_by_stop=True
- A: exposure=3.84min near_passes=135 hits=11 hits/1000np=81.48
- B: exposure=3.76min near_passes=184 hits=12 hits/1000np=65.22
- verdict: **INCONCLUSIVE (under-exposed)** (B-A diff 95% CI: [-0.08094566983328565, 0.041214906766728676])

## Freezes (5)
### flip_flop — loot detour <-> waiting for auto loot — 2.8s — 2026-09-24 13:00:39 local
- 7 alternations over 2.8s
- excerpt:
```
[19:00:39.772] [Script:farmer] [farmer] state: Loot detour (5.9 tiles) | ctx pos=1295.6,577.9 goal=1289.8,577.5 d=5.9 enemy=5.8 quest=225047
[19:00:40.849] [Script:farmer] [farmer] state: Loot detour (5.8 tiles) | ctx pos=1295.5,578.2 goal=1289.8,577.5 d=5.8 enemy=3.4 quest=225047
[19:00:41.617] [Script:farmer] [farmer] state: Waiting for Auto Loot | ctx pos=1290.0,577.8 goal=1289.8,577.5 d=0.4 enemy=5.1 quest=225047
```

### flip_flop — fighting <-> waiting through brief boss transition — 33.3s — 2026-09-24 13:01:35 local
- target/place: Skull Knight
- 5 alternations over 33.3s
- excerpt:
```
[19:01:35.123] [Script:farmer] [farmer] state: Fighting: Skull Knight | ctx pos=1161.8,1430.0 goal=1160.9,1436.3 d=6.3 enemy=2.6 quest=227034
[19:01:40.222] [Script:farmer] [farmer] state: Fighting: Skull Knight | ctx pos=1169.9,1428.0 goal=1160.9,1436.3 d=12.3 enemy=1.0 quest=227034
[19:01:44.244] [Script:farmer] [farmer] state: Skull Knight: waiting through brief boss transition | ctx pos=1173.6,1434.4 goal=1160.9,1436.3 d=12.8 enemy=3.2 quest=227034
```

### flip_flop — fighting <-> waiting through brief boss transition — 43.7s — 2026-09-24 13:03:04 local
- target/place: Skull Knight
- 7 alternations over 43.7s
- excerpt:
```
[19:03:04.049] [Script:farmer] [farmer] state: Fighting: Skull Knight | ctx pos=1160.7,1456.7 goal=1157.6,1437.4 d=19.5 enemy=3.2 quest=227034
[19:03:09.054] [Script:farmer] [farmer] state: Fighting: Skull Knight | ctx pos=1163.4,1453.8 goal=1157.6,1437.4 d=17.4 enemy=6.2 quest=227034
[19:03:13.072] [Script:farmer] [farmer] state: Skull Knight: waiting through brief boss transition | ctx pos=1160.3,1456.1 goal=1157.6,1437.4 d=18.9 enemy=6.6 quest=227034
```

### no_progress_walk — maxing: approach — 13.1s — 2026-09-24 13:05:05 local
- target/place: Ethereal Shrine
- dist_to_goal 15.2->11.3 tiles over 13.1s
- excerpt:
```
[19:05:05.597] [Script:farmer] [farmer] state: Maxing: Ethereal Shrine → (1249, 780) · 21 tiles | ctx pos=1243.3,800.7 goal=1244.8,785.6 d=15.2 enemy=4.5 quest=230558
[19:05:06.699] [Script:farmer] [farmer] state: Maxing: Ethereal Shrine → (1249, 780) · 25 tiles | ctx pos=1240.1,803.9 goal=1244.8,785.6 d=18.8 enemy=7.3 quest=230558
[19:05:07.792] [Script:farmer] [farmer] state: Maxing: Ethereal Shrine → (1249, 780) · 22 tiles | ctx pos=1237.5,799.2 goal=1244.8,785.6 d=15.4 enemy=7.6 quest=230558
```

### no_progress_walk — maxing: approach — 8.6s — 2026-09-24 13:05:42 local
- target/place: Skull Shrine
- dist_to_goal 13.7->14.1 tiles over 8.6s
- excerpt:
```
[19:05:42.398] [Script:farmer] [farmer] state: Maxing: Skull Shrine → (1405, 1232) · 20 tiles | ctx pos=1423.0,1222.8 goal=1409.9,1227.1 d=13.7 enemy=6.3 quest=230889
[19:05:43.399] [Script:farmer] [farmer] state: Maxing: Skull Shrine → (1405, 1232) · 19 tiles | ctx pos=1422.6,1226.0 goal=1409.9,1227.1 d=12.7 enemy=9.3 quest=230889
[19:05:44.478] [Script:farmer] [farmer] state: Maxing: Skull Shrine → (1405, 1232) · 16 tiles | ctx pos=1420.8,1228.4 goal=1409.9,1227.1 d=10.9 enemy=2.5 quest=230889
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Rock Dragon | approach | 52.4 | 8 | 0 | 0 | auto_nexus | needs_review |
| Rock Dragon | transition | 3.0 | 0 | 0 | 0 | auto_nexus | needs_review |
| Rock Dragon | approach | 48.5 | 44 | 5 | 0 | auto_nexus | needs_review |
| Ravenous Rot | approach | 16.3 | 2 | 1 | 0 | auto_nexus | needs_review |
| Ravenous Rot | loot | 2.9 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ravenous Rot | approach | 18.0 | 31 | 2 | 0 | auto_nexus | needs_review |
| Skull Knight | approach | 12.0 | 0 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 8.5 | 5 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.1 | 16 | 2 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.0 | 5 | 1 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.1 | 5 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.0 | 2 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.1 | 5 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 0.5 | 0 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | approach | 14.7 | 0 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 5.7 | 3 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.0 | 1 | 1 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.0 | 4 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.1 | 5 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.0 | 11 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.0 | 4 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 9.1 | 7 | 2 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 3.0 | 2 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 3.4 | 2 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 2.9 | 7 | 0 | 0 | auto_nexus | needs_review |
| Skull Knight | combat | 13.3 | 18 | 2 | 0 | auto_nexus | needs_review |
| Skull Knight | transition | 0.3 | 1 | 1 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | approach | 7.9 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | loot | 2.1 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | loot | 0.6 | 0 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | approach | 20.8 | 5 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | loot | 4.1 | 2 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | approach | 12.1 | 1 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | transition | 3.0 | 0 | 0 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | approach | 27.8 | 14 | 3 | 0 | auto_nexus | needs_review |
| Ethereal Shrine | transition | 1.9 | 4 | 1 | 0 | auto_nexus | needs_review |
| Skull Shrine | approach | 16.2 | 25 | 0 | 0 | disconnect | incomplete |
| Skull Shrine | combat | 8.1 | 31 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
