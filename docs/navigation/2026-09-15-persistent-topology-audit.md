# Persistent topology audit, 2026-09-15

Candidate audited: `/home/jesse/rec-worktrees/private-candidate-20260915` at `9cdc818`.
Tests and this report live on `investigate/persistent-map-corners`, worktree
`/home/jesse/rec-worktrees/persistent-map-corners`. Production behavior is unchanged.
No Windows, production-service or owner-checkout files changed.

## Confirmed behavior

- `client/src/state/GameWorldState.ts:118,258,304` retains UPDATE ground tile types for the map, clears on MAPINFO, and does not evict ground on entity drops. SDK `Tiles.getAll` exposes this retained ground through `client/src/scripts/bridge/world/tiles/Tiles.ts:101`.
- `internal/src/gui/tabs/WorldTAB.cpp:787` reads the game's accumulated received-square list. `SquareCoordCache` retains pointers/coordinates, not terrain topology, and restores older terrain when the player walks back into its window.
- `WorldTAB.cpp:586,810` limits copied terrain to +/-128 tiles during ordinary movement. `RebuildBlockedMap:142,215` replaces the entire flags/speed map with that local copy. Beyond-window previously explored topology is not available to native movement.
- The World-tab/detail/fallback path also has a newest-MAX_TILES cap. A full persistent-map initializer must not inherit this cap.
- `UDodgeTypes.h:525` and `UDodge.cpp:479` supply a 145x145 (radius72) navigation raster; `UDodgePathfinder.cpp:1061` routes only inside it and clamps distant goals. It cannot choose a globally informed detour even if the +/-128 capture were enlarged.
- `WorldTAB.cpp:181` folds currently enumerated object blockers into terrain flags. The live entity enumeration is capped at 4096. Disappearing objects are absent next rebuild. Persisting this merged byte indefinitely would preserve stale destructibles, doors, spikes and mobile occupancy.
- `FeatureCommandRegistry.cpp:141` receives a reset on HELLO, currently notifying PlayerCollider and AutoFire. `UDodge.cpp:629` resets the route/worker on OnEnter. Neither owns persistent topology or a map-generation stamp today.
- Stage1 changes collision, speed and lock liveness. Stage2 MapMemory/Router/NavigationOwner and Stage3 ring behavior remain absent. The repository has the Stage2 design in spec section4.2, but no separate executable Stage2 plan.

## Executed reproducer

`internal/tests/nav_global_route_reproducer.cpp` compiles the production `UDodgeCore.cpp`, `UDodgeSolver.cpp` and `UDodgePathfinder.cpp` with the same timing shim as the host test runner.

Completely known map:256x512. Wall at x120, y0..280. Player(100.5,200.5), goal(140.5,200.5). The only opening is south, at y281.5. Three segments of that route pass production Collision::StepClear. The current local navigator returns a NORTHWARD partial route to(119.5,128.5), first step(103.05,197.95), 13340 expanded cells. This is evidence of a wrong initial global choice, not a claim that an in-game run was reproduced or that it necessarily never recovers.

Command, from the investigation worktree:

```
python3 internal/tests/run_nav_global_route_reproducer.py
python3 internal/tests/run_nav_global_route_reproducer.py --document-current-limitation
```

The first command exits 1: `FAIL: route must use the only known opening south of the wall`.
The second command exits 0 only when the documented defect is reproduced. Neither means the bug is fixed.
Final measurement: `known complete map: southern route StepClear=1; local partial heads north=1`.

## Connected rooms and corner tests

The production `UDodge::Tick`, route cache, follower, solver and pathfinder run against
the existing modeled game collision in the scenario harness. Two 24-tile square rooms
connect through an offset doorway, a one- or two-tile hallway, and two turns. Starts
are deliberately off-center. Eight variants cover each direction, hallway width,
and NoWalk versus FullOccupy walls. Two more progressively receive terrain in a
10-tile neighborhood and retain it after the player leaves that neighborhood.

All ten variants pass under both `legacy` and `game`: 20 passing runs, zero refused
moves, stuck time, hits, overspeed or snapshot mismatches. This does not reproduce
the owner's corner death; it shows why a guessed global clearance increase is
unjustified. Bullet-induced corner motion is a separate unresolved reproduction.

The remote-door fixtures use two 200-tile square rooms and a two-tile hallway whose
entrance lies away from the destination. All terrain is already received before
navigation starts, including more than 65,536 tiles. All four direction/rule runs
fail to arrive within 120 seconds:

| Rule | Direction | Distance walked | Distance still to goal | Collision refusals |
|---|---|---:|---:|---:|
| legacy | forward | 719.2 | 175.08 | 0 |
| legacy | reverse | 718.9 | 113.46 | 0 |
| game | forward | 719.2 | 175.08 | 0 |
| game | reverse | 719.6 | 113.71 | 0 |

These isolate missing global topology: the planner wanders despite a known route.
They do not assert that the exact rooms appeared in the owner's run. The fixtures
are deliberately separate from the ordinary suite and remain red Stage2 acceptance
tests rather than being added to its known-limitations exemption.

```
python3 internal/tests/scenario/run_scenarios.py --check --rule both
python3 internal/tests/scenario/run_scenarios.py --stage2-regressions --check --rule both
```

## Structural observation proven from the pinned game

Inspected `game-86ad651b/GameAssembly.dll` with `objdump`, correlated with the live
collector class/field/method data. The existing `RuntimeOffsets::Sq_Cover` points
to `BGAIOPJMHLO.JGMBPFJEGAH`, offset 0x48, type `LKHPPBEGNOM`. It is the square's
occupying object reference, not merely a Boolean damage-cover indicator:

- World standability method `PEGDEDNHEHD`, RVA `0x1f7ab30`, calls square standability
  at `0x1477660`. It reads square+0x48, object+0x18, then `occupySquare` at +0x6b2.
- Neighbor FullOccupy check at RVA `0x1f792c0` reads the same reference and
  `fullOccupy` at +0x6e9. Collector fields confirm those ObjectProperties offsets.
- Square setter `OEHGKGEKKLN`, RVA `0x147e710`, writes the reference. On null it
  resets square layer+0x44 to 37; otherwise it copies the object's layer.

Consequently an adapter can use successful square-occupant observations to replace
or clear structural occupancy without interpreting UPDATE drops as destruction.
An old, unobserved square's null reference is not proof of new server knowledge:
stream-out behavior and observation freshness still need explicit validation.
Read failure is also distinct from successful null. Existing named bindings suffice;
the adapter must not copy these RVAs or numeric offsets into production code.

The current entity walk is capped at 4096, while square occupancy is not consumed
for object-wall flags. A wall omitted from that enumeration is a plausible separate
collision-data defect. It is not yet reproduced in the owner's process or patched.

## Smallest complete Stage2 increment

1. Add pure `internal/src/features/movement/nav/MapMemory.h`, with a map-session epoch and dimensions, two-byte ground cells (flags/speed-class), a sparse structural-object overlay with provenance, and a separate transient hazard overlay. Up to2048x2048, approximately8MiB ground storage. Moving enemies, bullets and temporary AoEs never become persistent terrain. A read failure cannot mark previously unknown ground known. An object drop alone cannot distinguish death from stream-out.
2. Add a game-thread square capture adapter at the existing WM_TileList/coordinate-cache seam. Read every newly appended square once, plus bounded local mutable-square revalidation; emit only plain changed-cell records to the navigator. Never send cached IL2CPP pointers to its worker. Preserve all successfully observed terrain across distance/fog changes; rehydrate all received squares in bounded chunks after reset/enable. Keep local collision snapshots refreshed. Do not merely increase the128 limit or add a persistent OR to s_tileFlags.
3. Wire map-session reset into the HELLO reset seam, and MAPINFO name/dimensions through an explicitly contracted message. Give every delta, request and corridor the epoch. New same-name/same-size dungeon instances still reset. Discard stale queued input/output. OnEnter invalidates navigation per the spec; distinguish mode-enter from actual instance transition during implementation so a mode toggle cannot accidentally mix map epochs. Existing list-pointer/shrink detection is a defensive recapture trigger, not the sole session identity.
4. Use the proven Sq_Cover -> ObjProps path for observed structural occupancy. Clear/revise an old structural blocker on a verified replacement/absence at its currently observed square, not because it left view. Keep the local live collision guard authoritative. Test door closes/opens, destroy/recreate and stream-out separately. Unknown structural state must stay explicit rather than silently becoming open. Observation freshness and the game-thread capture adapter remain implementation dependencies.
5. Add pure D*Lite `Router` and a dedicated10Hz navigator worker.8-connected, shared Collision edge checks/string-pull, Speed travel-time costs, sparse nodes<=250000, bounded incremental repairs, whole-map global goal. Unknown ground can be1.2x optimistic only in the search; corridor publication stops at a verified reachable frontier. Unknown terrain is never declared seen, and live Collision continues refusing unknown. Frontiers report partial and repair on revelation. Cost changes revise incident edges, including neighbors affected by FullOccupy and cover.
6. Add `NavigationOwner` and a stamped <=8-waypoint, approximately16tile corridor. Feed its first waypoint into existing `s_snap.navGoal`, guarded by `navNavigator=legacy|dstar` defaultlegacy. Preserve existing local dodge/temporal checks, enemy keep-outs, final occupancy and per-frame speed cap. While global repair runs, local dodging stays active. Same-map stale corridors may be used only within the spec's bounded lifetime; any epoch mismatch is rejected immediately. Stage3 fight/group policy remains separate.
7. Complete `navStatus` through IpcMessages/contract/MovementController and shared farmer travel handling. Include routing/arrived/partial/unreachable with reason and enough session/goal correlation to reject delayed results. Implement the specified stuck counters, Paralyzed exclusion, expiring blockers and map_changed reason. A visually drawn partial route must not count as arrival.

## Required failing tests before implementation

- Pure map memory: observe A, move>128away/update B, query A unchanged; fog/visibility changes do not erase A; unknown remains unknown; repeated identical observations produce no delta.
- Reset: same name/size with new epoch clears A; delayed old-epoch tile update/result cannot repopulate it; OnEnter and reconnect cannot revive an old corridor.
- Mutable topology: closed/open/reclosed door; destroy/recreate blocker at same coordinates; ordinary entity stream-out does not prove destruction; unseen moving enemy never becomes a permanent wall; failed observation does not falsely clear a blocker.
- Router regression from the executed reproducer: choose the known southern opening. Add its north-opening mirror so heap tie order cannot pass. Add a detour more than128away, revisit an older explored corridor and >65536known tiles.
- Unknown frontier: optimistic global segment can contain unknown, but the published executable segment never does; reveal wall, repair; frontier with no new data reports partial then bounded failure, not perpetual movement against void.
- End-to-end:250tile progressive revelation, three repairs, unreachable island<=10seconds; map change while repair is busy; node/time cap; moving enemy across corridor; local dodge remains responsive during router overrun; body/FullOccupy diagonal parity.
- Bridge: rejection with unreachable and map_changed; delayed status for previous request cannot terminate current navigation; default togglelegacy and contract parity.
- Existing Stage1 host suite under both collision rules, client tests/typecheck/bridge contract and native syntax checks. Benchmarks: render added<=0.2ms/frame, navigator<=5ms/100ms cycle, repair<=2ms p95, initial256tile plan<=20ms spread across cycles. Do not claim measured budgets from unit assertions.

## Immediate recommendation

Promote the wrong-direction fixture to a regression in an isolated Stage2 worktree, implement/test pure MapMemory and epoch lifecycle first, then the global router and corridor integration. Persistence alone is necessary but insufficient: the unchanged radius72 planner cannot use remote topology. This is a real Stage2 implementation, not a safe one-line Stage1 fix.

The promoted regression and connected-room fixtures now exist in this branch.
The next bounded production slice is `MapMemory.h` plus `nav_map_memory_tests.cpp`:
`Reset(sessionEpoch, width, height)`, `ObserveGround(epoch, coordinate, flags, speedClass)`,
`ObserveStructure(epoch, coordinate, observation)`, `GetCell`, and `TakeChangedCells`.
Structural observations explicitly distinguish Unknown, ConfirmedEmpty and Present
with identity/flags. Epoch mismatch rejects a write; identical observations emit no
change. Updating ground never implicitly clears the separate structural layer.
No method receives a game-object pointer or treats an entity drop as removal.
Pure tests cover retaining remote terrain, same-name resets, stale updates,
closed/open/replaced doors and failed reads. The subsequent capture adapter must
establish observation freshness before its ConfirmedEmpty branch is enabled.
This slice is preparatory and must not be represented as a shipped routing fix.

## Validation record

2026-09-15: `python3 internal/tests/scenario/run_scenarios.py --check --rule both`
exits 0: legacy 43 asserted / 4 existing known limitations; game 45 / 2.
The ten newly added normal scenarios pass under both rules.

2026-09-15: `python3 internal/tests/run_nav_global_route_reproducer.py` exits 1
with the expected southern-opening assertion; `--document-current-limitation`
exits 0. The latter checks a reproduced defect, not production correctness.

2026-09-15: the two remote-room fixtures ran directly in the built scenario
harness under both rules, producing the four failures tabulated above.
`python3 internal/tests/scenario/run_scenarios.py --stage2-regressions --only n_rooms_remote_forward --rule game --check`
also exits 1: `Pathing scenarios FAILED: n_rooms_remote_forward [game]`.
Selecting that scenario without its suite flag exits 2 instead of silently
running zero tests. `git diff --check` passes. No gameplay/build validation ran.

2026-09-15 follow-up: the pure MapMemory foundation is now implemented with 57
passing checks and seven rejected mutations. Full host tests and both scenario
rules pass; the standalone global-direction regression remains red. See
`2026-09-15-map-memory-foundation.md` for the API, storage costs, observation
authority contract and validation. The next integration must establish square
observation freshness, then add capture/epoch wiring and the global router;
persistence alone is not a routing fix.
