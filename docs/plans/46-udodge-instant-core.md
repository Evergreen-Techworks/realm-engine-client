# 46 — UDodge Instantaneous Core (clearance-lexicographic Evaluate + spatial field escape, additive)

## Goal

After this plan, `UDodge::Core` has a second, INSTANTANEOUS decision engine —
`Core::Evaluate(const MapInput&, CoreState&, CoreOutput&)` — that scores the
35 candidates against the plan-45 `DangerMap` using pure spatial clearance
(no impact times, no horizons, no lead), plus `Core::PointClear` and a
`Field::FindEscape(const MapInput&, ...)` overload that runs the wall-aware
Dijkstra without arrival/hold time windows. The old time-based overloads stay
untouched and still drive the live engine; nothing calls the new overloads
yet (plan 47 switches the feature shell over and deletes the old ones). The
repo compiles and behaves identically after every step.

Branch: commit on `refactor/unified-gameapi`. Leave the pre-existing
uncommitted `client/build-tools/dev-build.bat` modification alone.

## Dependencies

Plan 45 MUST be merged first (this plan consumes `DangerMap`, `LaneThreat`,
`ZoneThreat`, `MapInput`, `kHugeClearance`, `kCandProbes`, `kCorridorCap`,
`kClearBucket`, `kServerTickSec`, `CoreState.selectedTick/haveTick`,
`CandidateDebug.clearance/softCost/blockDist` — all added by plan 45 to
`internal/src/features/movement/udodge/UDodgeTypes.h`).

Files touched: `internal/src/features/movement/udodge/UDodgeCore.h`,
`UDodgeCore.cpp`, `UDodgeField.h`, `UDodgeField.cpp`. Plans 47-48 touch the
same files afterward — run strictly before them.

## Current state

The live core is time-parameterized throughout
(`internal/src/features/movement/udodge/UDodgeCore.cpp`):

- `Evaluate(const CoreInput&, ...)` (line 681) plans over
  `settings.horizonMs` with `leadMs` folded into every player-position
  projection (`PlayerAt`, lines 76-79).
- Candidate quality = `(impactMs, corridor of impactMs, clearance, ...)`
  lexicographic (`SelectProposedCandidate`, lines 507-544).
- Timed multi-segment escape search: `SweepSegment` (330), `SearchSurvival`
  (400), `RefineWithEscapeSearch` (441).
- Field goal probe `PointDwellClear(in, pos, arrivalMs, holdMs)` (641) and
  the Dijkstra's `s_dist[]` arrival-time bookkeeping
  (`UDodgeField.cpp:24-26, 78-84, 124-125`).
- Emergency threshold is an impact TIME (`kEmergencyOverrideMs`,
  `UDodgeTypes.h:34`; used at `UDodgeCore.cpp:856-859`).
- Hysteresis is wall-clock (`state.selectedUntilMs`, `kHysteresisMs`,
  lines 898-911).

All of that stays in place during this plan; the new engine is added
alongside as overloads.

## Target design

All new code lives in the same namespaces/files as the old. Reuse the
existing pure-math helpers as-is: `MinChebOnSegment`, `Cheb`, `DistPointSeg`
(`UDodgeCore.cpp:93-99`), `Vec2` ops, and the candidate layout constants
(`kStandCandidate`/`kDirectionCount`/`kIntentCandidate`/`kFieldCandidate`).

### Public API additions

`UDodgeCore.h`:

```cpp
// Instantaneous engine (plan 46): scores candidates against the tick-synced
// DangerMap. No time dimension — candidate step segments are evaluated
// against danger lanes / zones at their CURRENT positions.
void Evaluate(const MapInput& in, CoreState& state, CoreOutput& out);

// "Could the player stand at `pos` right now?" — on standable ground
// (walls always block; hazard blocks when safeWalk), outside every danger
// lane (Chebyshev > hitHalf × hitScale) and outside every ACTIVE zone.
// Pending (not-yet-landed) zones do NOT block — they are cost-only.
// Enemy bodies deliberately NOT checked (score-only in this engine).
bool PointClear(const MapInput& in, Vec2 pos);
```

`UDodgeField.h`:

```cpp
// Instantaneous overload (plan 46): same 21×21 half-tile Dijkstra, goal =
// first popped non-start cell where Core::PointClear holds. No arrival
// times; hazard cells cost extra, pending zones and danger lanes cost more
// but stay traversable (transit through danger may be the only way out of a
// boxed-in room — the endpoint itself must be clear).
EscapeResult FindEscape(const MapInput& in);
```

### New core internals (anonymous namespace in `UDodgeCore.cpp`)

New context struct (do not reuse `Ctx` — it is horizon-shaped):

```cpp
struct MapCtx {
    const MapInput*  in = nullptr;
    const DangerMap* m  = nullptr;
    float step = 1.f;       // stepTiles (candidate commitment distance)
    float hitScale = 1.f;
    bool  hazardEscape = false;
    Vec2  dirs[kCandidateCount]{};
    float clearance[kCandidateCount]{};   // min hard clearance along segment (tiles)
    float softCost[kCandidateCount]{};    // pending-zone penetration sum (tiles)
    float blockDist[kCandidateCount]{};   // wall-truncation distance (tiles)
    float enemyClear[kCandidateCount]{};
    float hazardExitDist[kCandidateCount]{};  // distance to first off-hazard probe
    bool  valid[kCandidateCount]{};
    int   relevant[kMaxProjectiles]{};    // lane indices that can matter
    int   relevantCount = 0;
    Vec2  probes[kCandidateCount][kCandProbes + 1]{};  // wall-clipped sample points
    int   probeCount[kCandidateCount]{};
};
```

Helper functions (all new, spatial only):

1. `float LaneDistCheb(const LaneThreat& L, Vec2 p)` — min over the lane
   polyline of Chebyshev distance from `p`: for `pointCount == 1` it is
   `Cheb(points[0] − p)`; else min over segments of
   `MinChebOnSegment(a − p, b − p)` for consecutive points `a,b`.
2. `float ZonePenetration(const ZoneThreat& z, Vec2 a, Vec2 b)` — Euclidean
   `max(0, z.radius − DistPointSeg(z.pos, a, b))` (segment `a→b`; pass
   `a == b` for a point).
3. `void BuildProbes(MapCtx& c, int cand)` — sample the step segment
   `player → player + dirs[cand] × step` at `kCandProbes` equal intervals
   (plus the start point). Walk probes in order through `env.canOccupy`
   (safeWalk honored EXCEPT while `hazardEscape` — hazard is passable
   transit then, mirroring old `CanOccupy` wrapper semantics at
   `UDodgeCore.cpp:43-49`); the first blocked probe at fraction `f` sets
   `blockDist[cand] = f × step` and truncates the probe list there. A block
   at the first probe after the start invalidates the candidate
   (`valid = false`), matching old behavior at line 161. Also fill
   `enemyClear[cand]` (min over probes of distance-to-enemy − radius; reuse
   the shape of `EnemyClearanceAt`, lines 63-71) and `hazardExitDist[cand]`
   (distance of the first probe where `!env.isHazard`, only while
   `hazardEscape`).
4. `void ScoreCandidate(MapCtx& c, int cand)` — hard clearance:
   `clearance[cand] = min over relevant lanes of ( min over surviving probes
   of LaneDistCheb(lane, probe) − hitHalf × hitScale )`, then also
   `min` with active zones: for each active zone,
   `DistPointSeg(z.pos, segStart, segClippedEnd) − z.radius` (exact — the
   candidate segment is straight). Soft cost:
   `softCost[cand] = Σ over pending zones of ZonePenetration(z, segStart,
   segClippedEnd)`. `segClippedEnd` = probe list end (wall truncation).
5. `float CorridorClearance(const MapCtx& c, int cand)` — port of
   `CorridorSafety` (`UDodgeCore.cpp:479-505`) with `cappedImpact` replaced
   by `capped(idx) = valid[idx] ? min(clearance[idx], kCorridorCap) : 0.f`;
   the field-candidate → nearest-compass-index mapping and the
   stand-candidate `× (2·kCorridorNeighbors + 1)` rule carry over verbatim.
6. `bool BetterCandidate(...)` — lexicographic compare used by selection:
   1. bucketed hard clearance: `floor(min(clearance, 1.5f) / kClearBucket)`,
      higher wins;
   2. corridor clearance, higher wins;
   3. soft cost, LOWER wins;
   4. raw hard clearance, higher wins;
   5. enemy clearance, higher wins;
   6. intent dot, higher wins.
7. `int SelectProposed(const MapCtx& c)` — old `SelectProposedCandidate`
   shape (skip `kIntentCandidate`, iterate all others incl. field) using
   `BetterCandidate`.
8. `int SelectHazardEscapeMap(const MapCtx& c, Vec2 intentDir)` — port of
   `SelectHazardEscape` (lines 173-203): primary key =
   `floor(min(hazardExitDist, step) / 0.3f)` bucket (lower wins), then the
   `BetterCandidate` chain.
9. `bool IsVelocitySafeMap(const MapCtx& c, int cand, float scale)` — the
   scaled step segment (`length = step × scale`) must be wall-walkable and
   have hard clearance ≥ `kIntentSafeClearance` and zero active-zone
   penetration (reuse `ScoreCandidate` math on a temporary probe set).
   `SelectAlignedSpeedMap` — same 4-step scale search as
   `SelectAlignedSpeed` (lines 599-613) but calling `IsVelocitySafeMap`.
10. `FinishMap(...)` — like `Finish` (615) but fills the plan-45
    `CandidateDebug` fields (`clearance`, `softCost`, `blockDist`, `dir`,
    `valid`) and, for transitional compatibility until plan 47 deletes them,
    also writes `score = clearance` and leaves `impactMs`/`blockMs` at
    their defaults.

### `Evaluate(const MapInput&, ...)` flow

```
reset out; guard !in.map → return (defaults)
c.step = clamp(in.stepTiles, 0.4, 3.0); c.hitScale = clamp(settings.hitScale, 0.25, 2.5)
build compass dirs (identical to old, lines 698-704); intent = Normalize(intentDir)
init arrays: clearance = kHugeClearance, softCost = 0, blockDist = kHugeClearance,
             enemyClear = kHugeClearance, hazardExitDist = kHugeClearance, valid = true
valid[kFieldCandidate] = false
c.hazardEscape = in.playerOnHazard && settings.safeWalk

── Relevance pass (spatial) ──
for each lane: relevant iff LaneDistCheb(lane, player) ≤ step + hitHalf×hitScale
                                                        + kRelevanceClearance
   direct iff min( LaneDistCheb(lane, player),
                   min over intent-segment probes of LaneDistCheb ) ≤
              hitHalf×hitScale + kRelevanceClearance
zone direct threat:
   active zone: dist(player, z) − radius ≤ kRelevanceClearance
   pending zone: ZonePenetration(z, player, player) > 0
                 or ZonePenetration(z, intentEnd, intentEnd) > 0
if no direct lane, no zone direct threat, and !hazardEscape:
   FinishMap(NoThreat, velocity = intent × speed, overrideActive = false); return

── Score ──
BuildProbes + ScoreCandidate for every candidate (stand candidate: single
point at player; its clearance is the standing clearance)
intent-candidate inheritance: if intent clearance untouched (== kHugeClearance)
   and intent not wall-blocked, inherit stand values (port of lines 767-779)
threatCount = number of lanes/zones whose stand-or-intent clearance ≤
              kRelevanceClearance (mirror of old threatCount bookkeeping)
if (threatCount == 0 && !hazardEscape) || speed ≤ 0 || movementLocked:
   FinishMap(NoThreat / MovementLocked, intent velocity); return

── Field escape (the ONLY fallback layer — no timed search exists) ──
trigger: settings.fieldEscape && speed > 0 && (
   no compass candidate with valid && clearance ≥ kIntentSafeClearance
   || (hazardEscape && no candidate has hazardExitDist < kHugeClearance) )
if triggered: esc = Field::FindEscape(in)   // MapInput overload
   if esc.found: install candidate kFieldCandidate with dir = esc.firstDir,
   BuildProbes + ScoreCandidate for it; out.fieldActive = true,
   out.fieldTarget = esc.target

── Hazard escape ──
if hazardEscape: choice = SelectHazardEscapeMap; commit (adopt into hysteresis
   state: selectedCandidate = choice, selectedTick = in.tickId, haveTick = true);
   FinishMap(HazardEscape, velocity = dirs[choice] × speed); return

── Ladder ──
proposed = SelectProposed
if valid[intent] && clearance[intent] ≥ kIntentSafeClearance && softCost[intent] == 0:
   FinishMap(PreserveSafeIntent, intent velocity, overrideActive = false); return
emergency = clearance[kStandCandidate] ≤ 0        // danger covers where we stand
choice = proposed
if !emergency:
   // Gentle: among candidates with clearance ≥ kIntentSafeClearance pick the
   // most intent-aligned (port of lines 859-869; GentleOverride /
   // GentleManualBlend decisions preserved)
else if hasIntent && clearance[proposed] ≥ kIntentSafeClearance:
   // EmergencyManualBlend: accept clearance ≥ max(kIntentSafeClearance,
   // clearance[proposed] − kEmergencyIntentBand), most intent-aligned
   // (port of lines 871-882)
else if hasIntent:
   // UnavoidableManualBlend: accept clearance ≥ clearance[proposed] −
   // kUnavoidableClearanceBand, most intent-aligned (port of lines 883-895
   // WITHOUT the impact-time band — clearance band only)
── Tick-locked hysteresis (replaces wall-clock kHysteresisMs) ──
held = state.selectedCandidate
if state.haveTick && state.selectedTick == in.tickId
   && valid[held] && clearance[held] ≥ kIntentSafeClearance
   && (!hasIntent || dot(dirs[held],intent) ≥ dot(dirs[choice],intent) − 0.05)
   && clearance[choice] < clearance[held] + kHysteresisScoreGain:
      choice = held
else:
      state.selectedCandidate = choice
state.selectedTick = in.tickId; state.haveTick = true
── Speed match + finish ──
speedScale = (settings.speedScale && choice != stand && clearance[choice] ≥
              kIntentSafeClearance) ? SelectAlignedSpeedMap(...) : 1.f
decision fixups: field candidate winning a pure survival pick →
   Decision::FieldEscape (port of lines 918-922)
FinishMap(decision, velocity = dirs[choice] × speed × speedScale,
          overrideActive = true)
```

Note `earliestImpactMs` in `CoreOutput` is written as
`clearance[kStandCandidate] <= 0 ? 0.f : kMaxTimeMs` for transitional
compatibility (plan 47/48 replace the field); nothing else may compute an
impact time.

### `PointClear` (replaces `PointDwellClear` for the new engine)

```cpp
bool PointClear(const MapInput& in, Vec2 pos)
{
    if (!in.map) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
        return false;                       // wall; hazard when safeWalk
    const float hs = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (each lane) if (LaneDistCheb(lane, pos) <= lane.hitHalf * hs) return false;
    for (each zone) if (zone.active && Len(Sub(zone.pos, pos)) <= zone.radius) return false;
    return true;
}
```

### `Field::FindEscape(const MapInput&)` (`UDodgeField.cpp`)

Copy the existing function (lines 49-131) as the overload body, with these
exact changes:

1. Delete the `speedTilesPerMs` parameter and the `s_dist[]` array entirely
   from the NEW overload (keep a separate local scratch set — name the new
   statics `s_mCost/s_mPrev/s_mDone` so the old overload's statics are
   untouched until plan 47 deletes them).
2. Goal test: `cur != start && Core::PointClear(in, CellWorld(...))` —
   no `arrivalMs`, no `kHoldMs`.
3. Step relaxation penalties: keep `kHazardCost` (40) for hazard cells; add
   `kZoneCost = 25.f` when the cell center has pending-zone penetration > 0,
   and `kLaneCost = 60.f` when the cell center is within
   `hitHalf × hitScale` of any lane (both computed via the `in.map` lists;
   danger is EXPENSIVE but traversable — only walls block, unchanged).
4. First-step guard: `Core::PointClear(in, stepWorld)`.
5. Wall / diagonal no-corner-cutting rules: unchanged.

### Threading / performance

Game-update thread only (same as the old core). Zero heap allocation. Worst
case per frame ≈ 35 candidates × 17 probes × (relevant lanes × ≤23 segments)
Chebyshev evaluations; the relevance pass culls lanes to those within
`step + hitHalf + 1` tiles of the player, so the typical count is well under
the old CCD's per-frame budget (which swept the same math over a 600-2000 ms
horizon plus a 1500-sweep escape search).

## Steps

1. `UDodgeCore.h`: add the two declarations (`Evaluate(MapInput...)`
   overload, `PointClear`).
   `UDodgeCore.cpp`: add the `MapCtx` struct and helpers 1-2
   (`LaneDistCheb`, `ZonePenetration`), and implement `PointClear`.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
2. `UDodgeField.h`/`.cpp`: add the `FindEscape(const MapInput&)` overload
   per the spec (new statics; `kZoneCost`/`kLaneCost` constants).
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
3. `UDodgeCore.cpp`: implement helpers 3-5 (`BuildProbes`, `ScoreCandidate`,
   `CorridorClearance`).
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
4. `UDodgeCore.cpp`: implement helpers 6-10 (`BetterCandidate`,
   `SelectProposed`, `SelectHazardEscapeMap`, `IsVelocitySafeMap` +
   `SelectAlignedSpeedMap`, `FinishMap`).
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
5. `UDodgeCore.cpp`: implement `Evaluate(const MapInput&, ...)` per the flow
   above.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors, and
   `bash internal/tools/check-raw-access.sh` → exit 0.
6. Sanity greps, then commit on `refactor/unified-gameapi` (message:
   `refactor(plan46): udodge instantaneous core + spatial field escape`):
   - `grep -n "Evaluate(const MapInput" internal/src/features/movement/udodge/UDodgeCore.cpp` → present.
   - The NEW code paths must not reference time:
     `sed -n '/Evaluate(const MapInput/,$p' internal/src/features/movement/udodge/UDodgeCore.cpp | grep -nE "horizonMs|leadMs|nowMs|arrivalMs|holdMs|sampleTimesMs"`
     → empty (place the new engine below the old code so this grep works, or
     adapt the range check accordingly).
   Do NOT include `client/build-tools/dev-build.bat` in the commit.

## Verification

- `bash internal/tools/wsl-build.sh Debug` → 0 errors after every step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- No behavior change: nothing calls the new overloads yet; the live engine
  (old `Evaluate(CoreInput...)`) is byte-for-byte untouched.

## Out of scope

- Do NOT modify or delete the old `Evaluate(const CoreInput&)`,
  `PointDwellClear`, `SweepSegment`, `SearchSurvival`,
  `RefineWithEscapeSearch`, `CorridorSafety`, or the old
  `Field::FindEscape(const CoreInput&, float)` — plan 47 deletes them.
- Do NOT touch `UDodge.cpp/.h`, `UDodgeDebug.*`, `UDodgeSensors.*`,
  `UDodgeTypes.h` (beyond what plan 45 already added — if a plan-45 symbol
  is missing, STOP: plan 45 was not merged).
- Do NOT touch `dodge/` shared infrastructure, `repp/`, `pjdodge/`,
  `zdodge/`, any `gui/tabs/*.cpp`, or `internal/tools/check-raw-access.sh`.
- Do NOT touch client/ code.
