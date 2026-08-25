# 47 — UDodge Switchover to the Tick-Synced Map + Deletion of Time Machinery

## Goal

After this plan, the live UDodge engine (DodgeMode 7) runs on the
instantaneous danger map: `UDodge::Tick` syncs the map with the server tick
(`WM_TickId`) every tick, re-anchors it to live positions between ticks, and
calls the plan-46 `Core::Evaluate(MapInput...)`. The debug overlay draws the
map (lanes/zones/tick state). ALL old time-parameterized machinery inside
`internal/src/features/movement/udodge/` is DELETED (not left dormant): the
CCD core, timed escape search, dwell probes, horizons, lead, wall-clock
hysteresis, per-shot clock-calibration usage. Three deprecated no-op setters
remain (`SetHorizonMs`/`SetLeadMs`/`SetPredictionAccuracy`) solely so
`FeatureCommandRegistry.cpp` keeps compiling; plan 48 removes them together
with their IPC keys.

Branch: commit on `refactor/unified-gameapi`. Leave the pre-existing
uncommitted `client/build-tools/dev-build.bat` modification alone.

## Dependencies

Plans 45 and 46 MUST be merged first (this plan consumes
`Sensors::ReadWorldTick/BuildMap/ReanchorMap`, `DangerMap`, `MapInput`,
`Core::Evaluate(MapInput...)`, `Core::PointClear`,
`Field::FindEscape(MapInput)`).

Files touched: `internal/src/features/movement/udodge/UDodge.h`, `UDodge.cpp`,
`UDodgeDebug.h`, `UDodgeDebug.cpp`, `UDodgeTypes.h`, `UDodgeSensors.h`,
`UDodgeSensors.cpp`, `UDodgeCore.h`, `UDodgeCore.cpp`, `UDodgeField.h`,
`UDodgeField.cpp`. Plan 48 touches `UDodge.h/.cpp` afterward — run strictly
before it. Do NOT touch `FeatureCommandRegistry.cpp` or `DiagBridge.cpp`
(plan 48 owns them).

## Current state

The feature shell (`UDodge.cpp`) drives the TIME-based engine:

- `UDodge.cpp:181-284` — `Tick` builds the time snapshot every frame
  (`Sensors::Build`, line 195), pushes the clock-calibration toggle into
  ProjectileTracking (line 188), fills the time-shaped `CoreInput`
  (`nowMs`, line 223) and calls the old `Core::Evaluate` (line 231).
- Settings atomics `g_horizonMs`/`g_leadMs`/`g_predictionAccuracy`
  (lines 27-28, 32) with setters at lines 376-390 and ImGui sliders at
  lines 296-312.
- Debug publish carries horizon/lead/prediction fields (lines 268-275) and
  `d.sensors = g_snapshot` (line 281).
- `UDodgeDebug.cpp` renders the prediction-diag line (90-98), time-fading AoE
  alpha (110-115), and impact-time candidate rays (124-146).
- The old core/sensor/field machinery listed for deletion below is exactly
  the set the overview (`docs/plans/44-udodge-instant-overview.md`) maps to
  instantaneous replacements.

## Target design

### `UDodge.cpp` — settings

- REMOVE atomics `g_horizonMs`, `g_leadMs`, `g_predictionAccuracy`
  (lines 27-28, 32).
- ADD atomics `g_laneTiles{ 12.f }`, `g_stepTiles{ 0.f }`.
- `ReadSettings()` (66-82): drop `horizonMs`/`leadMs`/`predictionAccuracy`
  reads; add
  `s.laneTiles = Clamp(g_laneTiles..., 2.f, 16.f);`
  `s.stepTiles = g_stepTiles <= 0 ? 0.f : Clamp(g_stepTiles..., 0.4f, 3.f);`
- Setter block (376-402): replace `SetHorizonMs`/`GetHorizonMs`,
  `SetLeadMs`/`GetLeadMs`, `SetPredictionAccuracy`/`GetPredictionAccuracy`
  with deprecated no-ops kept ONLY for `FeatureCommandRegistry.cpp`:

```cpp
// Deprecated no-ops — the time dimension was removed (plans 44-48). These
// survive only until plan 48 deletes their IPC keys from the registry.
void  SetHorizonMs(float) {}
void  SetLeadMs(float) {}
void  SetPredictionAccuracy(bool) {}
```

  (delete the three getters; nothing calls them once RenderSettings is
  rewritten). ADD real setters:

```cpp
void  SetLaneTiles(float t) { g_laneTiles.store(Clamp(t, 2.f, 16.f), std::memory_order_relaxed); }
float GetLaneTiles()        { return g_laneTiles.load(std::memory_order_relaxed); }
void  SetStepTiles(float t) { g_stepTiles.store(t <= 0.f ? 0.f : Clamp(t, 0.4f, 3.f), std::memory_order_relaxed); }
float GetStepTiles()        { return g_stepTiles.load(std::memory_order_relaxed); }
```

- `UDodge.h`: update declarations accordingly (keep the three deprecated
  setter declarations with the same comment; remove the three getter
  declarations; add `SetLaneTiles/GetLaneTiles/SetStepTiles/GetStepTiles`).
  Keep `DiagView` UNCHANGED in this plan (plan 48 reshapes it).

### `UDodge.cpp` — `Tick` (the tick-sync driver)

Replace the body between the stats read and the move/debug section
(lines 187-231) with:

```cpp
    const Settings settings = ReadSettings();
    const SteerInput::SteerState steer = SteerInput::Get();

    int32_t hp = 0, maxHp = 0;
    float spd = 0.f, tilesPerSec = 0.f;
    TestTAB::ReadDodgePlayerStats(hp, maxHp, spd, tilesPerSec);

    // ── NewTick sync ─────────────────────────────────────────────────────
    // The map LAYOUT is rebuilt from authoritative game state every server
    // tick (WM_TickId change). Between ticks, lanes are re-anchored to the
    // game's own live projectile positions (never extrapolated by our
    // clock). A structural change (projectile spawned/retired mid-tick)
    // forces an immediate rebuild so a new shot is visible the same frame.
    // If the tick counter is unreadable (stale offsets), rebuild every
    // frame — the fail-safe direction is fresher, never staler.
    uint32_t tick = 0;
    const bool tickOk = Sensors::ReadWorldTick(tick);
    bool synced = false;
    if (tickOk && g_map.tickValid && g_map.tickId == tick)
        synced = Sensors::ReanchorMap(g_map, px, py, settings);
    const bool rebuilt = !synced;
    if (rebuilt) {
        Sensors::BuildMap(g_map, px, py, settings);
        g_map.tickId = tick;
        g_map.tickValid = tickOk;
    }
    if (g_map.projectileSourceUnavailable) {
        g_state.Reset();
        PublishMinimal(Decision::None, { px, py });
        return;
    }

    MapInput in{};
    in.player = { px, py };
    // (intent priority chain IDENTICAL to the old code at lines 205-220,
    //  with g_snapshot replaced by g_map — AutopilotIntent's parameter type
    //  changes from `const Snapshot&` to `const DangerMap&`; its body reads
    //  only hasLock/lockPos, which DangerMap also has.)
    in.speed = std::max(0.f, std::isfinite(tilesPerSec) ? tilesPerSec : 0.f) / 1000.f;
    in.stepTiles = settings.stepTiles > 0.f
        ? settings.stepTiles
        : std::clamp(std::max(0.f, tilesPerSec) * kServerTickSec, 0.4f, 3.0f);
    in.tickId = g_map.tickId;
    in.movementLocked = false;
    in.playerOnHazard = settings.safeWalk && Sensors::IsHazardAt(px, py);
    in.settings = settings;
    in.env.canOccupy = &Sensors::CanOccupy;
    in.env.isHazard = &Sensors::IsHazardAt;
    in.map = &g_map;

    Core::Evaluate(in, g_state, g_out);
```

- The global `Snapshot g_snapshot` (line 42) becomes `DangerMap g_map`.
- DELETE the `ProjectileTracking::SetPredictionAccuracy(...)` call
  (line 188) — UDodge no longer touches the calibration toggle (it remains
  the property of the legacy engines until plan 35).
- The move/auto-walk block (233-252) is unchanged (`g_out.velocity` is still
  tiles/ms; `moveTarget = player + velocity × frameMs`).
- Debug publish block (254-283): fill the NEW `DebugSnapshot` fields (below);
  drop the `PredictionDiag` block (270-275); `d.map = g_map;`
  `d.tickId = g_map.tickId; d.tickValid = g_map.tickValid;
  d.rebuiltThisFrame = rebuilt; d.stepTiles = in.stepTiles;
  d.standClearance = g_out.standClearance;` (see CoreOutput change below).
- `GetDiagView()` (343-374): keep the existing `DiagView` struct shape
  compiling — fill `earliestImpactMs = -1.f`, `predEnabled = false`,
  `predCalibrated = 0`, `predClockErrMs = predModelErrTiles =
  predModelMaxTiles = 0.f`; delete the `GetPredictionDiag` call. Everything
  else maps as before. (Plan 48 reshapes the struct + DiagBridge together.)
- `RenderSettings()` (286-332): remove the Horizon/Lead sliders (296-297),
  the prediction-accuracy checkbox + tooltip + `clk/model` readout
  (302-312); add:

```cpp
    float lane = GetLaneTiles();
    if (ImGui::SliderFloat("Danger lane length (tiles)##udodge", &lane, 2.f, 16.f)) SetLaneTiles(lane);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("How far ahead of each bullet its danger lane is painted.\n"
                          "Longer = react earlier to distant shots; shorter = only\n"
                          "dodge nearby bullets.");
    float stepT = GetStepTiles();
    if (ImGui::SliderFloat("Step distance (tiles, 0 = auto)##udodge", &stepT, 0.f, 3.f)) SetStepTiles(stepT);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Candidate commitment distance. 0 = one server tick of\n"
                          "motion (tilesPerSec x 0.2s) — the natural quantum of a\n"
                          "per-tick replanner.");
```

### `UDodgeTypes.h` — `DebugSnapshot` replacement (with `UDodgeDebug.cpp` in the same step)

Replace the whole struct (lines 199-226) with:

```cpp
// Published to the overlay each frame (read on the render thread).
struct DebugSnapshot {
    bool     active = false;
    Decision decision = Decision::None;
    Vec2  player{};
    Vec2  intentDir{};
    Vec2  moveTarget{};
    bool  overrideActive = false;
    bool  moveFailed = false;
    int   candidate = kStandCandidate;
    float speedScale = 1.f;
    int   threatCount = 0;
    float standClearance = kHugeClearance;  // ≤ 0 = danger covers current position
    float speed = 0.f;        // tiles/ms — for drawing candidate rays
    float stepTiles = 1.f;
    uint32_t tickId = 0;      // map's NewTick stamp
    bool  tickValid = false;
    bool  rebuiltThisFrame = false;  // true = full layout rebuild; false = re-anchored
    bool  fieldActive = false;
    Vec2  fieldTarget{};
    bool  hasLockTarget = false;
    Vec2  lockTarget{};
    CandidateDebug candidates[kCandidateCount]{};
    DangerMap map{};
};
```

### `UDodgeDebug.cpp` — overlay rewrite (structure preserved, content per-map)

- Header line:
  `"UDodge [%s]  threats:%d  lanes:%d  zones:%d  clear:%s  step:%.1ft  tick:%u %s"`
  where `clear` prints `standClearance` (or `"safe"` when ≥ `kHugeClearance`)
  and the trailing token is `"SYNC"` when `rebuiltThisFrame` else `"hold"`;
  when `!tickValid` print `"tick:--(deg)"`. Delete the prediction line
  (90-98).
- Lanes: for each `map.lanes[i]` draw the polyline
  (`points[j] → points[j+1]`, red `IM_COL32(235,80,80,110)`, 1.5f) and an
  anchor dot at `points[0]` — same visual as the old projectile paths
  (101-107).
- Zones: pending (`!active`) = orange circle `IM_COL32(240,150,30,100)`;
  active = `IM_COL32(255,90,40,190)` with 3.f thickness. (Replaces the
  landing-time alpha fade at 110-115 — there is no landing time.)
- Candidate fan (124-137 replacement): ray end =
  `player + dir × min(stepTiles, blockDist)`; grey when `!valid`; green when
  `clearance ≥ kIntentSafeClearance`; else gradient by
  `f = clamp(clearance / 0.5f, 0, 1)` → `IM_COL32(230, 60+160·f, 50, 130)`;
  selected candidate thickness 3.f.
- Field candidate ray (140-146): same replacement rule for its length.
- Field pocket marker, autopilot lock reticle, intent line, move-target dot
  (148-175): unchanged.
- The committed-move ray (171-174) keeps its `× 300.f` visual scale (it is a
  drawing length, not a prediction).

### `UDodgeCore` / `UDodgeField` / `UDodgeSensors` / `UDodgeTypes` — deletions

`CoreOutput` change first: rename `earliestImpactMs` → `standClearance`
(default `kHugeClearance`) and update the plan-46 `FinishMap`/`Evaluate` to
fill it with `clearance[kStandCandidate]`. `threatCount` unchanged.

Then DELETE (every item below must be gone, not commented out):

- `UDodgeCore.cpp`: old `Evaluate(const CoreInput&, ...)` (681-926), `Ctx`
  (24-41), `CanOccupy`/`IsHazard` Ctx wrappers (43-55), `HalfOf` (58-61),
  `EnemyClearanceAt` (63-71) if now unused by new code, `PlayerAt` (76-79),
  `ThreatLerp` (82-89), `ClassifyProjectile` (104-143),
  `ValidateCandidatePaths` (146-165), `SelectHazardEscape` (173-203),
  `ScoreProjectile` (209-259), `ScoreAoes` (261-319), `SweepSegment`
  (330-393), `SearchResult`/`SearchSurvival` (395-435),
  `RefineWithEscapeSearch` (441-476), `CorridorSafety` (479-505),
  `SelectProposedCandidate` (507-544), `IsVelocitySafe` (547-597),
  `SelectAlignedSpeed` (599-613), `Finish` (615-633), `PointDwellClear`
  (641-679), and the timed-search constants `kSearchSeeds`, `kSearchDepth`,
  `kSearchBudget`, `kMinSegmentMs`, `kBranchBackoffMs`, `kDepth1Dirs`,
  `kDepth2Dirs`, `kTimingPadMs` (12-22). KEEP: `MinChebOnSegment` users
  (`DistPointSeg` stays — the new engine uses it).
- `UDodgeCore.h`: the old `Evaluate(const CoreInput&, ...)` and
  `PointDwellClear` declarations; refresh the header comment to describe the
  instantaneous engine.
- `UDodgeField.cpp/.h`: the old `FindEscape(const CoreInput&, float)`
  overload, its `s_cost/s_dist/s_prev/s_done` statics if the new overload
  used separate ones (consolidate to ONE set of statics named
  `s_cost/s_prev/s_done` — no `s_dist`), and `kHoldMs`.
- `UDodgeSensors.cpp`: `Build()` (201-332) and its now-unused helpers
  `AddSample` (81-86), `AddCachedPath` (133-157), `AddFreshPath` (169-197),
  `IsCurved` if unused, and `kPathPadMs` (22). KEEP `TryPredict`,
  `CachedAnchorIndex`, the hazard memo, `IsHazardAt`, `CanOccupy`, and
  everything plan 45 added.
- `UDodgeSensors.h`: the `Build` declaration.
- `UDodgeTypes.h`: `kSampleMs` (18), `kMaxTimeMs` (19) — replace every
  remaining reference (including `CandidateDebug` defaults from plan 45)
  with `kHugeClearance`; `kUnavoidableImpactBandMs` (32),
  `kEmergencyOverrideMs` (34), `kHysteresisMs` (35); `ProjectileThreat`
  (74-82); `AoeThreat` (88-94); `Snapshot` (103-117); `CoreInput` (166-176);
  `Settings.horizonMs/leadMs/predictionAccuracy` (120-121, 125);
  `CandidateDebug.score/impactMs/blockMs` (160-162);
  `CoreState.selectedUntilMs` (194) and its `Reset()` mention. KEEP
  `kRelevanceClearance`, `kIntentSafeClearance`, `kEmergencyIntentBand`,
  `kUnavoidableClearanceBand`, `kHysteresisScoreGain`, `kCorridorNeighbors`,
  all plan-45 additions, `Decision`, `Env`, `EnemyBlocker`, `Vec2` math.

Divergence warnings (decisions of record — do not "fix" while migrating):

1. The intent-preservation gate gains `softCost == 0`: standing in a
   telegraphed zone now triggers a gentle walk-out even when no projectile
   threatens. This is the plan-44 decision (pending zones are soft-avoided);
   it intentionally differs from the old landing-instant behavior.
2. Emergency classification changes from "impact < 100 ms" to "standing
   clearance ≤ 0". Both mean "a hit is coming where I stand"; the spatial
   form is the intended semantic.
3. Hysteresis hold window changes from 100 ms wall-clock to "within the same
   server tick" (~200 ms). Slightly stickier by design — decisions re-made
   at every NewTick sync.

## Steps

1. `UDodgeTypes.h`: rename `CoreOutput.earliestImpactMs` →
   `standClearance` (default `kHugeClearance`); replace `DebugSnapshot`
   with the new shape. `UDodgeCore.cpp`: update the plan-46 `FinishMap` /
   new `Evaluate` to fill `standClearance`; update the OLD `Evaluate`/
   `Finish` minimally so they still compile (write `standClearance = 0.f`
   when the old `earliestImpactMs` computation found an impact, else
   `kHugeClearance` — the old path is deleted in step 3, exactness is
   irrelevant). `UDodge.cpp` + `UDodgeDebug.cpp`: switch `Tick` to the
   tick-sync driver + `MapInput` + new debug publish per the spec;
   `AutopilotIntent` parameter type → `const DangerMap&`; rewrite the
   overlay per the spec; settings surgery (atomics, `ReadSettings`,
   deprecated no-ops, new setters, `RenderSettings`); `GetDiagView`
   compatibility fill. `UDodge.h`: declaration updates.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
2. In-code sanity: `grep -n "Sensors::Build(\|g_snapshot\|nowMs" internal/src/features/movement/udodge/UDodge.cpp`
   → empty. Commit checkpoint allowed (message:
   `refactor(plan47a): udodge switched to tick-synced instantaneous map`).
3. `UDodgeCore.cpp/.h`: delete the old engine per the deletion list.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
4. `UDodgeField.cpp/.h`: delete the old overload, consolidate statics,
   remove `kHoldMs`. Also rewrite the stale header comments: the
   `UDodgeField.h` block comment (lines 16-21) references
   `Core::PointDwellClear(in, cell, arrivalMs, kHoldMs)` and
   `speedTilesPerMs` — reword to describe the spatial `Core::PointClear`
   goal test (banned words in comments trip the step-7 grep too).
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
5. `UDodgeSensors.cpp/.h`: delete `Build` + dead helpers per the list.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
6. `UDodgeTypes.h`: delete the listed types/constants/fields; fix any
   remaining `kMaxTimeMs` references to `kHugeClearance`.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors and
   `bash internal/tools/check-raw-access.sh` → exit 0.
7. Completion greps (all must be EMPTY — note `UDodge.h`'s `DiagView` and
   the three deprecated setters are checked separately because plan 48
   removes them):
   ```
   grep -rnE "horizonMs|leadMs|impactMs|sampleTimesMs|landingMs|remainMs|arrivalMs|holdMs|PointDwellClear|SweepSegment|SearchSurvival|RefineWithEscapeSearch|elapsedCalMs|selectedUntilMs|CoreInput|struct Snapshot|ProjectileThreat|AoeThreat|kMaxTimeMs|kSampleMs|kEmergencyOverrideMs|kHysteresisMs\b" \
       internal/src/features/movement/udodge/UDodgeTypes.h \
       internal/src/features/movement/udodge/UDodgeCore.h \
       internal/src/features/movement/udodge/UDodgeCore.cpp \
       internal/src/features/movement/udodge/UDodgeField.h \
       internal/src/features/movement/udodge/UDodgeField.cpp \
       internal/src/features/movement/udodge/UDodgeSensors.h \
       internal/src/features/movement/udodge/UDodgeSensors.cpp \
       internal/src/features/movement/udodge/UDodgeDebug.cpp
   grep -rn "PredictionAccuracy" internal/src/features/movement/udodge/UDodge.cpp
   ```
   The second grep must show ONLY the deprecated no-op
   `SetPredictionAccuracy(bool) {}` line.
   Commit on `refactor/unified-gameapi` (message:
   `refactor(plan47): delete udodge time machinery — instantaneous map only`).
   Do NOT include `client/build-tools/dev-build.bat` in any commit.

## Verification

- `bash internal/tools/wsl-build.sh Debug` → 0 errors after every step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- Step-7 greps empty as specified.
- Optional in-game smoke (if the user runs it): enable Test → dodge mode 7;
  overlay must show lanes as red polylines, tick counter advancing ~5/s with
  `SYNC` flashes on tick boundaries and `hold` between them, and the engine
  must sidestep out of a bullet lane.

## Out of scope

- Do NOT touch `FeatureCommandRegistry.cpp`, `FeatureState.cpp`,
  `DiagBridge.cpp`, `TestTAB.cpp` (dispatch/UI callers are compatible: they
  call `UDodge::SetEnabled/OnEnter/Tick/RenderSettings/RenderDebugOverlay/
  GetDiagView`, all of which keep their signatures). Plan 48 owns the
  registry/diag reshape.
- Do NOT touch `dodge/` shared infrastructure (`ProjectileTracking`,
  `AoeTracking`, `DangerPlanner`, `MovementRuntime`, `SteerInput`) —
  UDodge only consumes their existing APIs.
- Do NOT touch `repp/`, `pjdodge/`, `zdodge/` (plan 35 owns them), nor
  `gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp`, `gui/tabs/PlayerTAB.cpp`,
  `gui/tabs/CameraTAB.cpp`, `internal/tools/check-raw-access.sh`
  (concurrent wave 37-43 owns them).
- Do NOT touch client/ code.
- Do NOT remove `ProjectileTracking::SetPredictionAccuracy` or the
  calibration machinery itself — PJDodge still uses it until plan 35.
