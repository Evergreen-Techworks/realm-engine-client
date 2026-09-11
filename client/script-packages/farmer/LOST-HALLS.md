# Lost Halls route implementation and sources

Two separate entries share `lost-halls-farmer.mjs` and `lost-halls-runner.mjs`: `lost-halls-void-farmer` and `lost-halls-cult-farmer`. The existing Oryx runner supplies terrain graph construction, short navigation steps and coordinated weapon targeting. Each Lost Halls route owns its own encounter state, expected portal, unlock handling and completion rules.

## Sources inspected

- User-supplied **Lost Halls** RealmEye PDF, September 7, 2026: pages 2–4 describe the variable 8/9-room grid, starting pillars, five pot rooms, treasure-room entrance from below and Defender/Colossus route; pages 7–8 describe bosses, vial access and three flames plus the 45-second Titan activation delay. The map on page 3 was inspected visually.
- User-supplied **The Void** PDF: pages 1–3 describe vial access, shrinking arena and two/four-sector splits. The page 2 map was inspected visually. The individual Void Entity attack guide is linked separately.
- User-supplied **Cultist Hideout** PDF: pages 1–4 describe the one-way trapdoor, narrow corridors, five cultists and required Molek/Balaam fights. Pages 6–7 describe disabling shots and the beam clue. The page 2 layout was inspected visually.
- [LostHalls/map-reading](https://github.com/LostHalls/map-reading/tree/fc342e75779638b25433f435624650186392e91f): inspected `mapreading.js` (`Room`, `calculateMainPath`, `findLoop`, `generate`, `createPots`) and beta generator code. The practice generator distinguishes start, pot, treasure and Defender endpoints, allows loops, reserves the Colossus area and constructs short side branches off a main path. It generates practice layouts; it does not read the game client's live map or supply world tile coordinates. Its main-path length must not be treated as a guaranteed live-game distance.

The implementation is original code using those structural observations, not a copy of the site's JavaScript, bundled assets or random map generator. There is no runtime network dependency.

## Routing decisions

Actual movement uses connected, observed non-damaging floor and static `blocksMovement` metadata. Unknown floor is explored rather than treated as walkable. Exploration tracks visited spatial sectors to avoid repeatedly selecting neighboring tiles in the same exhausted branch. These sectors are an implementation detail, not an inferred game room grid.

Void exploration favors outward progress while known Defender/Colossus objects override exploration. Cult exploration favors nearby side branches, pots and flames; Titan becomes the objective after three confirmed flame relocations or when the group has activated him. A teleported flame provides the treasure-room destination. Actual walls and corridors enforce the treasure room's entrance direction. This is heuristic exploration informed by the practice site's topology; it does not reconstruct the complete hidden room graph, calculate the site's exact room-count cutoffs or predict a seed.

Starting-pillar activation, walls, flames and special portals depend on recognized English game-data object names. Unknown objects are not guessed to be unlocks. A carried vial is used once, only after a confirmed Colossus death and beside the recorded clear location. Portal entry attempts are spaced three seconds apart. Optional entrance waits are bounded at two minutes. Boss disappearance alone never counts as a confirmed kill.

## Validation boundary

Tests cover separate branch selection, locked trapdoors, starting pillars, pot clearing, flame confirmation, group-activated Titan, vial use, archdemon priority, boss disappearance, clone completion, shrinking/split terrain connectivity, loot deadlines and package instantiation. They exercise the script control logic with SDK snapshots, not the live game server.

The supplied dungeon overviews link to separate attack guides. Exact MBC survival phases, Void Entity attack rotations and Cultist shot patterns are not available as reliable phase signals in the current SDK. These farmers coordinate navigation and basic combat with native Unified Dodge; they are not certified solo solvers or fully validated phase-specific encounter bots. Live runs are needed to verify name matching, unlock proximity, flame updates and survival behavior.
