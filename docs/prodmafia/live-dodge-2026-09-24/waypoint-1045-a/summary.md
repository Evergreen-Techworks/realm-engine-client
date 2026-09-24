# Test Lab session summary — 20260924T193119Z

- schema_version: 1
- version: **1.0.45**
- build: version=1.0.45 commit=26ec813 date=2026-09-24T19:31:19.356Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 13:31:19 local (2026-09-24T19:31:19.353000+00:00)
- end: 2026-09-24 13:38:22 local (2026-09-24T19:38:22.787000+00:00)
- duration: 7.1 min
- outcome: **OK**

## Session
- active farmer minutes: 5.74
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 52.27
- frozen seconds/hour: 1599.01
- longest freeze: 72.0s
- flip_flops/hour: 10.45
- distinct quest targets/hour: 31.36
- raw: {'freeze_count': 5, 'frozen_seconds_total': 153.0, 'flip_flop_count': 1, 'distinct_quest_targets': 3, 'active_farmer_basis_hours': 0.096}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 25.51
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.096, 'ground_damage_steps': 0, 'packet_span_hours': 0.114}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 73.30
- damage/1000 near passes: 6753.93
- share of hits with enemy within 3 tiles: 0.43
- raw: {'near_passes': 191, 'near_passes_approx': 23, 'near_passes_from_hits': 7, 'hits': 14, 'damage_total': 1290.0, 'shots_without_projdef': 113, 'shots_backfilled': 257, 'shots_unresolved': 57, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 56, 'hits': 5, 'hits_per_1000_near_passes': 89.28571428571429}, 'fighting': {'near_passes': 86, 'hits': 6, 'hits_per_1000_near_passes': 69.76744186046511}}

## Auto Aim
- shots=2120 enemy_hits=2082 hits/shot=0.98 kills=184 kills/hour=1610.87 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (5)
### flip_flop — fighting <-> waiting through brief boss transition — 72.0s — 2026-09-24 13:34:10 local
- target/place: Grand Sphinx
- 14 alternations over 72.0s
- excerpt:
```
[19:34:10.689] [Script:farmer] [farmer] state: Fighting: Grand Sphinx | ctx pos=1050.5,1208.7 goal=1054.4,1214.0 d=6.6 enemy=10.8 quest=219638
[19:34:15.710] [Script:farmer] [farmer] state: Fighting: Grand Sphinx | ctx pos=1056.8,1216.4 goal=1054.4,1214.6 d=3.0 enemy=4.1 quest=219638
[19:34:17.870] [Script:farmer] [farmer] state: Grand Sphinx: waiting through brief boss transition | ctx pos=1060.8,1213.9 goal=1054.4,1214.6 d=6.4 enemy=2.8 quest=219638
```

### stall — waiting for adds or vulnerable boss — 15.3s — 2026-09-24 13:36:29 local
- target/place: Pentaract
- held 15.3s, budget 10.0s
- excerpt:
```
[19:36:29.973] [Script:farmer] [farmer] state: Pentaract: waiting for adds or vulnerable boss | ctx pos=1665.9,1266.8 goal=1661.9,1263.7 d=5.0 enemy=4.6 quest=221240
[19:36:35.077] [Script:farmer] [farmer] state: Pentaract: waiting for adds or vulnerable boss | ctx pos=1658.2,1260.3 goal=1661.9,1263.7 d=5.0 enemy=3.8 quest=221240
[19:36:40.151] [Script:farmer] [farmer] state: Pentaract: waiting for adds or vulnerable boss | ctx pos=1658.4,1254.5 goal=1661.9,1263.7 d=9.9 enemy=3.0 quest=221240
```

### stall — waiting for encounter visibility — 25.2s — 2026-09-24 13:36:47 local
- target/place: Pentaract
- held 25.2s, budget 10.0s
- excerpt:
```
[19:36:47.342] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1656.0,1257.6 goal=1661.9,1263.7 d=8.5 enemy=10.7 quest=221240
[19:36:52.348] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1655.8,1258.2 goal=1661.9,1263.7 d=8.2 enemy=19.8 quest=221240
[19:36:57.431] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1655.8,1258.2 goal=1661.9,1263.7 d=8.2 enemy=19.9 quest=221240
```

### hard_freeze — waiting for encounter visibility — 20.2s — 2026-09-24 13:36:52 local
- target/place: Pentaract
- position moved 0.00 tiles over 20.2s, no status change (ctx)
- excerpt:
```
[19:36:52.348] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1655.8,1258.2 goal=1661.9,1263.7 d=8.2 enemy=19.8 quest=221240
[19:36:57.431] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1655.8,1258.2 goal=1661.9,1263.7 d=8.2 enemy=19.9 quest=221240
[19:37:02.464] [Script:farmer] [farmer] state: Pentaract: waiting for encounter visibility | ctx pos=1655.8,1258.2 goal=1661.9,1263.7 d=8.2 enemy=18.5 quest=221240
```

### stall — fighting — 40.5s — 2026-09-24 13:37:22 local
- target/place: Cube Deity
- held 40.5s, budget 30.0s
- excerpt:
```
[19:37:22.454] [Script:farmer] [farmer] state: Fighting: Cube Deity | ctx pos=1629.3,304.8 goal=1626.5,301.8 d=4.1 enemy=10.8 quest=225415
[19:37:27.469] [Script:farmer] [farmer] state: Fighting: Cube Deity | ctx pos=1630.7,301.0 goal=1626.9,301.3 d=3.8 enemy=6.1 quest=225415
[19:37:32.534] [Script:farmer] [farmer] state: Fighting: Cube Deity | ctx pos=1634.9,307.4 goal=1626.7,302.5 d=9.6 enemy=5.6 quest=225415
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Grand Sphinx | approach | 53.5 | 9 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 0 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | approach | 29.5 | 9 | 1 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 2.3 | 4 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 7.2 | 19 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 1 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 8.2 | 5 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 6 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 7.6 | 11 | 1 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 2.1 | 5 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 7.0 | 6 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 3 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 8.1 | 3 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 0 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 7.7 | 3 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 2.0 | 1 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 7.1 | 11 | 1 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 3.0 | 1 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | combat | 2.0 | 3 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | loot | 10.1 | 2 | 0 | 0 | target_changed | incomplete |
| Grand Sphinx | transition | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| Pentaract | approach | 42.8 | 26 | 4 | 0 | target_changed | incomplete |
| Pentaract | transition | 3.1 | 2 | 0 | 0 | target_changed | incomplete |
| Pentaract | approach | 6.3 | 0 | 0 | 0 | target_changed | incomplete |
| Pentaract | transition | 47.4 | 7 | 0 | 0 | target_changed | incomplete |
| Cube Deity | approach | 2.0 | 3 | 0 | 0 | auto_nexus | needs_review |
| Cube Deity | combat | 41.7 | 24 | 3 | 0 | auto_nexus | needs_review |
| Cube Deity | transition | 3.0 | 4 | 3 | 0 | auto_nexus | needs_review |
| Cube Deity | approach | 1.1 | 0 | 0 | 0 | auto_nexus | needs_review |
| Cube Deity | combat | 1.3 | 0 | 1 | 0 | auto_nexus | needs_review |

## Deaths (0)
(none)
