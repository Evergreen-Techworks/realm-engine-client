# Test Lab session summary — 20260924T201725Z

- schema_version: 1
- version: **1.0.47**
- build: version=1.0.47 commit=b4c3a58 date=2026-09-24T20:17:25.065Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 14:17:25 local (2026-09-24T20:17:25.062000+00:00)
- end: 2026-09-24 14:24:41 local (2026-09-24T20:24:41.339000+00:00)
- duration: 7.3 min
- outcome: **OK**

## Session
- active farmer minutes: 5.75
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 73.08
- frozen seconds/hour: 1136.23
- longest freeze: 53.8s
- flip_flops/hour: 20.88
- distinct quest targets/hour: 41.76
- raw: {'freeze_count': 7, 'frozen_seconds_total': 108.8, 'flip_flop_count': 2, 'distinct_quest_targets': 4, 'active_farmer_basis_hours': 0.096}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 49.51
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.096, 'ground_damage_steps': 0, 'packet_span_hours': 0.118}

## Dodge
- outcome: **OK**
- hits/1000 near passes: 84.80
- damage/1000 near passes: 5616.96
- share of hits with enemy within 3 tiles: 0.17
- raw: {'near_passes': 342, 'near_passes_approx': 4, 'near_passes_from_hits': 0, 'hits': 29, 'damage_total': 1921.0, 'shots_without_projdef': 42, 'shots_backfilled': 163, 'shots_unresolved': 14, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 93, 'hits': 12, 'hits_per_1000_near_passes': 129.03225806451613}, 'fighting': {'near_passes': 214, 'hits': 12, 'hits_per_1000_near_passes': 56.074766355140184}}

## Auto Aim
- shots=1952 enemy_hits=1497 hits/shot=0.77 kills=200 kills/hour=1699.32 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (7)
### stall — waiting for encounter visibility — 25.3s — 2026-09-24 14:20:09 local
- target/place: Stygian Mirror
- held 25.3s, budget 10.0s
- excerpt:
```
[20:20:09.601] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1412.5,1223.5 goal=1409.9,1227.1 d=4.4 enemy=16.6 quest=224331
[20:20:14.694] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1410.0,1226.8 goal=1409.9,1227.1 d=0.3 enemy=16.6 quest=224331
[20:20:19.724] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1410.0,1226.8 goal=1409.9,1227.1 d=0.3 enemy=17.4 quest=224331
```

### hard_freeze — waiting for encounter visibility — 20.2s — 2026-09-24 14:20:14 local
- target/place: Stygian Mirror
- position moved 0.00 tiles over 20.2s, no status change (ctx)
- excerpt:
```
[20:20:14.694] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1410.0,1226.8 goal=1409.9,1227.1 d=0.3 enemy=16.6 quest=224331
[20:20:19.724] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1410.0,1226.8 goal=1409.9,1227.1 d=0.3 enemy=17.4 quest=224331
[20:20:24.825] [Script:farmer] [farmer] state: Stygian Mirror: waiting for encounter visibility | ctx pos=1410.0,1226.8 goal=1409.9,1227.1 d=0.3 enemy=18.1 quest=224331
```

### flip_flop — waiting for adds or vulnerable boss <-> returning to boss area — 29.7s — 2026-09-24 14:21:01 local
- target/place: Possessed Pumpkin
- 9 alternations over 29.7s
- excerpt:
```
[20:21:01.331] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1520.2,1297.4 goal=1517.4,1293.9 d=4.5 enemy=4.0 quest=229737
[20:21:03.176] [Script:farmer] [farmer] state: Possessed Pumpkin: returning to boss area | ctx pos=1523.8,1298.7 goal=1520.4,1293.7 d=6.1 enemy=3.8 quest=229737
[20:21:03.278] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1522.9,1297.7 goal=1520.4,1293.7 d=4.7 enemy=2.7 quest=229737
```

### stall — waiting for adds or vulnerable boss — 25.3s — 2026-09-24 14:21:04 local
- target/place: Possessed Pumpkin
- held 25.3s, budget 10.0s
- excerpt:
```
[20:21:04.252] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1524.4,1298.1 goal=1520.3,1293.7 d=6.0 enemy=4.3 quest=229737
[20:21:09.330] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1524.2,1294.7 goal=1520.3,1293.7 d=4.1 enemy=7.2 quest=229737
[20:21:14.393] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1522.8,1294.8 goal=1520.3,1293.7 d=2.6 enemy=6.2 quest=229737
```

### hard_freeze — waiting for adds or vulnerable boss — 15.2s — 2026-09-24 14:21:14 local
- target/place: Possessed Pumpkin
- position moved 0.00 tiles over 15.2s, no status change (ctx)
- excerpt:
```
[20:21:14.393] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1522.8,1294.8 goal=1520.3,1293.7 d=2.6 enemy=6.2 quest=229737
[20:21:19.486] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1522.7,1294.7 goal=1520.3,1293.7 d=2.6 enemy=6.2 quest=229737
[20:21:24.575] [Script:farmer] [farmer] state: Possessed Pumpkin: waiting for adds or vulnerable boss | ctx pos=1522.8,1294.8 goal=1520.3,1293.7 d=2.6 enemy=6.2 quest=229737
```

### flip_flop — fighting <-> waiting through brief boss transition — 53.8s — 2026-09-24 14:23:01 local
- target/place: Skull Shrine
- 4 alternations over 53.8s
- excerpt:
```
[20:23:01.249] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1447.9,1272.7 goal=1449.8,1276.1 d=3.9 enemy=6.5 quest=231522
[20:23:06.304] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1447.6,1269.5 goal=1449.8,1276.1 d=7.0 enemy=11.3 quest=231522
[20:23:11.387] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1463.4,1283.5 goal=1449.8,1276.1 d=15.5 enemy=9.8 quest=231522
```

### stall — fighting — 45.8s — 2026-09-24 14:23:01 local
- target/place: Skull Shrine
- held 45.8s, budget 30.0s
- excerpt:
```
[20:23:01.249] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1447.9,1272.7 goal=1449.8,1276.1 d=3.9 enemy=6.5 quest=231522
[20:23:06.304] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1447.6,1269.5 goal=1449.8,1276.1 d=7.0 enemy=11.3 quest=231522
[20:23:11.387] [Script:farmer] [farmer] state: Fighting: Skull Shrine | ctx pos=1463.4,1283.5 goal=1449.8,1276.1 d=15.5 enemy=9.8 quest=231522
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Stygian Mirror | approach | 53.3 | 13 | 3 | 0 | target_changed | incomplete |
| Stygian Mirror | transition | 3.1 | 0 | 0 | 0 | target_changed | incomplete |
| Stygian Mirror | approach | 5.9 | 0 | 0 | 0 | target_changed | incomplete |
| Stygian Mirror | transition | 30.1 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 18.6 | 7 | 4 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 1.8 | 0 | 1 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 0.1 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 0.1 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 0.1 | 1 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 0.1 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 0.4 | 0 | 1 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 0.1 | 1 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 0.1 | 1 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 26.8 | 1 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 0.9 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 8.0 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | combat | 4.3 | 3 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 4.0 | 1 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | combat | 5.8 | 2 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 3.1 | 2 | 2 | 0 | target_changed | incomplete |
| Possessed Pumpkin | approach | 4.4 | 3 | 1 | 0 | target_changed | incomplete |
| Possessed Pumpkin | transition | 3.7 | 0 | 0 | 0 | target_changed | incomplete |
| Possessed Pumpkin | loot | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | approach | 9.7 | 14 | 3 | 0 | auto_nexus | needs_review |
| Skull Shrine | loot | 1.7 | 4 | 0 | 0 | auto_nexus | needs_review |
| Skull Shrine | approach | 5.9 | 17 | 0 | 0 | auto_nexus | needs_review |
| Skull Shrine | combat | 3.5 | 10 | 2 | 0 | auto_nexus | needs_review |
| Skull Shrine | approach | 14.2 | 7 | 1 | 0 | target_changed | incomplete |
| Skull Shrine | combat | 46.1 | 168 | 10 | 0 | target_changed | incomplete |
| Skull Shrine | transition | 1.9 | 4 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | combat | 3.8 | 12 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | transition | 2.0 | 5 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | combat | 1.9 | 1 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | loot | 10.1 | 20 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | transition | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| Eye of the Storm | approach | 12.8 | 1 | 1 | 0 | disconnect | incomplete |
| Eye of the Storm | loot | 3.5 | 2 | 0 | 0 | disconnect | incomplete |
| Eye of the Storm | approach | 7.9 | 6 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
