# UDodge safety work — 2026-09-06

Inspected bomb capture, ownership, filtering, solver admission, and movement
execution after reports of missed fast bombs and absent orange circles. No live
hit recording was available, so individual gameplay hits are not yet attributed.

## Implemented

- Capture throwable origin/destination and flight duration from initializer
  arguments instead of renamed object fields. Preserve positive flights below
  100 ms; they previously became a 3000 ms countdown.
- Keep telegraph landing time separate from retention. Retain the warning for
  200 ms after landing so it does not disappear exactly at impact while awaiting
  a separate explosion capture. This deliberately adds a short conservative tail.
- Do not treat the throwable object's ID as its owner's ID. A nearby prop/player
  cannot establish friendly ownership. Position lookup continues past non-enemies
  to find an enemy at the origin. Failed explosion ownership reads remain unknown.
  Known friendly source IDs remain friendly; unknown effects may now cause extra
  avoidance rather than being silently ignored.
- Deduplicate only recent matching flights with the same origin, destination,
  and landing deadline. An older/friendly effect at the destination must not hide
  a new throw.
- Preserve attack-warning SHOWEFFECT types 4, 5, 16, 23, 26, and 39 even when the
  anti-lag custom blocklist includes them. Defaults did not block these, so this
  explains missing warnings only when a custom blocklist was configured.
- Retain all 128 entries from the AoE tracker in UDodge instead of dropping to 32.
- Remove the 1600 ms ceiling on computed bomb escape warning. Radius 12 at
  5 tiles/s requires about 2443 ms of movement plus reaction time.
- Escape exceptions are per bomb: escaping A must still sweep against B.
- Moving targets receive swept ground/AoE checks and mandatory temporal
  validation during revalidation, including when the painted lane looks clear.
- Emergency fallback checks ground along its path, refuses entry into other
  active bombs, and permits outward progress while still inside a large bomb.
  Candidates are ranked first by predicted projectile-free time over the next
  200 ms, then by the existing geometric/route score. Already-exposed cases still
  use geometry to make escape progress. Ground/AoE escape checks run at execution
  after a re-solve as well.
- Add bounded Release capture logs and diagnostics for unmodeled effect types
  16/26, in addition to existing hook-install diagnostics.

## Regression evidence

`python3 internal/tests/run_udodge_zone_tests.py` compiles the production math
core and solver with an empty Windows PCH on the host. It passes 25 cases covering
multi-bomb escape, partial escape, crossing shots, short flight durations, ownership,
and initializer coordinate decoding.

The original core fails the crossing-second-bomb case. The original solver fails
an additional scenario where a clear projectile trajectory exists while escaping
an oversized bomb: it instead chooses a crossing trajectory. Both pass after the
changes.

The anti-lag test exercises the actual registered SHOWEFFECT handler with a custom
blocklist: six warning types survive and a listed cosmetic effect is still dropped.
All 41 client tests, bridge/packet contract checks, and client test typechecking pass.

## Remaining limits and gameplay verification

- Effect types 16/26 are preserved and logged but not assigned guessed AoE geometry.
  Identify an affected enemy/dungeon and inspect these logs to determine whether
  another capture path is needed. Hook installation alone does not prove coverage.
- Default bomb radius remains an estimate for sources without radius metadata.
- The upstream tracker still has a 128-entry ring; projectile snapshots still cap
  at 192. Unknown attacks, overflow, and late arrival can invalidate safety claims.
- Prediction has an 800 ms horizon and sampled curves. Fallback remains an escape
  heuristic, not a proof that a collision-free route exists. AoEs are represented
  as active/pending discs rather than full future detonation schedules.
- Profile dense combat: additional path/temporal checks and unresolved ownership
  lookup can cost more than the previous unsafe endpoint shortcuts.
- Changes affect shared AoE consumers as well as UDodge. Verify warning timing,
  false positives from unknown ownership, and other dodge/AutoNexus behavior.
- Current live settings were not read. hitScale below 1 underestimates projectile
  hitboxes; safeWalk=false permits damaging ground.

Look for `[AoeTracking] hooks:`, `[AoeTracking] capture`, and
`[AoeTracking] unmodeled effect=` in the runtime trace. Record the enemy name,
solver decision, actual hit timing, and whether the landing disc appeared.
No live gameplay validation or injection has been performed in this work.

## Build artifact

Windows x64 Release build succeeded with 0 warnings and 0 errors. The DLL is
staged at `client/assets/realm-engine.dll` in this checkout, with SHA-256 verified
against `C:\rebuild\Release\bin\realm-engine.dll`. It has not been injected into
a running game or copied into another Windows checkout.

## Second audit: projectile sampling and arrival windows

Three further prediction defects were reproduced and fixed:

1. Temporal culling used only 100 ms sample positions and ignored hitbox extent.
   A shot crossing the search area between those positions, or a wide projectile
   just outside the centre-distance cutoff, disappeared from temporal queries.
   Culling now measures the entire source polyline and includes the hit square
   and timing margin in its distance bound.
2. Speed/refinement decisions used displacement between 100 ms endpoints. A
   looping trajectory returning to the same endpoints appeared stationary, and
   even 50 ms refinement can miss an intervening oscillation. Speed now comes
   from the source trace segments. A Chebyshev error bound between that trace and
   the resampled trajectory is added to the lane's clearance margin. This bounds
   lost detail in the supplied trace; it does not recover unobserved motion
   between sensor samples. It can make strongly curved paths more conservative.
3. ArrivalClear followed intermediate samples only for fast lanes. Slow lanes
   were replaced by one straight chord across the entire arrival window. All
   lanes now follow their individual segments; only fast lanes use half steps.

Validation: the existing 25 native regression cases plus 14 temporal checks pass.
Eight checks in the initial temporal suite failed before these changes. Additional
coverage tests 1,600 known collision points across 200 oscillating trajectories,
checks that genuinely distant shots are still culled, and verifies that straight
shots retain their existing timing margin.

A synthetic optimized Linux benchmark with 192 lanes of 36 points measured
18.5 microseconds/context before and 98.2 after (about 0.08 ms additional setup).
Context storage is unchanged. This benchmark covers context construction only;
it is not a measurement of the complete Windows solver or live frame rate.


## Third audit: immediate re-solving and temporal admission

The game thread no longer suppresses emergency re-solving on rebuilt maps. The
old `needResolve && !rebuilt` guard assumed rebuilding had already run the solver,
but rebuilding only refreshed/published the map. The worker could still be late.
`Solver::RevalidateAndSolve` now validates and immediately replaces an unsafe
committed decision on the same map before the movement block executes. It also
checks a held position's full prediction horizon on map rebuilds, catching newly
observed attacks that have not entered the short painted lane yet. Clear held
positions keep their inexpensive between-rebuild check.

Every normal reflex candidate now has to pass the temporal transit/dwell test.
The previous spatial-pass alternative could accept a predicted collision outside
the short painted lane. Spatial clearance still contributes to scoring and
threading classification, but cannot override temporal rejection. The same
spatial shortcut was removed from moving-target revalidation.

The new control-flow function is shared by production Tick and host tests.
Before changes, an extracted copy of the production revalidation block and the
original solver failed seven of its twelve checks. After changes all twelve
pass: unsafe movement replacement on rebuilt maps, a new threat invalidating a
stale Hold, temporal rejection despite a clear painted lane, safe alternatives,
and no unnecessary solve for a clear held position. Together with the earlier
suites, all 51 native checks pass.

Moving-target revalidation now always pays for a temporal query. Candidate
admission reuses the march it already performed, so the mandatory veto adds no
second prediction pass there. Live performance and combat validation remain
outstanding; emergency Fallback still expresses a least-bad escape when the
solver cannot find a fully safe candidate.

## Fourth investigative pass — findings only

No production code or staged DLL was changed in this pass.

### Reproduced: low speed multipliers are ignored

Compiled the actual GetTilesPerSec function from MovementRuntime.cpp with stubbed
runtime reads (SPD 50). Multipliers 0, 0.1, and 0.2 each produced 7.733 tiles/sec;
0.5 correctly produced 3.867 and 1.0 produced 7.733. The multiplier is applied
only when greater than 0.2 and less than 5. A real 0.1 movement multiplier would
therefore be modeled ten times too fast, invalidating arrival times and escape
budgets. The zero case is ambiguous: CallCalcMoveSpeedRaw also returns zero for
failed reads, and ReadPlayerStats substitutes SPD-50 speed on unavailable speed.
UDodge sets movementLocked=false. Live condition/multiplier evidence is needed
before attributing an actual immobilization or slow-related hit to this path.
A fix should distinguish unreadable speed from valid zero/low speed rather than
just adjusting a threshold.

### Reproduced: predicted shots do not disappear at their known end time

A production Core::Temporal test used a shot from x=-1 to x=0 ending at 100 ms
(tailAtShotEnd=true), and a player walking from x=2 to x=0 at 5 tiles/sec, arriving
at 400 ms. While the shot exists, separation is at least 1.5 tiles, above the
0.714-tile padded hit extent. PathClear nevertheless returned false and
TimeToDanger returned 200 ms. The temporal context treats the dead shot as frozen
at x=0 for the rest of the horizon. This is a conservative modeling choice, but
it removes genuinely opening gaps and can force worse escape choices. Known
shot expiry should be represented separately from an untrusted truncated trace;
untrusted traces must retain their conservative handling.

### Code-level concern: commitment state is split between two solvers

WorkerLoop updates g_solveState; emergency/main-thread solving updates g_state.
Accepting a worker result copies its plan/decision but no commitment state.
Neither worker snapshots nor results carry the heading actually executed by the
other solver. This can undermine direction continuity when worker decisions and
emergency decisions alternate. Gameplay tracing is needed to establish whether
it contributes to observed jitter; this pass did not reproduce an in-game flip.

### Additional sensing heuristics requiring runtime validation

CouldReachThreatRegion expands base-speed travel by only a factor of two for
accelerating projectiles. That is not a proven upper bound on accelerated travel,
and a rejected shot never reaches accurate trajectory tracing. Wall-hit retirement
also permanently retires tracked shots based on blocked-tile position without
checking the projectile's own wall-collision rules. These are credible omission
paths, but this pass did not identify a concrete live projectile definition that
triggers either. Do not remove conservative reconciliation safeguards without
reliable live deletion/collision evidence.

## Implemented follow-up: speed, expiry, and commitment

All three findings from the fourth pass are now addressed.

- **Speed:** valid zero and positive low multipliers survive the raw read and
  speed conversion. A negative sentinel represents an unavailable read; the
  existing fallback uses the known SPD when possible and does not replace a
  readable zero or severe slow. Shared TestTAB callers preserve zero. UDodge's
  automatic budget no longer has a 0.4-tile minimum, and a zero-speed solver
  cancels movement rather than announcing a reachable dodge. This handles the
  values returned by the speed API; live condition/multiplier accuracy still
  needs gameplay verification.
- **Expiry:** every temporal query clips each lane at known remaining lifetime
  plus the existing timing uncertainty allowance. A known-dead shot no longer
  occupies its final point for the full horizon. Sensors carry remaining lifetime
  independently of traced geometry and refresh it during re-anchoring, so shifts
  of the trace endpoint cannot manufacture an earlier expiry. An unavailable
  lifetime with an untrusted trace remains conservative. Explicit lifetime also
  overrides a trace's old tail marker when the trace is shorter than that life.
- **Commitment:** the game thread owns movement history. A snapshot carries that
  state and its revision into the worker; the worker has no private persistent
  heading history. Results return the revision and proposed state. A result based
  on an older commitment can still provide a route hint, but its immediate move
  is recomputed from the latest history. Emergency validation also starts from
  committed history, not from the rejected candidate's proposed heading. History
  updates only after a successful, nonzero movement command; rejected/unexecuted
  proposals cannot alter it. This records accepted command direction, not a
  separately measured server acknowledgment of displacement.

Validation: all 90 host checks pass (51 existing, 27 speed/expiry, 12 commitment).
Commitment tests run the real WorkerLoop and solver on a real thread with grid
search stubbed out, exercising snapshot state, late results, an east-to-north
emergency change, resets, and unsuccessful movement. The original worker fails
four of these checks. Lifetime tests cover transit, arrival, edge traversal,
partial-step expiry, late queries, explicit refreshed lifetime, and unknown tails.

Runtime checks remain necessary for slowdown/immobility API values, curved-shot
expiry near timing boundaries, and direction stability under actual worker load.

## Farmer tree-navigation follow-up

The farmer's repeated destination commands are deduplicated by MovementController.
Two native routing defects can instead explain repeated corrections near trees:

- ComputeNav's collinear reduction emitted the cell after a direction change,
  replacing the actual corner with a diagonal shortcut. It now preserves the
  corner vertex. Routes truncated by the waypoint cap are also marked partial.
- Both initial worker steering and cached route following advanced lookahead
  across bends without checking the direct sweep from the player. They now share
  a follower that only skips a bend when occupancy permits the shortcut; otherwise
  it targets the preceding corner. Live checks use the player-footprint callback,
  while the worker uses its navigation occupancy snapshot.

Validation: production A* compiled in the host suite with a timing-only Windows
shim; L-corridor compression, blocked lookahead, continuous traversal, open-space
lookahead, and tree detours from all four cardinal directions pass. The existing
90 dodge regression checks also pass. Live gameplay remains unverified.

## Farmer combat, inventory, beacon and lateral-route follow-up

- Combat now acquires within 8 tiles and retains the living target through 12
  tiles, including temporary invulnerability. Active combat returns before loot
  or exploration can install a higher-priority walk waypoint.
- Farmer/SDK and Auto Loot share a per-connection automatic inventory-action gate:
  1.3-second minimum spacing, then wait for slot changes (both source and
  destination for swaps), with a bounded 5-second timeout. Whole-bag pickup now
  sends at most one operation per call. Invalid/unowned backpack and quickslot
  destinations are excluded. The farmer stays on a bag during the bounded wait.
  Separate Auto Drink/manual senders are outside this new gate; live disconnect
  cause still needs the server/client error to confirm.
- Beacon selection still chooses the usable beacon nearest the quest, now requiring
  8 tiles of saving rather than 30. Navigation pauses during confirmation; a failed
  attempt backs off that beacon for 30 seconds instead of disabling the session.
  Confirmation requires landing near the beacon as well as a significant move.
- A valid radial worker route previously returned before lateral scoring. It now
  considers swept-safe lateral candidates with at least the same predicted time
  to danger, retaining retreat when sidesteps are blocked. No collision admission
  thresholds were relaxed.

Validation: 47 client tests, client test typecheck, and native regression suite
(including 16 admission checks, safe lateral replacement and blocked-lateral
retreat) pass. Live game verification remains outstanding.

## Laser geometry, loot priority and Auto Nexus forecast follow-up

- Captured projectiles with LaserDistance now produce a full simultaneous beam
  lane, rather than tracing a stationary origin as an ordinary bullet. Temporal
  checks sweep the player against the entire finite segment until expiry;
  debug draws the full beam. Broad-phase culling includes beam reach, the live
  angle refreshes, and wall/retro-hit heuristics no longer retire a persistent
  laser after a single contact. Shared projectile-hit math and the native Nexus
  scan now check finite beams too. This covers captured projectile lasers; an
  unidentified boss effect using another capture path remains unverified.
- Per the user's revised preference, useful loot owns movement before combat.
  The boss lock is released during the detour and acquired again after looting;
  repeated combat ticks no longer clear the bag waypoint.
- Auto Nexus forecasts discard scans older than 100 ms and events more than
  32 ms past their hit deadline, rather than clamping stale events to new hits
  at time zero. Forecast damage respects current invulnerability and deduplicates
  projectile identities. Actual HP and configured force/predicted thresholds
  remain unchanged; these thresholds can intentionally escape before death.

Validation: native regression suite includes seven beam checks (full extent,
spatial culling, temporal crossing, parallel movement, expiry, live admission and
finite end caps). 50 client tests and typecheck pass, including actual Auto Nexus
plugin tests for stale/duplicate/invulnerable forecasts and preserved lethal
prediction. Live encounter confirmation still needs the boss identity and escape
log. Rotating-beam prediction uses the current observed angle, not an inferred
future angular velocity.

## Dead Church Farmer and navigation recovery

Added a managed Dead Church Farmer script package. It reuses Farmer's coordinated
item actions and beacon/Nexus travel, selects enemies from loaded biome/group
metadata, explores known walkable terrain until a beacon is discovered, patrols
known Dead Church tiles, and prioritizes local white bags. It does not follow
unrelated quests. The client SDK now exposes optional enemy biome/group and object
class metadata, avoiding display-name-only beacon/mob classification.

Navigation now replans when the cached steering segment is blocked, or after
500 ms without 0.25 tile of net movement. Moving around an obstacle still counts
as progress when it temporarily increases distance to the final goal. A pending
replan suppresses voluntary raw-goal nudging until the worker provides a route;
emergency dodge still runs. Navigation grids use stable tile centres and an extra
0.15 tile of collision-box padding, also checked on live lookahead shortcuts.
Starting inside the padding can still escape using the physical footprint.

Validation: 54 client tests, SDK build and client test typecheck pass. Native
regressions cover stalled nudges, legitimate detour motion, padded shortcuts and
escape from a tight start, in addition to existing route and dodge cases. Live
farming/navigation remains unverified.

## Farmer beacon eligibility and level-20 relocation

Fixed generic Farmer rejecting biome-named beacons through its prefix-only allowlist: prefer game-data Beacon class, with a limited name fallback for snapshots lacking class metadata. Explicit other classes, guardians, and inactive destinations are excluded. Rank candidates by distance to the travel destination and retain per-beacon retry backoff (also enforce it in the shared teleport helper used by Dead Church Farmer).

Added World.getSize() backed by full MAPINFO dimensions. Generic Farmer now clears its leveling quest and combat lock at level 20, relocates toward map center via the closest useful beacon or walking, and resumes quests inside a central arrival radius (15% of shorter map dimension, minimum 12 tiles). This occurs once per Realm visit, including starting at level 20; loot keeps priority. Dead Church Farmer keeps its independent biome loop. Server-provided quests and server acceptance of TELEPORT remain outside script control.

Validation: SDK build, all 59 client tests, test-inclusive TypeScript check, script syntax check, and git diff --check pass. Tests cover biome beacon ranking, invalid classes, retry exclusion, level transition during combat, confirmed arrival, once-per-map behavior, loot priority, missing/full map dimensions, and walking fallback. No native code changed in this follow-up; live server teleport acceptance remains unverified.

## Live beacon blocker and terrain overhead

Read the live Windows dashboard GET /api/scripts: Dead Church Farmer was running with activity “walking to beacon (537 tiles) — map reports teleport disabled”. Found StateManager CREATESUCCESS replacing PlayerData after MAPINFO, erasing map name, dimensions, and teleport permission. Preserve these four connection-scoped map fields across character reset; character stats/inventory still reset. This also restores map-name-dependent castle exit and level-20 center dimensions. No player/beacon permission gate was bypassed.

FPS report: bounded Dead Church terrain refresh to Tiles.getNearby(32) instead of materializing all explored tiles every second. Improved GameWorldState bounded queries to look up the requested cells directly when cheaper than scanning known tiles. Live FPS causation/recovery is not measured. Regression coverage includes actual packet ordering, non-teleportable maps, creation before MAPINFO, dense/sparse tile query results, and local refresh cadence. All 68 client tests pass.

## Tight tree-cluster route following

Found intermediate navigation anchors sharing the final-waypoint 0.5-tile arrival tolerance. A safe player could HOLD short of a bend while the next segment remained occluded, repeatedly regenerating that route. Solver now uses 0.05-tile intermediate-anchor tolerance; final user arrival remains 0.5 tiles in the controller. Collision, enemy, AoE and temporal gates remain applied to every step.

Navigation::Follow now selects only reachable projections and initializes its fallback to that verified projection, rather than an unchecked next bend. Routes that fold around nearby obstacles cannot select a closer projection through the obstacle. ComputeNav preserves the start tile centre when the live player is off-centre, preventing compression from replacing the first tile-aligned leg with a diagonal from the live position.

Regression suite covers advancing to a bend inside 0.5 tiles, occluded nearby route legs, blocked first bends, off-centre start alignment, plus existing real A* tree detours and corridor completion. Screenshot geometry itself is not a measured collision map; live improvement still needs verification.

## Dead Church coverage, stale enemy locks, and public map-size facade

Replaced local farthest-point patrol and selection-time visit marking with persistent 6x6 discovered-area representatives. Mark actual occupied areas and arrived goals; prioritize unvisited targets with forward heading preference. Keep goals through fights/loot; defer no-progress targets without marking them visited. Terrain polling remains local and once per second.

Corrected missing RealmEngine.world.getSize facade delegation. Prior tests only invoked World.getSize directly and therefore missed the script-facing omission; the bridge test now calls the public facade. SDK rebuilt. Enemy bridge now rejects disconnected, stale (>3 seconds), nonfinite-position, and Invisible-effect records consistently in all lookups; nearest chooses among eligible records. Exact user-reported ghost object was not captured, so other invisible-helper representations remain unverified.

Validation: all 72 client tests, SDK build, TypeScript test-inclusive check, script syntax and diff whitespace checks pass. Includes exploration memory, actual visits, forward preference, eventual backtracking for missed areas, fight suspension, failed-route cooldown, ghost freshness/visibility, and real public getSize API.

## Nexus waypoint cancellation and leader add phases

MovementController.clearWaypoint now sends native cancellation even without a cached script target, so manual/native goals can be cancelled on map entry. Shared farmer Nexus handler disables combat targeting, waits for positive player HP before anchoring the portal-search route, clears native movement on initialization, and retains the selected open portal. Installed Windows shared farmer and movement bridge.

Dead Church leader phases now select fresh, targetable nearby adds during boss invulnerability or hidden phases after encounter arrival. Add selection is spatially bounded (24 tiles from last boss position, 32 from player), retains current eligible add, walks to farther adds, and returns to boss targeting when vulnerable. Live adds prevent the missing-boss timeout from abandoning the encounter. White loot still precedes encounter control. Tests: all 80 client tests, TypeScript checks, script syntax, diff whitespace pass. Exact encounter completion and Nexus visual behavior still require live verification.

## Auto Nexus fabricated AoE damage (live log confirmed)

Windows proxy log at 02:28:57.356 showed HP 616/655, three Urgle sources at 9983 estimated damage each, total 29949, predicted HP -29333. Native AutoNexus emitted each visual AoE as rawDamage=9999 with synthetic bullet IDs 20000+index; these entries have geometry but no captured damage. This invented damage rather than estimating the actual attack. Removed that synthetic native threat block. UDodge zone avoidance and client packet AOE/AOEACK health handling remain in place; visual-only unknown-damage zones no longer count as lethal HP forecasts.

Client compatibility filtering rejects unresolved old-DLL synthetic signatures (ID 20000..20127, raw9999, nonpiercing); tracker-resolved real projectiles remain eligible. Nonfinite/nonpositive damage is rejected before counting or charging a projectile. AutoNexus integration regression now reproduces three synthetic 9999 threats, verifies no false escape, checks invalid damage, and retains fresh lethal projectile escape.

## General quest-boss add phases and follow-up bomb report

Realm Farmer now persists a quest encounter anchor through untargetable/hidden phases, targets nearby adds, and returns to the vulnerable boss. Shared add handling limits targets to 12 tiles from the last live boss position; player displacement beyond 14 tiles triggers a return toward an eight-tile ring. Dead Church Farmer uses the same routine. Loot priority remains.

Latest captured bomb escape at 02:36:20.891 was another 9999-placeholder forecast; plugin change/reload was logged at 02:36:26.734/.821, after that escape. Latest game injection in the inspected log was 02:16:04, before the fixed DLL was installed. Full game restart is required for the source-side removal. Inspected legacy packet AoE queue, but trackAoeDamage is hardcoded false: it is not the source of this report and no change to that disabled path is shipped. Previous notes suggesting active packet-AoE prediction were inaccurate; server-confirmed damage handling remains active.

## Level-20 purple and white boss selection

Realm Farmer switches from ordinary quests to known Boss minimap markers at level 20. Classification uses loaded XML icon and color, not quest HP: purple 0x8F04A8, dark purple 0x1B006D, white 0xFFFFFF, off-white MV shrine 0xD6D6BF, and default untinted Boss icons. Blue Boss icons and all Miniboss icons are excluded. SDK world objects expose this metadata and available HP. This policy is only used for Realm travel; untinted dungeon Boss definitions do not initiate Realm farming inside dungeons.

Choose nearest eligible known marker, commit through travel and hidden phases, and select another after observed death or sustained local absence. Zero-HP non-damageable controllers remain encounter anchors for nearby adds. With no known markers, use the central trip then rotate known beacon areas instead of returning to miniboss quests. Loot priority and shared nearby-add handling remain. Only server-exposed world objects can be selected; full-map marker availability and live completion still need game verification.

Validation: 84 client tests, SDK build, test-inclusive TypeScript check, and script syntax check pass. Coverage includes purple/white/default classification, blue and miniboss exclusion, nearest selection, sequential bosses, map reset, controller add phases, and loot priority.

## Wall stall and blinking navigation follow-up

Reproduced a follower bug: exhausting lookahead marked a cached route consumed even when the player was still two tiles from its endpoint. Partial routes then requested repeated A* refreshes during the approach. Follow now reports endpoint arrival based on actual player distance (existing final arrival tolerance), preserving the route through approach.

A blocked first lookahead previously returned the closest projection, which can equal the player position and cause HOLD despite an accessible route prefix. Recover a bounded, swept-clear prefix by at most eight bisections when no forward bend has yet been reached. If a reachable bend exists, retain that bend rather than cutting the next corner. Wall padding and normal collision/dodge checks remain applied.

Validation: the new arrival regression failed before the change. All six native logic suites pass after the fix, including wall/tree detours, blocked-prefix advancement, and preserving intermediate bends. The user's specific live wall geometry has not been captured; these fix reproduced navigation defects, not a guarantee against every stall.

Release DLL built with zero warnings/errors; installed workspace and Windows assets SHA-256 c4b0ba37ef3523b6475197edf405d9f6345bfdddd4bd8f6dc5948b3f8f009bcb. Windows previous DLL retained as backup. Running game is unchanged until restart.

## Player teleports, event death memory, and projectile capacity

Shared farmer travel now ranks fresh living player positions alongside eligible beacons by remaining distance to the destination. Keeps the eight-tile minimum saving, map permission, five-second retry cadence, and per-target failure backoff. Player teleports use the existing player-name SDK operation; confirmation accepts the original destination or the target player's refreshed position. Dead Church's no-teleport-after-leader-arrival rule remains.

GameWorldState retains a bounded per-map set of confirmed deaths from server DAMAGE kill flags and observed HP depletion. UPDATE drops alone do not mark death. SDK Objects.isDead exposes the memory after an object leaves the snapshot. Realm Farmer checks it at distance, filters finished candidates, and abandons waiting for an old teleport when its event is confirmed dead. A teleport packet already sent cannot be recalled, so subsequent navigation starts from the eventual landing position. Remote kills without any server death evidence still cannot be identified immediately.

Native hostile projectile store increases 256 to 1024, packet recovery buffer 256 to 1024, and UDodge lane capacity 192 to 512. Solver temporal scratch and packet scratch use separate thread-local storage; the temporal context has a 96 KiB ceiling. Diagnostic temporal lane count expands to uint16 to avoid clipping at 255. Nearest-first selection and bounded spatial culling remain. Higher caps require live dense-fight performance verification.

Validation: 88 client tests, test-inclusive TypeScript and SDK build pass. Six native suites pass, with a new 512-lane regression proving a threat in the final slot still rejects an unsafe stand. Windows build/install recorded below when complete.

Final Release build: zero warnings/errors. Installed DLL SHA-256 2ec566c7bc18a1130fdd325e44abf4af8457d0f83e75844daddf3a0d74598a3b in workspace and Windows assets, with previous Windows DLL retained. Client/SDK/script files also installed and compared. Restart client and game to activate.

## Confirmed-health-only Auto Nexus

User requested removal of predictive escapes. Replaced the prediction-ledger plugin with a server-health path: NEWTICK/UPDATE HP and server DAMAGE amounts are the only automatic escape inputs. No DLL forecast polling, unknown-bullet fallback damage, outgoing PLAYERHIT holds, AoE/ground estimates, guessed regen, or unseen-damage threshold margin remain. Legacy prediction settings are no longer registered, so saved values cannot reactivate them. The configured ForceAutoNexusHealth threshold, manual /nexus, safe-zone exclusions, notifications and bounded retries remain.

Native AutoNexus was verified to publish forecasts, not send ESCAPE. The plugin now disarms its scanner and both prediction feature flags; no DLL rebuild is needed. Server packets and outgoing hit reports are forwarded normally. Delta ticks without HP do not overwrite intervening confirmed damage; explicit HP updates replace the ledger, including zero. Hooks run after StateManager to use current effective max HP. Map/character changes and enable toggles reset health; disconnect/disable/unload cancel retries.

Validation: 94 client tests and test-inclusive TypeScript pass. Seven Auto Nexus regressions cover ignored lethal forecasts/client hits, current packet HP, confirmed damage accounting, heals, safe zones/reset, invalid inputs/zero HP, and retry cleanup. This mode reacts to confirmed damage, not impending hits.
