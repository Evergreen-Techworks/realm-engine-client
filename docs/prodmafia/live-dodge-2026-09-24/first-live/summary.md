# Test Lab session summary — 20260924T180008Z

- schema_version: 1
- version: **1.0.44**
- build: version=1.0.44 commit=b72f2a2 date=2026-09-24T18:00:08.491Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 12:00:08 local (2026-09-24T18:00:08.488000+00:00)
- end: 2026-09-24 12:07:19 local (2026-09-24T18:07:19.989000+00:00)
- duration: 7.2 min
- outcome: **OK**

## Session
- active farmer minutes: 5.82
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 41.27
- frozen seconds/hour: 1035.49
- longest freeze: 65.9s
- flip_flops/hour: 20.64
- distinct quest targets/hour: 103.18
- raw: {'freeze_count': 4, 'frozen_seconds_total': 100.4, 'flip_flop_count': 2, 'distinct_quest_targets': 10, 'active_farmer_basis_hours': 0.097}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 41.71
- killers: (none)

## Navigation
- no_progress_walks/hour: 20.64
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 2, 'active_farmer_basis_hours': 0.097, 'ground_damage_steps': 0, 'packet_span_hours': 0.116}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 139.18
- damage/1000 near passes: 2773.20
- share of hits with enemy within 3 tiles: 0.81
- raw: {'near_passes': 194, 'near_passes_approx': 4, 'near_passes_from_hits': 1, 'hits': 27, 'damage_total': 538.0, 'shots_without_projdef': 9, 'shots_backfilled': 118, 'shots_unresolved': 8, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'fighting': {'near_passes': 87, 'hits': 17, 'hits_per_1000_near_passes': 195.40229885057474}, 'walking': {'near_passes': 65, 'hits': 10, 'hits_per_1000_near_passes': 153.84615384615387}}

## Auto Aim
- shots=1640 enemy_hits=1359 hits/shot=0.83 kills=231 kills/hour=1990.96 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (4)
### flip_flop — leveling: approach <-> fighting — 65.9s — 2026-09-24 12:01:52 local
- target/place: Scorpion Queen
- 9 alternations over 65.9s
- excerpt:
```
[18:01:52.345] [Script:farmer] [farmer] state: Leveling: Scorpion Queen → (1015, 1885) · 131 tiles | ctx pos=884.9,1874.5 goal=1008.3,1884.7 d=123.8 enemy=12.9 quest=236917
[18:01:53.437] [Script:farmer] [farmer] state: Leveling: Scorpion Queen → (1015, 1885) · 126 tiles | ctx pos=889.7,1875.5 goal=1008.3,1884.7 d=119.0 enemy=15.8 quest=236917
[18:01:54.503] [Script:farmer] [farmer] state: Leveling: Scorpion Queen → (1015, 1885) · 120 tiles | ctx pos=895.7,1875.9 goal=1008.3,1884.7 d=113.0 enemy=18.7 quest=236917
```

### no_progress_walk — leveling: approach — 9.8s — 2026-09-24 12:03:30 local
- target/place: Dwarf King
- dist_to_goal 35.1->39.8 tiles over 9.8s
- excerpt:
```
[18:03:30.530] [Script:farmer] [farmer] state: Leveling: Dwarf King → (1090, 1760) · 42 tiles | ctx pos=1072.6,1798.7 goal=1087.5,1766.9 d=35.1 enemy=1.9 quest=236880
[18:03:31.622] [Script:farmer] [farmer] state: Leveling: Dwarf King → (1089, 1760) · 44 tiles | ctx pos=1070.2,1799.3 goal=1087.1,1766.5 d=36.9 enemy=4.3 quest=236880
[18:03:32.622] [Script:farmer] [farmer] state: Leveling: Dwarf King → (1089, 1760) · 45 tiles | ctx pos=1070.3,1800.3 goal=1087.1,1766.5 d=37.7 enemy=3.7 quest=236880
```

### no_progress_walk — loot detour — 11.0s — 2026-09-24 12:05:21 local
- dist_to_goal 8.8->22.5 tiles over 11.0s
- excerpt:
```
[18:05:21.633] [Script:farmer] [farmer] state: Loot detour (8.8 tiles) | ctx pos=810.7,1692.1 goal=819.5,1692.5 d=8.8 enemy=4.1 quest=236873
[18:05:22.711] [Script:farmer] [farmer] state: Loot detour (11.3 tiles) | ctx pos=808.4,1690.5 goal=819.5,1692.5 d=11.3 enemy=2.8 quest=236873
[18:05:23.805] [Script:farmer] [farmer] state: Loot detour (9.2 tiles) | ctx pos=811.0,1696.0 goal=819.5,1692.5 d=9.2 enemy=5.0 quest=236873
```

### flip_flop — leveling: approach <-> loot detour — 13.7s — 2026-09-24 12:05:33 local
- target/place: Great Coil Snake
- 4 alternations over 13.7s
- excerpt:
```
[18:05:33.512] [Script:farmer] [farmer] state: Leveling: Great Coil Snake → (816, 1693) · 26 tiles | ctx pos=827.4,1716.5 goal=819.0,1699.6 d=18.9 enemy=11.2 quest=165157
[18:05:34.517] [Script:farmer] [farmer] state: Leveling: Great Coil Snake → (817, 1693) · 26 tiles | ctx pos=828.6,1716.4 goal=820.0,1699.6 d=18.9 enemy=16.4 quest=165157
[18:05:35.603] [Script:farmer] [farmer] state: Leveling: Great Coil Snake → (817, 1693) · 24 tiles | ctx pos=822.4,1716.5 goal=820.2,1699.1 d=17.5 enemy=10.4 quest=165157
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Bandit Leader | approach | 10.5 | 0 | 0 | 0 | target_changed | incomplete |
| Scorpion Queen | approach | 23.3 | 0 | 0 | 0 | target_changed | incomplete |
| Elf Wizard | approach | 2.9 | 0 | 0 | 0 | target_changed | kill_observed |
| Elf Wizard | combat | 4.1 | 8 | 1 | 0 | target_changed | kill_observed |
| Scorpion Queen | approach | 3.3 | 1 | 0 | 0 | target_changed | kill_observed |
| Scorpion Queen | combat | 2.4 | 0 | 0 | 0 | target_changed | kill_observed |
| Bandit Leader | approach | 2.6 | 0 | 0 | 0 | target_changed | incomplete |
| Bandit Leader | combat | 2.8 | 0 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | approach | 4.6 | 0 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | combat | 2.4 | 0 | 0 | 0 | target_changed | incomplete |
| Elf Wizard | approach | 7.9 | 1 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | approach | 9.7 | 6 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | combat | 4.9 | 0 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | approach | 1.6 | 0 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | combat | 1.9 | 0 | 0 | 0 | target_changed | incomplete |
| Hobbit Mage | approach | 3.1 | 0 | 0 | 0 | target_changed | incomplete |
| Elf Wizard | approach | 3.3 | 0 | 0 | 0 | target_changed | kill_observed |
| Elf Wizard | combat | 2.7 | 2 | 0 | 0 | target_changed | kill_observed |
| Elf Wizard | approach | 5.1 | 1 | 0 | 0 | target_changed | incomplete |
| Elf Wizard | combat | 2.9 | 3 | 0 | 0 | target_changed | incomplete |
| Dwarf King | approach | 21.8 | 6 | 1 | 0 | auto_nexus | needs_review |
| Dwarf King | loot | 10.8 | 15 | 7 | 0 | auto_nexus | needs_review |
| Sandsman King | combat | 1.7 | 0 | 0 | 0 | target_changed | kill_observed |
| Sandsman King | approach | 8.1 | 1 | 0 | 0 | target_changed | incomplete |
| Dwarf King | approach | 8.7 | 6 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | combat | 9.1 | 5 | 0 | 0 | target_changed | kill_observed |
| Gray Satellite | transition | 3.1 | 0 | 0 | 0 | target_changed | kill_observed |
| Gray Satellite | combat | 1.1 | 1 | 0 | 0 | target_changed | kill_observed |
| Gray Satellite | combat | 7.7 | 3 | 1 | 0 | target_changed | incomplete |
| Gray Satellite | transition | 3.0 | 1 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | approach | 3.0 | 0 | 0 | 0 | target_changed | incomplete |
| Horned Drake | approach | 0.3 | 0 | 0 | 0 | target_changed | incomplete |
| Horned Drake | combat | 7.7 | 15 | 2 | 0 | target_changed | incomplete |
| Horned Drake | loot | 15.1 | 8 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | approach | 8.2 | 1 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | loot | 2.6 | 0 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | approach | 1.2 | 0 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | loot | 1.6 | 0 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | approach | 0.2 | 0 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | combat | 0.2 | 0 | 0 | 0 | target_changed | incomplete |
| Gray Satellite | loot | 12.7 | 4 | 1 | 0 | target_changed | incomplete |
| Gray Satellite | approach | 3.1 | 0 | 0 | 0 | target_changed | incomplete |
| Lich | approach | 3.0 | 0 | 0 | 0 | target_changed | incomplete |
| Warrior Bee | approach | 2.3 | 0 | 0 | 0 | target_changed | kill_observed |
| Warrior Bee | combat | 13.8 | 4 | 0 | 0 | target_changed | kill_observed |
| Warrior Bee | loot | 7.8 | 0 | 0 | 0 | target_changed | kill_observed |
| Lich | approach | 4.7 | 0 | 0 | 0 | disconnect | incomplete |
| Lich | combat | 26.0 | 40 | 1 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
