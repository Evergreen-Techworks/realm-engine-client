# Test Lab session summary — 20260924T180859Z

- schema_version: 1
- version: **1.0.44**
- build: version=1.0.44 commit=b72f2a2 date=2026-09-24T18:08:59.517Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 12:08:59 local (2026-09-24T18:08:59.514000+00:00)
- end: 2026-09-24 12:16:16 local (2026-09-24T18:16:16.982000+00:00)
- duration: 7.3 min
- outcome: **OK**

## Session
- active farmer minutes: 5.81
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 51.61
- frozen seconds/hour: 1238.50
- longest freeze: 39.8s
- flip_flops/hour: 41.29
- distinct quest targets/hour: 61.93
- raw: {'freeze_count': 5, 'frozen_seconds_total': 120.0, 'flip_flop_count': 4, 'distinct_quest_targets': 6, 'active_farmer_basis_hours': 0.097}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 24.69
- killers: (none)

## Navigation
- no_progress_walks/hour: 10.32
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 1, 'active_farmer_basis_hours': 0.097, 'ground_damage_steps': 0, 'packet_span_hours': 0.118}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 23.70
- damage/1000 near passes: 857.82
- share of hits with enemy within 3 tiles: 0.00
- raw: {'near_passes': 211, 'near_passes_approx': 10, 'near_passes_from_hits': 0, 'hits': 5, 'damage_total': 181.0, 'shots_without_projdef': 0, 'shots_backfilled': 14, 'shots_unresolved': 0, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'fighting': {'near_passes': 87, 'hits': 2, 'hits_per_1000_near_passes': 22.988505747126435}, 'walking': {'near_passes': 23, 'hits': 1, 'hits_per_1000_near_passes': 43.47826086956522}}

## Auto Aim
- shots=2256 enemy_hits=2627 hits/shot=1.16 kills=159 kills/hour=1347.38 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (5)
### flip_flop — loot detour <-> waiting for auto loot — 1.6s — 2026-09-24 12:10:56 local
- 6 alternations over 1.6s
- excerpt:
```
[18:10:56.717] [Script:farmer] [farmer] state: Loot detour (1.3 tiles) | ctx pos=940.3,1815.1 goal=940.6,1813.8 d=1.3 enemy=4.4 quest=215274
[18:10:57.266] [Script:farmer] [farmer] state: Waiting for Auto Loot | ctx pos=940.4,1814.4 goal=940.6,1813.8 d=0.7 enemy=4.3 quest=215274
[18:10:57.375] [Script:farmer] [farmer] state: Loot detour (2.0 tiles) | ctx pos=940.3,1815.7 goal=940.6,1813.8 d=2.0 enemy=4.5 quest=215274
```

### no_progress_walk — leveling: approach — 8.4s — 2026-09-24 12:11:19 local
- target/place: Ent Ancient
- dist_to_goal 84.1->84.6 tiles over 8.4s
- excerpt:
```
[18:11:19.342] [Script:farmer] [farmer] state: Leveling: Ent Ancient → (923, 1709) · 91 tiles | ctx pos=943.6,1797.6 goal=925.8,1715.4 d=84.1 enemy=9.3 quest=225226
[18:11:20.873] [Script:farmer] [farmer] state: Leveling: Ent Ancient → (923, 1709) · 92 tiles | ctx pos=943.8,1798.0 goal=926.0,1715.3 d=84.7 enemy=12.2 quest=225226
[18:11:21.913] [Script:farmer] [farmer] state: Leveling: Ent Ancient → (923, 1709) · 91 tiles | ctx pos=943.5,1797.9 goal=926.0,1715.3 d=84.4 enemy=15.1 quest=225226
```

### flip_flop — fighting <-> clearing adds — 34.8s — 2026-09-24 12:11:42 local
- target/place: Ent Ancient
- 6 alternations over 34.8s
- excerpt:
```
[18:11:42.878] [Script:farmer] [farmer] state: Fighting: Ent Ancient | ctx pos=911.5,1706.4 goal=916.6,1705.2 d=5.2 enemy=1.9 quest=225226
[18:11:45.366] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Black Bat | ctx pos=916.2,1704.6 goal=916.4,1705.2 d=0.5 enemy=4.2 quest=225226
[18:11:46.795] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Ent Sapling | ctx pos=916.5,1703.7 goal=918.2,1705.4 d=2.5 enemy=7.0 quest=225226
```

### flip_flop — fighting <-> clearing adds — 39.8s — 2026-09-24 12:13:00 local
- target/place: Ent Ancient
- 7 alternations over 39.8s
- excerpt:
```
[18:13:00.446] [Script:farmer] [farmer] state: Fighting: Ent Ancient | ctx pos=898.7,1617.3 goal=894.9,1614.3 d=4.9 enemy=8.2 quest=174989
[18:13:02.305] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Ent Sapling | ctx pos=894.7,1611.5 goal=894.9,1614.6 d=3.1 enemy=6.6 quest=174989
[18:13:03.825] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Ent | ctx pos=894.8,1610.8 goal=894.9,1614.6 d=3.8 enemy=7.4 quest=174989
```

### flip_flop — fighting <-> clearing adds — 35.4s — 2026-09-24 12:13:54 local
- target/place: Ent Ancient
- 6 alternations over 35.4s
- excerpt:
```
[18:13:54.438] [Script:farmer] [farmer] state: Fighting: Ent Ancient | ctx pos=875.2,1592.0 goal=874.5,1588.2 d=3.9 enemy=4.1 quest=175240
[18:13:58.324] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Dwarf Mage | ctx pos=875.5,1588.5 goal=875.6,1588.7 d=0.2 enemy=4.6 quest=175240
[18:13:59.061] [Script:farmer] [farmer] state: Ent Ancient: clearing adds — Ent | ctx pos=875.5,1588.5 goal=875.6,1588.7 d=0.2 enemy=6.5 quest=175240
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Horned Drake | approach | 14.6 | 0 | 0 | 0 | target_changed | incomplete |
| Horned Drake | combat | 3.8 | 2 | 0 | 0 | target_changed | incomplete |
| Horned Drake | loot | 1.9 | 1 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | approach | 8.5 | 1 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | approach | 17.0 | 0 | 0 | 0 | target_changed | kill_observed |
| Ent Ancient | transition | 3.0 | 0 | 0 | 0 | target_changed | kill_observed |
| Ent Ancient | approach | 11.1 | 0 | 0 | 0 | target_changed | kill_observed |
| Ent Ancient | combat | 38.8 | 45 | 1 | 0 | target_changed | kill_observed |
| Ent Ancient | transition | 1.4 | 3 | 0 | 0 | target_changed | kill_observed |
| Ent Ancient | combat | 4.3 | 2 | 0 | 0 | target_changed | kill_observed |
| Hunter Centaur | approach | 26.0 | 3 | 0 | 0 | target_changed | incomplete |
| Hunter Centaur | combat | 2.8 | 1 | 0 | 0 | target_changed | incomplete |
| Hunter Centaur | loot | 2.2 | 1 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | approach | 2.0 | 0 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | combat | 40.8 | 46 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | transition | 0.9 | 0 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | combat | 2.8 | 1 | 0 | 0 | target_changed | incomplete |
| Ent Ancient | approach | 9.5 | 3 | 0 | 0 | target_changed | kill_observed |
| Ent Ancient | combat | 36.1 | 37 | 2 | 0 | target_changed | kill_observed |
| Dark Elf Queen | approach | 10.1 | 3 | 0 | 0 | target_changed | incomplete |
| Dark Elf Queen | combat | 5.5 | 3 | 0 | 0 | target_changed | incomplete |
| Dark Elf Queen | approach | 9.1 | 4 | 0 | 0 | target_changed | incomplete |
| Dark Elf Queen | combat | 7.6 | 7 | 0 | 0 | target_changed | incomplete |
| Dark Elf Queen | approach | 10.3 | 12 | 1 | 0 | target_changed | incomplete |
| Dark Elf Queen | combat | 21.8 | 15 | 1 | 0 | target_changed | incomplete |
| Dark Elf Queen | loot | 7.5 | 1 | 0 | 0 | target_changed | incomplete |
| Phoenix Lord | approach | 0.4 | 0 | 0 | 0 | target_changed | incomplete |
| Phoenix Lord | transition | 3.0 | 0 | 0 | 0 | target_changed | incomplete |
| Phoenix Lord | approach | 10.9 | 1 | 0 | 0 | target_changed | incomplete |
| Phoenix Lord | combat | 9.3 | 14 | 0 | 0 | target_changed | incomplete |
| Celestial Sprite | approach | 1.5 | 0 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
