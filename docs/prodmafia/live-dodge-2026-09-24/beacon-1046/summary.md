# Test Lab session summary — 20260924T195643Z

- schema_version: 1
- version: **1.0.46**
- build: version=1.0.46 commit=c78cbcf date=2026-09-24T19:56:43.994Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 13:56:43 local (2026-09-24T19:56:43.990000+00:00)
- end: 2026-09-24 14:03:45 local (2026-09-24T20:03:45.729000+00:00)
- duration: 7.0 min
- outcome: **OK**

## Session
- active farmer minutes: 5.74
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 31.33
- frozen seconds/hour: 640.50
- longest freeze: 26.6s
- flip_flops/hour: 20.89
- distinct quest targets/hour: 10.44
- raw: {'freeze_count': 3, 'frozen_seconds_total': 61.3, 'flip_flop_count': 2, 'distinct_quest_targets': 1, 'active_farmer_basis_hours': 0.096}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 102.43
- killers: (none)

## Navigation
- no_progress_walks/hour: 10.44
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 1, 'active_farmer_basis_hours': 0.096, 'ground_damage_steps': 0, 'packet_span_hours': 0.114}

## Dodge
- outcome: **OK**
- hits/1000 near passes: 69.65
- damage/1000 near passes: 5288.56
- share of hits with enemy within 3 tiles: 0.61
- raw: {'near_passes': 402, 'near_passes_approx': 33, 'near_passes_from_hits': 0, 'hits': 28, 'damage_total': 2126.0, 'shots_without_projdef': 242, 'shots_backfilled': 1006, 'shots_unresolved': 198, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 323, 'hits': 26, 'hits_per_1000_near_passes': 80.49535603715171}}

## Auto Aim
- shots=1996 enemy_hits=1834 hits/shot=0.92 kills=129 kills/hour=1132.92 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (3)
### flip_flop — maxing: approach <-> player teleport — 26.6s — 2026-09-24 14:01:41 local
- target/place: Legion General
- 4 alternations over 26.6s
- excerpt:
```
[20:01:41.116] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 194 tiles | ctx pos=1291.5,1038.5 goal=1145.5,1155.6 d=187.2 enemy=21.6 quest=207443
[20:01:42.188] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 191 tiles | ctx pos=1289.1,1040.9 goal=1145.5,1155.6 d=183.9 enemy=24.2 quest=207443
[20:01:43.270] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 186 tiles | ctx pos=1285.4,1044.6 goal=1145.5,1155.6 d=178.7 enemy=18.1 quest=207443
```

### flip_flop — waiting for adds or vulnerable boss <-> returning to boss area — 25.7s — 2026-09-24 14:02:39 local
- target/place: Legion General
- 7 alternations over 25.7s
- excerpt:
```
[20:02:39.846] [Script:farmer] [farmer] state: Legion General: waiting for adds or vulnerable boss | ctx pos=1159.9,1160.5 goal=935.5,1890.5 d=763.7 enemy=4.2 quest=207443
[20:02:44.857] [Script:farmer] [farmer] state: Legion General: waiting for adds or vulnerable boss | ctx pos=1159.1,1155.3 goal=935.5,1890.5 d=768.5 enemy=3.4 quest=207443
[20:02:44.966] [Script:farmer] [farmer] state: Legion General: returning to boss area | ctx pos=1159.5,1155.3 goal=1153.8,1158.0 d=6.3 enemy=3.8 quest=207443
```

### no_progress_walk — maxing: approach — 9.1s — 2026-09-24 14:03:09 local
- target/place: Legion General
- dist_to_goal 8.6->19.1 tiles over 9.1s
- excerpt:
```
[20:03:09.911] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 16 tiles | ctx pos=1149.5,1172.5 goal=1144.2,1165.6 d=8.6 enemy=1.9 quest=207443
[20:03:11.424] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 17 tiles | ctx pos=1148.2,1174.9 goal=1144.2,1165.6 d=10.1 enemy=3.0 quest=207443
[20:03:12.489] [Script:farmer] [farmer] state: Maxing: Legion General → (1140, 1160) · 20 tiles | ctx pos=1149.7,1177.5 goal=1144.2,1165.6 d=13.1 enemy=1.7 quest=207443
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Legion General | approach | 53.4 | 7 | 1 | 0 | auto_nexus | needs_review |
| Legion General | transition | 3.0 | 1 | 0 | 0 | auto_nexus | needs_review |
| Legion General | approach | 31.3 | 72 | 10 | 0 | auto_nexus | needs_review |
| Legion General | approach | 47.1 | 80 | 4 | 0 | auto_nexus | needs_review |
| Legion General | approach | 37.6 | 18 | 1 | 0 | auto_nexus | needs_review |
| Legion General | loot | 1.6 | 10 | 1 | 0 | auto_nexus | needs_review |
| Legion General | approach | 9.2 | 0 | 0 | 0 | auto_nexus | needs_review |
| Legion General | transition | 3.1 | 2 | 0 | 0 | auto_nexus | needs_review |
| Legion General | approach | 9.1 | 2 | 1 | 0 | auto_nexus | needs_review |
| Legion General | transition | 3.0 | 4 | 0 | 0 | auto_nexus | needs_review |
| Legion General | approach | 2.6 | 6 | 0 | 0 | auto_nexus | needs_review |
| Legion General | loot | 6.4 | 7 | 0 | 0 | auto_nexus | needs_review |
| Legion General | approach | 13.1 | 28 | 5 | 0 | auto_nexus | needs_review |
| Legion General | transition | 5.1 | 11 | 1 | 0 | disconnect | incomplete |
| Legion General | approach | 0.2 | 0 | 0 | 0 | disconnect | incomplete |
| Legion General | transition | 1.6 | 2 | 0 | 0 | disconnect | incomplete |
| Legion General | approach | 0.8 | 2 | 0 | 0 | disconnect | incomplete |
| Legion General | transition | 2.4 | 0 | 0 | 0 | disconnect | incomplete |
| Legion General | approach | 0.3 | 1 | 0 | 0 | disconnect | incomplete |
| Legion General | transition | 0.1 | 0 | 0 | 0 | disconnect | incomplete |
| Legion General | approach | 28.7 | 30 | 2 | 0 | disconnect | incomplete |
| Legion General | loot | 2.5 | 3 | 1 | 0 | disconnect | incomplete |
| Legion General | approach | 0.3 | 0 | 0 | 0 | disconnect | incomplete |
| Legion General | transition | 6.3 | 4 | 0 | 0 | disconnect | incomplete |
| Legion General | approach | 0.9 | 1 | 0 | 0 | disconnect | incomplete |
| Legion General | transition | 7.2 | 4 | 0 | 0 | disconnect | incomplete |
| Legion General | approach | 2.7 | 5 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
