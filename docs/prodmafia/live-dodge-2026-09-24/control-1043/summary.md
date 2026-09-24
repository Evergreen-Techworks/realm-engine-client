# Test Lab session summary — 20260924T181737Z

- schema_version: 1
- version: **1.0.43**
- build: version=1.0.43 commit=a52ea76 date=2026-09-24T18:17:37.483Z source=marker
- log source: `/mnt/c/realm-engine-testlab/rig/RE_ASSETS/realm-engine-proxy.log`
- start: 2026-09-24 12:17:37 local (2026-09-24T18:17:37.479000+00:00)
- end: 2026-09-24 12:24:54 local (2026-09-24T18:24:54.065000+00:00)
- duration: 7.3 min
- outcome: **OK**

## Session
- active farmer minutes: 5.74
- maps visited (2): Nexus, Realm of the Mad God
- packet recording coverage: 100.00%

## Script (Realm Farmer)
- freezes/hour: 20.91
- frozen seconds/hour: 189.11
- longest freeze: 13.3s
- flip_flops/hour: 20.91
- distinct quest targets/hour: 41.82
- raw: {'freeze_count': 2, 'frozen_seconds_total': 18.1, 'flip_flop_count': 2, 'distinct_quest_targets': 4, 'active_farmer_basis_hours': 0.096}

## Survival
- deaths/hour: 0.00
- disconnects/hour: 57.72
- killers: (none)

## Navigation
- no_progress_walks/hour: 0.00
- ground_damage_steps/hour (target 0): 0.00
- raw: {'no_progress_walk_count': 0, 'active_farmer_basis_hours': 0.096, 'ground_damage_steps': 0, 'packet_span_hours': 0.117}

## Dodge
- outcome: **INCONCLUSIVE**
- hits/1000 near passes: 70.67
- damage/1000 near passes: 4756.18
- share of hits with enemy within 3 tiles: 0.50
- raw: {'near_passes': 283, 'near_passes_approx': 71, 'near_passes_from_hits': 5, 'hits': 20, 'damage_total': 1346.0, 'shots_without_projdef': 84, 'shots_backfilled': 170, 'shots_unresolved': 74, 'missing_projdef_pairs': [], 'min_near_passes': 300}
- by farmer context: {'walking': {'near_passes': 75, 'hits': 3, 'hits_per_1000_near_passes': 40.0}, 'fighting': {'near_passes': 153, 'hits': 16, 'hits_per_1000_near_passes': 104.57516339869281}}

## Auto Aim
- shots=2162 enemy_hits=1980 hits/shot=0.92 kills=114 kills/hour=971.92 **[LOW SPAN]**

## A/B experiments (0)
(none recorded)

## Freezes (2)
### flip_flop — loot detour <-> waiting for auto loot — 4.8s — 2026-09-24 12:21:43 local
- 12 alternations over 4.8s
- excerpt:
```
[18:21:43.877] [Script:farmer] [farmer] state: Loot detour (1.0 tiles) | ctx pos=1312.8,1493.7 goal=1313.4,1493.0 d=1.0 enemy=2.1 quest=176642
[18:21:44.955] [Script:farmer] [farmer] state: Loot detour (3.1 tiles) | ctx pos=1310.7,1494.5 goal=1313.4,1493.0 d=3.1 enemy=0.1 quest=176642
[18:21:46.038] [Script:farmer] [farmer] state: Loot detour (2.6 tiles) | ctx pos=1310.8,1493.0 goal=1313.4,1493.0 d=2.6 enemy=2.2 quest=176642
```

### flip_flop — waiting for adds or vulnerable boss <-> returning to boss area — 13.3s — 2026-09-24 12:24:33 local
- target/place: Towering Perfection
- 12 alternations over 13.3s
- excerpt:
```
[18:24:33.393] [Script:farmer] [farmer] state: Towering Perfection: waiting for adds or vulnerable boss | ctx pos=1646.8,1558.9 goal=1645.7,1561.3 d=2.7 enemy=8.3 quest=282676
[18:24:34.601] [Script:farmer] [farmer] state: Towering Perfection: returning to boss area | ctx pos=1645.1,1559.6 goal=1641.0,1564.8 d=6.6 enemy=6.7 quest=282676
[18:24:35.473] [Script:farmer] [farmer] state: Towering Perfection: waiting for adds or vulnerable boss | ctx pos=1643.2,1560.7 goal=1639.9,1565.7 d=6.0 enemy=5.9 quest=282676
```

## Boss encounters

Estimated avoided threats exclude unsupported shot geometry. Ground contacts are not measured HP loss.

| Boss | Phase | Seconds | Estimated avoided | Hits | Ground contacts | Outcome | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| Cosmic Sprite | approach | 51.4 | 14 | 2 | 0 | auto_nexus | needs_review |
| Cosmic Sprite | transition | 3.1 | 1 | 0 | 0 | auto_nexus | needs_review |
| Cosmic Sprite | loot | 1.3 | 0 | 0 | 0 | auto_nexus | needs_review |
| Cosmic Sprite | approach | 21.0 | 6 | 0 | 0 | auto_nexus | needs_review |
| Cosmic Sprite | combat | 15.1 | 23 | 4 | 0 | auto_nexus | needs_review |
| Cosmic Sprite | approach | 1.2 | 0 | 0 | 0 | target_changed | kill_observed |
| Cosmic Sprite | loot | 5.0 | 0 | 0 | 0 | target_changed | kill_observed |
| Cosmic Sprite | approach | 13.7 | 0 | 0 | 0 | target_changed | kill_observed |
| Cosmic Sprite | combat | 13.0 | 24 | 6 | 0 | target_changed | kill_observed |
| Cosmic Sprite | loot | 4.9 | 10 | 0 | 0 | target_changed | kill_observed |
| Maze Minotaur | approach | 19.0 | 29 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | transition | 8.2 | 0 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | approach | 0.1 | 0 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | combat | 13.1 | 23 | 1 | 0 | target_changed | incomplete |
| Maze Minotaur | transition | 2.0 | 4 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | combat | 10.4 | 19 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | transition | 3.1 | 0 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | approach | 1.2 | 0 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | transition | 0.8 | 0 | 0 | 0 | target_changed | incomplete |
| Maze Minotaur | combat | 5.0 | 10 | 1 | 0 | target_changed | incomplete |
| Maze Minotaur | transition | 11.2 | 4 | 1 | 0 | target_changed | incomplete |
| Maze Minotaur | loot | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | combat | 1.4 | 5 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | transition | 1.9 | 9 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | combat | 1.2 | 1 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | loot | 10.0 | 9 | 0 | 0 | target_changed | incomplete |
| Skull Shrine | transition | 0.0 | 0 | 0 | 0 | target_changed | incomplete |
| Artificial Slop | approach | 23.3 | 13 | 1 | 0 | auto_nexus | needs_review |
| Artificial Slop | transition | 3.0 | 0 | 0 | 0 | auto_nexus | needs_review |
| Artificial Slop | approach | 5.4 | 2 | 0 | 0 | auto_nexus | needs_review |
| Artificial Slop | combat | 10.1 | 21 | 2 | 0 | auto_nexus | needs_review |
| Artificial Slop | transition | 1.0 | 3 | 0 | 0 | auto_nexus | needs_review |
| Artificial Slop | combat | 4.2 | 0 | 2 | 0 | auto_nexus | needs_review |
| Towering Perfection | approach | 4.7 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 1.2 | 2 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 0.9 | 2 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 0.8 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 0.1 | 1 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 0.1 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 0.8 | 3 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 0.9 | 1 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 0.7 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 0.1 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 0.1 | 0 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 6.5 | 14 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | approach | 1.1 | 2 | 0 | 0 | disconnect | incomplete |
| Towering Perfection | transition | 1.0 | 0 | 0 | 0 | disconnect | incomplete |

## Deaths (0)
(none)
