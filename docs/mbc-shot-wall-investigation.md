# MBC shot-wall and group-positioning investigation

2026-09-15. Baseline: `9cdc818`, private candidate source. Read-only production-code audit; no behavioral changes, Windows copying, build, or deployment. The reported death has no captured phase, projectile trace, or confirmed artifact version, so this report does not assign its cause.

## Confirmed behavior

- `client/script-packages/farmer/lost-halls-runner.mjs:156`: MBC uses generic boss combat; no player-group positioning exists. Priority adds can take movement ownership; invulnerable bosses permit ordinary-add combat. This is distinct from the Realm Farmer transition fix.
- `client/script-packages/farmer/oryx-runner.mjs:357`: generic combat approaches the target beyond eight tiles, otherwise clears waypoints and locks the enemy. Simply adding a group waypoint before this call would immediately erase it.
- `internal/src/features/movement/udodge/UDodge.cpp:1021`: manual input, walk waypoint, and enemy-lock position are mutually ordered movement goals. A waypoint can retain separate aiming, but replaces the lock-annulus positioning preference while active.
- `client/src/scripts/bridge/players/Players.ts:109`: SDK players include `lastUpdate`, position, HP, and object ID. Freshness must be checked; observing other players is not evidence that their location or route is safe.
- Native temporal checks sweep projectile/player relative motion, including between sample endpoints. Normal admitted steps do not intentionally trade a known collision for boss progress. The horizon is 800 ms, temporal culling is eight tiles around the player, and the snapshot is capped at 512 projectiles. Unobserved bullets and future emissions remain unknown.
- `UDodgePathfinder.cpp:545`: local timed search checks entire edges and can wait up to 200 ms. It stores only the earliest arrival per spatial cell; reconstruction discards the wait schedule and depends on immediate-step revalidation to produce a pause. It is not a complete space-time search.
- `UDodgeTypes.h:454`: local grid resolution is half a tile, radius six tiles expanding to twelve. `UDodgeSolver.cpp:279` generates straight polar steps plus goal/route candidates. Failure of this finite candidate set does not prove that no shorter, curved, or differently timed weaving route exists.
- `UDodgeSolver.cpp:866`: when every ordinary candidate fails, the least-bad fallback permits projectile exposure. It ranks time-to-danger first, then geometric clearance and route/retreat progress. Physical walls, enemy bodies, and active-zone escape constraints remain enforced. Blanket disabling this fallback could instead freeze a player inside an incoming wall.

## Bounded proposed MBC group policy

1. Scope to a confirmed active MBC encounter, not all maps or every nearby enemy.
2. Require at least three other living players with finite positions and recent packet timestamps. Reject self, unknown/stale timestamps, implausible jumps, disconnected entries, distant players, and players outside the same known reachable arena region.
3. Form bounded-radius groups, not transitive chains spanning the arena. Select an actual reachable member near the group's medoid, never an arithmetic centroid through a wall or boss body. Rank cohesion, local support, and approach distance; retain membership hysteresis so equal-size groups do not cause oscillation.
4. Keep boss aiming separate from movement. Use a soft local positioning preference toward the chosen group; stop pulling once inside its cohesion envelope. Avoid changing persistent user settings such as lock-follow. Drop stale group intent promptly and on map/encounter reset.
5. Existing swept projectile, terrain, enemy-body, active-AoE, escape, manual-input, and AutoNexus precedence must remain stronger than group cohesion. Do not teleport to a cluster or claim that following people is a safety guarantee.
6. Prefer an explicit native secondary group goal eventually. An interim script waypoint has a documented cost: it supersedes the boss-range annulus until cleared. Test and disclose that interaction rather than adding a second movement owner.

## Required tests before behavioral changes

- Script tests: stable dense group versus a lone nearest player; two separated groups without midpoint chasing; chained players do not create a false giant group; stale/dead/self/nonfinite/distant players ignored; valid timestamps refreshed; map and boss death reset; group loss clears intent; adds cannot silently erase group policy; boss aim remains independent.
- Native synthetic scenarios: moving wall with a reachable lateral gap; gap that opens only after waiting; two offset walls requiring a bend; closed wall with a safe stand; already-overlapped player with an escape; group anchor across a closed shot wall; narrow gap smaller than the actual combined hitbox; enlarged shot admitted before/after packet-to-native refresh; stale and truncated projectile evidence.
- Assert every reported safe move against independent swept hit geometry. Record fallback separately from safe movement, and do not count freezing indefinitely as successful navigation. Compare collision count, time-to-first-hit, progress, and group distance, not only whether a goal was reached.
- Use actual MBC traces to calibrate timing and group thresholds. Existing synthetic boss rings are not an MBC phase simulator.

## Validation

Command: `python3 internal/tests/run_udodge_zone_tests.py` on baseline `9cdc818`; exit 0.

Results: AoE 52; temporal 24; admission/rebuild 30; speed/expiry 90; commitment 12; navigation regression harness passed; timed escape 35; exact pruning 80,000; pathing rules 41; collision 36; speed model 18; enemy tracker 69; autofire 79; input focus 29. Scenarios: legacy 33 asserted with four known limitations; game collision 35 asserted with two known limitations.

Both scenario configurations explicitly exclude `d_boss_open_dense` and `d_boss_wall_dense` from assertions. Passing the suite therefore does not establish good dense-boss engagement or MBC weaving. Existing known limitations must remain visible in release claims.

Targeted command: `python3 internal/tests/scenario/run_scenarios.py --only d_boss_open_dense --rule legacy`; process exit 0, scenario `success: false`, `hits: 0`, `in_range_frac: 0`, `path_tiles: 134.7`, `stuck_s: 6.0`, no refused or overspeed moves. This reproduces a dense-boss positioning limitation, not the reported lethal shot-wall crossing. The runner intentionally prints known failures without a failing process exit.

## Separate coordinated work

Persistent-map work owns remembered topology and room routing. Projectile-width work owns the packet/native collision-size discrepancy. Neither is duplicated here. Persistent terrain cannot supply unseen dynamic shots or make an assumed room template authoritative; width corrections do not solve candidate search incompleteness.

## 2026-09-15 implementation follow-up

Owner requested connected-room corner handling; controller approved test-first group policy only if the movement seam preserves weaving and collision vetoes. Added an unconnected pure `mbc-group-positioning.mjs` proposal and tests. This is not active script behavior: LostHallsRunner does not import or call it.

Selection requires three other fresh living players, rejects unknown self identity, stale/future timestamps, invalid coordinates, duplicates and unreachable/distant groups. It selects a bounded-radius actual-member medoid with population hysteresis. Its route proposal follows the first cardinal cell and recenters an off-center origin before advancing, rather than cutting a multi-cell chord. Integer tile coordinates normalize to tile centers. Diagonal-only parent chains are refused. Cohesion requires short connected-floor distance, not merely being close across a wall. Thresholds remain provisional and require gameplay calibration.

Tests first: empty-selector stub produced eight failures and nine passes. Implementation passed 17 tests. Additional integer-coordinate and diagonal-link regressions exposed an integer-edge waypoint (one failure, 18 passes); normalization fixes it. Native admission adds two passing assertions that a group-like walk goal cannot override a known projectile crossing when a safe alternative exists.

**Live integration intentionally stopped:** `UDodge.cpp:1314` excludes timed escape advice whenever `goal.walkTo` is true. Existing SDK group waypoints would therefore suppress the multi-step timed advisor while also replacing the boss-annulus goal. The immediate collision veto still operates, but the group feature would remove a relevant weaving capability. A dedicated secondary group-positioning preference must retain the existing combat/timed-escape context. Merely calling `navigateToPosition` from the script is not the approved safe integration.

Next integration should carry a fresh optional group anchor with encounter/map ownership into native safe-candidate scoring, retain boss targeting and timed advice, clear that anchor on stale or absent group evidence, and explicitly test the combined goal against blocked doors and moving shot walls. The pure proposal cannot certify projectile safety and never sends movement itself. No new code claims to reveal unseen projectiles or prevent death.

Final follow-up validation: `npm test` passed 64 files / 596 tests (including 19 new selector tests); `npm run typecheck:tests` passed. `python3 internal/tests/run_udodge_zone_tests.py` passed with admission checks increased from 30 to 32; other counts and scenario known limitations unchanged. `git diff --check` passed. Investigation baseline report was committed as `ab3799b`; follow-up code remains separate from live encounter behavior.
