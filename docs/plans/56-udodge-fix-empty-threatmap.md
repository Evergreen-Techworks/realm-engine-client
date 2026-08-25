# 56 — Stage A: Fix the Empty Threat Map (dodge must see bullets and move)

## Goal
After this plan, UDodge reliably registers approaching enemy projectiles as
threats and issues moves against them. The continuous
`[UDodge] NO-MOVE dec=1(NoThreat) ... standClr=1e+09 threats=0` (printed while
bullets are on screen) no longer occurs when hostile bullets are within the
16-tile threat window. This is the #1 blocker and is thread-independent — it must
be fixed and tested in-game before any later stage.

## Dependencies
Builds on merged plans 44-51. Parallel-safe with nothing (it is the head of the
strictly-sequential chain 56→62). Touches
`internal/src/features/movement/udodge/UDodgeSensors.cpp`,
`internal/src/features/movement/udodge/UDodgeCore.cpp`,
`internal/src/features/movement/udodge/UDodge.cpp` — all later plans in this
chain also touch these, so it must merge first.

## Current state (root-cause analysis)

The `standClr=1e+09` in the failing log is the smoking gun. `1e+09` is exactly
`kHugeClearance` (`UDodgeTypes.h:110`), the value `c.clearance[kStandCandidate]`
is initialised to and only overwritten by candidate scoring. So the core RETURNED
BEFORE scoring any candidate. The only pre-scoring `NoThreat` exit is:

`UDodgeCore.cpp:457-460`
```cpp
if (directLaneThreats == 0 && !directZoneThreat && !c.hazardEscape) {
    FinishMap(c, out, intentVel, false, state.selectedCandidate, 1.f, 0, Decision::NoThreat);
    return;
}
```

So the failure is the **relevance/threat gate**, which is fed by lane emission.
Note the two facts that bound the search:

1. **Emission is unconditional.** In `BuildMap`, every projectile that survives
   the filter becomes a lane, because `TraceLane` always sets `pointCount ≥ 1`
   and the loop does `if (lane.pointCount >= 1) ++out.laneCount;`
   (`UDodgeSensors.cpp:299-322`, esp. 320-321 and `TraceLane` at 197-203).
   Therefore `out.laneCount == (# projectiles passing the filter)`. If lanes are
   zero, either `rawProjs` was zero or the filter rejected all.
2. **The filter is byte-identical to PJDodge and reads the same store.**
   UDodge `BuildMap` filter (`UDodgeSensors.cpp:299-305`) and PJDodge `Build`
   filter (`PJDodgeSensors.cpp:236-242`) are the same six lines; both call
   `ProjectileTracking::CopyActiveForDraw` (same `ProjectileStore` ring,
   `ProjectileStore.cpp:286-305`). So the filter is not UDodge-specific.

### The diagnostic bisection (do this FIRST, in-game, Step 1)

The user already added the two lines that decide this:
- `UDodgeSensors.cpp:293-297` → `[UDodge] BuildMap rawProjs=N localId=...`
- `UDodgeSensors.cpp:327-332` → `[UDodge] BuildMap DONE lanes=N zones=N enemies=N`

Three branches:

- **Branch (a): `rawProjs=0`** (store/classification empty). The projectile was
  dropped before storage or expired. Likely at the spawn hook classification:
  `ProjectileTracking.cpp:256-260`
  ```cpp
  const bool ownerClassified = TryReadObjectPropertiesIsEnemy(objProps, ownerIsEnemy);
  const bool isEnemyShot = !isLocalShot && ((ownerClassified && ownerIsEnemy) || (!ownerClassified && canHitPlayer));
  if (!isLocalShot && !isEnemyShot) return ret;   // NOT stored
  ```
  If `OP_IsEnemy` reads stale (classified=true, isEnemy=false) for real enemy
  shots, they are never stored. Secondary: `CopyActiveForDraw` expiry
  (`ProjectileStore.cpp:297-299`). **This branch also breaks PJDodge** — confirm
  by switching to PJDodge (DodgeMode 6) in the same fight; if PJDodge also sees
  nothing, the fix belongs in `ProjectileTracking`/`ProjectileStore`, is shared
  infra, and is IN SCOPE per the overview.
- **Branch (b): `rawProjs>0` but `lanes=0`.** Impossible unless the filter
  rejected all — which means `localId` is poisoned (set to an id that equals the
  bullets' `attackerObjId`/`ownerObjId`, `UDodgeSensors.cpp:301-302`) or every
  projectile position is culled (`p.x,p.y` garbage vs the 16-tile cull at
  `UDodgeSensors.cpp:305`). `localId` comes from `WorldTAB.cpp:619,630`.
- **Branch (c): `rawProjs>0`, `lanes>0`, yet `NO-MOVE threats=0`.** The map is
  populated and the failure is purely the relevance gate at
  `UDodgeCore.cpp:457`. This is the most likely branch given `standClr=1e+09`.

### Why the relevance gate (branch c) starves

`directLaneThreats` counts a lane only when its polyline comes within
`half + kRelevanceClearance` of the player OR the intent-probe path
(`UDodgeCore.cpp:427-436`):
```cpp
const float half = HalfOf(c, L);                 // ~0.5 × hitScale
const float standDist = LaneDistCheb(L, player);
...
float direct = standDist;
for (j..) direct = min(direct, LaneDistCheb(L, intentProbes[j]));
if (direct <= half + kRelevanceClearance) ++directLaneThreats;   // ≤ ~2.5 tiles
```
With no WASD/goal intent, `intentProbeCount == 1` (just the player point,
`UDodgeCore.cpp:415-419`), so `directLaneThreats` reduces to "is a lane within
~2.5 tiles of where I stand RIGHT NOW". A bullet 4-8 tiles away, heading at the
player, whose lane polyline HAS been traced toward the player, should register
(the polyline passes near the player). But if `TraceLane` fell back to a
**single point at the bullet head** (both `LaneFromCachedPath` and
`LaneFromFreshTrace` returned false — `UDodgeSensors.cpp:199-203`), the lane is
just the far bullet head → `standDist` large → not counted → `NoThreat` →
`standClr` never touched → the exact failing log. So branch (c) is really: lanes
exist but are DEGENERATE (single far point) and/or the relevance pad is too
tight given no intent.

## Target design

Make the map robust in three complementary, behavior-scoped ways. Apply the
subset the diagnostics point to; (T3) is safe and recommended unconditionally.

**T1 (branch a — only if `rawProjs=0` and PJDodge is also blind).** Broaden the
spawn-hook enemy classification so a stale `OP_IsEnemy` cannot drop real enemy
shots: store when `canHitPlayer` is true regardless of the `ownerClassified`
flag, i.e. change `((ownerClassified && ownerIsEnemy) || (!ownerClassified &&
canHitPlayer))` to `(ownerIsEnemy || canHitPlayer)` at
`ProjectileTracking.cpp:258`. **Divergence warning:** this widens what counts as
an enemy shot for ALL consumers (PJDodge too). It is behavior-preserving for
correctly-classified shots and only ADDS shots that `canHitPlayer` — which is
precisely the set a dodge cares about. If in-game shows own-shot false positives,
the `isLocalShot` guard above already excludes them, so this is safe.

**T2 (branch b — only if `localId` poisoned).** Guard the localId filter so it
can never reject a projectile whose `canHitPlayer` is true:
`UDodgeSensors.cpp:301-302` becomes conditional on `!p.canHitPlayer`. Do the same
in `ReanchorMap` (`UDodgeSensors.cpp:364-365`). Rationale: a shot that can hit the
player is never our own outgoing shot; if `localId` was mis-set, this stops it
from eating enemy fire.

**T3 (branch c — recommended always).** Fix degenerate lanes and the tight
relevance pad:
- In `TraceLane` (`UDodgeSensors.cpp:197-203`), when both path builders fail,
  synthesize a straight 2-point lane from the bullet's live position along its
  velocity/`angle` for `laneCap` tiles, instead of collapsing to a single point.
  The projectile already carries `angle` (`WorldProjectile`), and a straight
  extrapolation is the correct present-tense danger for a shot whose curve model
  is unavailable. Add a helper `LaneFromStraightExtrapolation(lane, p, laneCap)`.
- In the relevance pass (`UDodgeCore.cpp:424-436`), also treat a lane as a direct
  threat when its polyline crosses the **stand-step disc** — i.e. compare against
  `c.step + half + kRelevanceClearance` (the value already used for the
  `c.relevant[]` scoring set at line 429) rather than the tighter
  `half + kRelevanceClearance` used for `directLaneThreats` at line 435. Unify
  both on `c.step + half + kRelevanceClearance` so any lane worth SCORING also
  trips the `NoThreat` gate. This closes the "relevant-for-scoring but not
  counted-as-threat → early NoThreat return" hole.

**Divergence note for T3 relevance change:** widening the `directLaneThreats`
predicate makes the engine engage scoring for slightly more distant shots. This
is the intended behavior for the wide-reaction-margin design (plan 50/51): the
dodge is supposed to position early. It cannot make the dodge MORE passive.

## Steps

1. **Read the live diagnostics and pick the branch.** In-game with UDodge on
   (DodgeMode 7) in a fight, capture the dll-trace lines
   `[UDodge] BuildMap rawProjs=N` and `[UDodge] BuildMap DONE lanes=N`. Record
   whether `rawProjs`/`lanes` are zero. Also toggle to PJDodge (DodgeMode 6) in
   the same fight to confirm whether the store is shared-broken. No code change;
   this decides which of T1/T2/T3 to apply. (Build not required for this step.)

2. **Always apply T3 lane-degeneracy fix.** In `UDodgeSensors.cpp`, add
   `LaneFromStraightExtrapolation` (2+ points from `p.x,p.y` along
   `cos(p.angle),sin(p.angle)` stepping `kTraceStepMs`-equivalent spatial steps
   up to `laneCap`), and call it as the final fallback in `TraceLane` before the
   single-point collapse. Before:
   ```cpp
   void TraceLane(...) {
       if (LaneFromCachedPath(...)) return;
       if (LaneFromFreshTrace(...)) return;
       lane.pointCount = 1; lane.points[0] = { p.x, p.y };
   }
   ```
   After: insert `if (LaneFromStraightExtrapolation(lane, p, laneCap)) return;`
   before the single-point collapse. Run:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

3. **Always apply T3 relevance-gate fix.** In `UDodgeCore.cpp:427-436`, unify the
   `directLaneThreats` threshold with the scoring-relevance threshold
   (`c.step + half + kRelevanceClearance`). Replace the `half +
   kRelevanceClearance` comparison at line 435 with `c.step + half +
   kRelevanceClearance`. Rebuild + guardrail as in Step 2.

4. **If Step 1 showed branch (a) (`rawProjs=0`, PJDodge also blind): apply T1.**
   Edit `ProjectileTracking.cpp:258` per the Target design. Rebuild + guardrail.
   (Skip this step entirely if `rawProjs>0`.)

5. **If Step 1 showed branch (b) (`rawProjs>0`, `lanes=0`): apply T2.** Edit the
   localId filter lines in both `BuildMap` (`UDodgeSensors.cpp:301-302`) and
   `ReanchorMap` (`:364-365`) to skip only when `!p.canHitPlayer`. Rebuild +
   guardrail. (Skip if `lanes>0`.)

6. **In-game verify** (see Verification). If the dodge now moves against bullets,
   Stage A is done. Keep all `DBG_FILE_LOG` diagnostics in place (plan 62 removes
   them later).

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

In-game (DodgeMode 7, in a fight with hostile bullets within ~16 tiles):
- `[UDodge] BuildMap DONE lanes=N` shows `N>0`.
- `[UDodge] MOVE ...` lines appear with `|v|>0` when bullets approach (no longer
  a continuous stream of `NO-MOVE ... threats=0 standClr=1e+09`).
- The dodge visibly sidesteps incoming fire.

No completion grep is required for Stage A (it is a behavior fix, not a migration).
Confirm no NEW raw-access violations were introduced (the guardrail above).

## Out of scope
- Do NOT begin the worker-thread split, the whole-map planner, or the boss layer
  (Stages C/D — plans 58-61).
- Do NOT touch `repp/`, `pjdodge/`, `zdodge/` except the shared-infra T1 edit in
  `ProjectileTracking.cpp` (which lives in `dodge/`, not those folders) — and only
  if branch (a) is confirmed.
- Do NOT remove or relocate the `DBG_FILE_LOG` diagnostics (plan 62 owns that).
- Do NOT retune `kRelevanceClearance`, `kIntentSafeClearance`, or the reaction
  margin (plan 51 owns those; they are already widened).
