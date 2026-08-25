# 44 — UDodge Instantaneous Danger Map: Overview

This is the overview/index for the UDodge redesign workstream (plans 45-49).
It is not itself executable — it records the two design directives, the
NewTick-sync mechanism chosen, the mechanism-by-mechanism replacement table,
the capabilities inherently lost (for the user to judge in testing), the plan
dependency graph, and the global verification commands. It REVISES the design
of record in `docs/plans/30-unified-dodge-overview.md`: UDodge as built by
plans 31-34 was a time-parameterized predictive engine; after this workstream
it is an instantaneous-map engine synchronized to the server tick.

Plan 35 (legacy dodge retirement) remains NOT executed and NOT touched by this
workstream. RePP/PJDodge/ZDodge stay untouched and selectable.

## The two directives (authoritative)

1. **Remove the third dimension (time) completely from UDodge.** All
   time-parameterized prediction machinery — impact-time CCD, command-latency
   lead, prediction horizons, timed escape search, arrival/hold dwell windows,
   per-shot clock calibration usage — is deleted, not left dormant.
2. **Sync the danger map with the NewTick layout on every tick.** Every server
   tick, the danger map is rebuilt from the authoritative current world state,
   so the dodge always operates on the true current layout: "we are in the
   right place every time, there is no ambiguity."

## What "synced with the NewTick layout" means in this codebase

There is no packet hook for NEWTICK inside the DLL. The DLL is injected after
the first NEWTICK (`internal/src/bootstrap/main.cpp:87`) and observes the
game's own post-NewTick state:

- The game's WorldManager exposes a **world tick counter** that increments
  each time the game processes a server NewTick:
  `RuntimeOffsets::WM_TickId` (fallback `0xD8`, BeeByte field `FIAJOKGHGGK`,
  `internal/src/core/runtime/RuntimeOffsets.cpp:101,362`). WorldTAB already
  reads it diagnostically (`gui/tabs/WorldTAB.cpp:540`), and the old planner
  documented tick-boundary rebuilds against it (`dodge/DangerPlanner.h:11`).
- The WorldManager pointer comes from the sanctioned cache
  `GameState::GetWorldMgr()` (`core/runtime/GameState.h:27`).
- At the moment `WM_TickId` changes, the game's entity dictionary, projectile
  instances, and AoE state reflect the just-applied authoritative NewTick.

**Chosen sync mechanism** (implemented in plans 45/47):

- `UDodge::Sensors::ReadWorldTick(uint32_t&)` polls `WM_TickId` once per
  engine tick (one pointer + one u32 `Mem::TryRead` — negligible).
- **On tick change** (`WM_TickId` differs from the map's stamp): full
  `BuildMap` — re-enumerate projectiles, AoE zones, enemies, boss lock from
  live game state. The map is stamped with the tick id it was built from.
- **Between ticks** (same `WM_TickId`): `ReanchorMap` — each danger lane's
  anchor is re-read from the projectile's LIVE position (the game's own
  client-side simulation, the same memory the game renders and collides
  from); zones are re-derived; enemies/lock hold their tick-time layout.
  No positions are ever extrapolated by our own clock — mid-tick frames ride
  the game's own interpolation.
- **Structural change mid-tick** (a projectile spawned or died, detected by
  id-set mismatch during `ReanchorMap`): immediate full `BuildMap`. A shot
  fired mid-tick enters the map on the same frame — this is what preserves
  reaction time against fast projectiles.
- **Fail-safe**: if `WM_TickId` cannot be read (WorldMgr null / stale
  offsets), the engine rebuilds the full map every frame — degraded means
  MORE fresh, never less.
- The controller's commitment (hysteresis) is also tick-locked: a chosen
  heading is held within one server tick and re-decided at each sync, unless
  it becomes unsafe or is clearly beaten. Decisions are made per tick, in the
  right place, every time.

## The instantaneous danger map

The map (`UDodge::DangerMap`) contains only PRESENT-TENSE spatial danger:

- **Danger lanes** (`LaneThreat`): one per hostile projectile — the live
  position (anchor) plus the remaining travel path as a spatial polyline
  (traced from the game's own `positionAt` trajectory geometry; the time
  parameter is used internally by the sensor only to trace the curve shape
  and is discarded — the map stores points, never times). A lane is
  dangerous NOW over its whole length, widened by the game-parity Chebyshev
  hit half (`runtimeChebyshevHalf` → `projHalfSize` → 0.5, unchanged from
  plan 30's divergence decision #1). Lane length is capped by the
  `laneTiles` setting.
- **Zones** (`ZoneThreat`): AoE discs in two present-tense classes:
  `active` (detonated, still alive) = hard danger like a lane;
  pending (telegraphed, not yet landed) = SOFT danger — a cost the planner
  walks out of when free but may cross when it is the only survivable route.
- **Enemy blockers** — unchanged (score-only, never a veto).
- **Boss lock** — unchanged (autopilot goal layer is untouched).

Candidates (unchanged layout: stand + 32 compass + intent + field escape) are
evaluated as SPATIAL step segments `player → player + dir × stepTiles` against
this map. `stepTiles` defaults to one server tick of motion
(`tilesPerSec × 0.2 s`) — the natural planning quantum of a per-tick replanner
— and is the only "step size" knob (a spatial distance, not a horizon).

## Replacement table (every time-based mechanism → its instantaneous successor)

| Removed time mechanism | Where it lives today | Instantaneous replacement |
|---|---|---|
| Time-parameterized threat polylines (`samples` + `sampleTimesMs`) | `udodge/UDodgeTypes.h:74-82`, `UDodgeSensors.cpp:133-197,249-296` | `LaneThreat`: live anchor + remaining-path spatial polyline; times discarded at build |
| Impact-time CCD scoring (relative-motion `MinChebOnSegment`, `impactMs` as primary key) | `udodge/UDodgeCore.cpp:205-259,507-544` | Static clearance: min Chebyshev distance from candidate step segment to lane polyline − hitHalf; clearance is the primary selection key |
| Command-latency lead (`leadMs` folded into `PlayerAt`) | `UDodgeTypes.h:121`, `UDodgeCore.cpp:73-79` | Deleted. Per-frame re-anchoring self-corrects; no lead parameter exists |
| Prediction horizon (`horizonMs`, `kSampleMs` time sweeps) | `UDodgeTypes.h:18,120`, `UDodgeCore.cpp` throughout | Two spatial knobs: `stepTiles` (candidate commitment distance) and `laneTiles` (lane paint length) |
| Corridor safety = Σ neighbor capped `impactMs` | `UDodgeCore.cpp:479-505` | Σ neighbor capped clearances (same ±3 window shape) |
| Timed escape search (`SweepSegment`, `SearchSurvival`, `RefineWithEscapeSearch`, ~200 lines) | `UDodgeCore.cpp:321-476` | Deleted entirely. The Dijkstra field escape is promoted to the general fallback whenever no straight candidate has safe clearance |
| Field dwell probe (`PointDwellClear(arrivalMs, holdMs)`, Dijkstra `s_dist` arrival times) | `UDodgeCore.cpp:641-679`, `UDodgeField.cpp:24-26,78-84,124-125` | `PointClear(pos)` — pure spatial: outside every lane and active zone, on standable ground. Dijkstra keeps hazard cost and gains lane/pending-zone cost penalties; no arrival times |
| AoE landing-instant + lingering time windows (`landingMs`, `remainMs`, `activeNow`) | `UDodgeTypes.h:88-94`, `UDodgeSensors.cpp:298-331`, `UDodgeCore.cpp:261-319` | `ZoneThreat { active }`: active = hard danger disc; pending = soft cost disc. Classification is a present-tense check (has it landed yet), re-derived every frame |
| Emergency threshold by impact time (`kEmergencyOverrideMs = 100 ms`) | `UDodgeTypes.h:34`, `UDodgeCore.cpp:856-896` | Emergency ⇔ standing clearance ≤ 0 (a lane/active zone covers the current position = something WILL pass through where we stand) |
| Wall-clock hysteresis (`kHysteresisMs`, `selectedUntilMs`) | `UDodgeTypes.h:35`, `UDodgeCore.cpp:898-911`, `CoreState` | Tick-locked hold: heading held while `WM_TickId` unchanged; fresh decision at every NewTick |
| Per-shot clock calibration usage (`elapsedCalMs`, `SetPredictionAccuracy`, pred diag lines) | `UDodgeSensors.cpp:266-278`, `UDodge.cpp:188,270-275,302-312,386-390`, `UDodgeDebug.cpp:90-98` | Removed from UDodge (live positions ARE the anchor). `ProjectileTracking`'s calibration itself stays — PJDodge still uses it until plan 35 retires it |
| Speed-match safety over a horizon (`IsVelocitySafe` time loop) | `UDodgeCore.cpp:547-597` | Same probe on the scaled (shorter) step segment — spatial |

## Capabilities inherently lost (judge these in testing)

1. **Time-gap threading.** A lane is dangerous over its whole remaining
   length "now", so the engine will not cross ahead of a distant slow bullet
   even when timing would allow it — it routes around, sidesteps, or waits
   for the per-frame re-anchor to free the space behind the bullet. In very
   dense patterns this is more conservative and can get pinned where the old
   engine threaded a timed gap; the field escape is the mitigation.
2. **Impact ordering.** Two threats are ranked by geometry (penetration /
   clearance), not by which hits first. A bullet aimed at you paints through
   your position (clearance ≤ 0 → emergency) regardless of distance, which
   recovers most of the practical urgency signal, but "hits in 50 ms" vs
   "hits in 900 ms" is no longer distinguishable.
3. **Standing inside a telegraph until just before landing.** Pending zones
   are soft-avoided as soon as they are painted (the engine walks out when
   free). Plan 30's landing-instant AoE win is partially reverted — softened
   (cost, never a veto) rather than RePP's hard whole-lifetime block.
4. **Command-latency lead.** No planning for where the player will be when
   the command lands; per-frame re-planning absorbs most of this in practice.
5. **"Wait, then move" maneuvers.** The deleted multi-segment escape search
   could plan a timed pause; the spatial Dijkstra cannot represent waiting.

What is preserved: instant reaction to fast projectiles (the whole lane is
painted the frame the shot spawns — spawn forces an immediate map rebuild),
exact game hitbox parity, wall/hazard semantics including hazard escape,
the full goal layer (autopilot orbit / lock follow / stand-on), anti-zigzag
hysteresis (now tick-locked), and the wall-aware field escape (now the
first-class fallback rather than a last resort behind the timed search).

## Plans and dependency graph

| Plan | File | Content | Depends on |
|---|---|---|---|
| 45 | `45-udodge-danger-map-foundation.md` | Additive: `DangerMap`/`LaneThreat`/`ZoneThreat`/`MapInput` types, `Sensors::ReadWorldTick` / `BuildMap` / `ReanchorMap`. Old machinery untouched | none |
| 46 | `46-udodge-instant-core.md` | Additive: `Core::Evaluate(MapInput)` overload (clearance-lexicographic, tick hysteresis), `Core::PointClear`, `Field::FindEscape(MapInput)` overload | 45 |
| 47 | `47-udodge-switchover-and-deletion.md` | `UDodge::Tick` driven by tick-sync + new core; debug overlay rewrite; DELETE all old time machinery in `udodge/`; deprecated no-op setter stubs for removed settings | 46 |
| 48 | `48-udodge-wiring-and-diag.md` | Remove stubs + IPC keys `udodgeHorizonMs`/`udodgeLeadMs`/`udodgePredictionAccuracy`, add `udodgeLaneTiles`/`udodgeStepTiles`; DiagView/DiagBridge reshape | 47 |
| 49 | `49-udodge-client-settings.md` | client `contract.ts` + `plugins/auto-dodge.ts`: drop removed keys, add new ones | 48 |

```
45 ──► 46 ──► 47 ──► 48 ──► 49
```

Strictly sequential — each plan builds on symbols the previous one created or
deleted. Do not dispatch any of 46-49 in parallel with its dependency.

All commits go on branch `refactor/unified-gameapi`. A pre-existing
UNCOMMITTED modification to `client/build-tools/dev-build.bat` must be left
alone (do not stage, revert, or commit it).

## Files owned by concurrent work — DO NOT TOUCH in any plan

A concurrent cleanup wave (plans 37-43) owns: `internal/src/gui/tabs/WorldTAB.cpp`,
`internal/src/gui/CamState.cpp`, `internal/src/gui/tabs/PlayerTAB.cpp`,
`internal/src/gui/tabs/CameraTAB.cpp`, `internal/tools/check-raw-access.sh`.
Plan 35 owns `internal/src/features/movement/repp/`, `pjdodge/`, `zdodge/`.
This workstream calls into WorldTAB/TestTAB headers but never edits those
files (the only TestTAB/WorldTAB usage is unchanged calls that already exist).

## Global verification

```bash
# Internal DLL (from WSL; Debug config — the verified path). Run after EVERY step:
bash internal/tools/wsl-build.sh Debug
# → MSBuild reports 0 errors

# Raw-access guardrails (must stay exit 0 after every plan):
bash internal/tools/check-raw-access.sh

# Client (plan 49 only):
cd client && npm run build          # tsc clean

# Workstream-complete greps (all must return NOTHING once 45-49 are merged):
grep -rnE "horizonMs|leadMs|impactMs|sampleTimesMs|landingMs|remainMs|arrivalMs|holdMs|PointDwellClear|SweepSegment|SearchSurvival|RefineWithEscapeSearch|PredictionAccuracy|predEnabled|predClockErr|elapsedCalMs|selectedUntilMs|CoreInput|struct Snapshot|ProjectileThreat|AoeThreat" internal/src/features/movement/udodge/
grep -rn "udodgeHorizonMs\|udodgeLeadMs\|udodgePredictionAccuracy" internal/src client/src client/plugins
```
