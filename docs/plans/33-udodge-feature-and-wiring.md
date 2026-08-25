# 33 — UDodge Feature Shell + Internal Wiring

## Goal
After this plan, UDodge is a selectable, fully-wired dodge engine inside the
DLL: `UDodge.{h,cpp}` (feature shell: knobs, tick, goal layer, movement
application, diagnostics) and `UDodgeDebug.{h,cpp}` (overlay) exist;
`TestTAB::DodgeMode` has a `UDodge = 7` entry; the `DangerPlanner` detour
dispatches it; `FeatureCommandRegistry` accepts `udodge*` IPC keys;
`FeatureState`'s mode clamp admits mode 7; `DiagBridge` publishes a `udodge`
diagnostics block. Selecting any OTHER mode behaves exactly as before.

Context: plans 31-32 created the sensor pipeline (`UDodgeSensors`), decision
core (`UDodgeCore`), and field escape (`UDodgeField`) under
`internal/src/features/movement/udodge/`. This plan adds the feature shell
that drives them, modeled on the existing PJDodge shell
(`internal/src/features/movement/pjdodge/PJDodge.cpp`, 300 lines) plus the
goal layer from RePP (`internal/src/features/movement/repp/RePP.cpp:96-154`:
weapon-range orbit of a boss lock, opt-in stand-on-object walking), and wires
the engine into the five registration points every dodge engine touches.

## Dependencies
- **Plan 32 must be merged first** (uses `UDodgeCore.h`, `UDodgeField`
  output fields, `UDodgeSensors.h`).

Files this plan touches that other plans also touch:
- `internal/il2cpp-dll-injection.vcxproj` / `.filters` (same ItemGroups as
  plans 31/32).
- `internal/src/gui/tabs/TestTAB.{h,cpp}`,
  `internal/src/features/movement/dodge/DangerPlanner.cpp`,
  `internal/src/features/control/{FeatureState.cpp,FeatureCommandRegistry.cpp}`,
  `internal/src/core/runtime/DiagBridge.cpp` — plan 35 (retirement) edits
  these again later; nothing else concurrent.

## Current state
How an engine is registered today (all five points, with the PJDodge row as
the template to clone):

1. **Mode enum** — `internal/src/gui/tabs/TestTAB.h:10-18`:
   `enum class DodgeMode { Off=0, XDodge=1, RolloutGrid=2, RolloutQuad=3,
   ZDodge=4, RePP=5, PJDodge=6 };`
2. **Mode transitions** — `internal/src/gui/tabs/TestTAB.cpp:141-204`
   (`ApplyDodgeModeWithEnter`): mutual-exclusive `SetEnabled` fan-out (lines
   165-169), a `DBG_FILE_LOG` listing the modes (172-178), and per-mode
   `OnEnter()` + `DangerPlanner::TryInstall()` branches (179-204). Range
   clamp for incoming IPC values at `TestTAB.cpp:1414-1415`
   (`v <= static_cast<int>(DodgeMode::PJDodge)`) and the store clamp at
   `internal/src/features/control/FeatureState.cpp:46`
   (`ClampInt(mode, 0, static_cast<int>(TestTAB::DodgeMode::PJDodge))`).
3. **Per-frame dispatch** — `internal/src/features/movement/dodge/DangerPlanner.cpp:724-782`
   (`RunDodgeTickBody`): `IsEnabled()` gate collection (725-730), BootGate
   degraded gate, player resolution, `SteerInput::Tick()` +
   `ResolveEnemyLock`, then priority dispatch
   `if (pjOn) PJDodge::Tick(...) else if (reppOn) ... else XDodge::Tick(...)`
   (773-777), then `GhostHit::Tick` (780).
4. **IPC keys** — `internal/src/features/control/FeatureCommandRegistry.cpp`:
   one `Apply<Engine>Feature` table per engine (PJDodge's at 222-235),
   chained in `FeatureCommandRegistry::Apply` (303-315).
5. **UI + overlay + diag** — `TestTAB.cpp:926-951` (mode combo labels +
   per-mode `RenderSettings()`), `TestTAB.cpp:616-627` (per-engine
   `RenderDebugOverlay` gated on `IsEnabled()`),
   `internal/src/core/runtime/DiagBridge.cpp:299-331` (RePP + PJDodge
   `DiagView` JSON blocks).

The shell patterns being ported:
- `PJDodge.cpp:41-51` — heap-backed `DebugSlot()` (LTCG const-promotion
  workaround; KEEP the comment, it documents a real crash).
- `PJDodge.cpp:108-203` — `Tick`: settings snapshot → prediction-accuracy
  push → `SteerInput` → `TestTAB::ReadDodgePlayerStats` → sensors → intent
  selection → `Core::Evaluate` → lock-walk wall probe (159-169) → movement
  via `DodgeRuntime::CallMoveTo` (171-175) → debug publish (177-202, note
  the `static DebugSnapshot d;` kept off the stack).
- `RePP.cpp:96-154` — `OrbitIntent` (weapon range × 0.85 band via
  `AutoAim::IsProjRangeResolved`/`GetProjRangeTiles`, tangential orbit inside
  the band) and `AutopilotIntent` (priority: stand-on object scan over
  `WorldTAB::GetEntities` gated behind `followLantern`; else boss lock).

## Target design

### `UDodge.h` — public API (namespace `UDodge`)
Clone the shape of `internal/src/features/movement/pjdodge/PJDodge.h`:
```cpp
#pragma once
#include <cstdint>

namespace UDodge {

struct DiagView {
    bool  enabled = false;
    int   decision = 0;
    float playerX = 0.f, playerY = 0.f;
    bool  overrideActive = false;
    float velXPerSec = 0.f, velYPerSec = 0.f;
    int   candidate = 0;
    float speedScale = 1.f;
    int   threatCount = 0;
    float earliestImpactMs = 0.f;
    int   projectiles = 0, aoes = 0, enemies = 0;
    bool  fieldActive = false;
    bool  hasLockTarget = false;
    float lockX = 0.f, lockY = 0.f;
    bool  predEnabled = false;
    int   predCalibrated = 0;
    float predClockErrMs = 0.f, predModelErrTiles = 0.f, predModelMaxTiles = 0.f;
};

void SetEnabled(bool enabled);
bool IsEnabled();
void OnEnter();
void Tick(void* player, float px, float py, float dt);   // game-update thread
void RenderSettings();                                    // render thread (Test tab)
void RenderDebugOverlay(float camX, float camY, float angle, float zoom, float cx, float cy);
DiagView GetDiagView();

// Knobs (atomics; IPC + GUI). Clamps: horizon [200,2000], lead [0,250],
// hitScale [0.25,2.5], standOnType any int, mode {0,1}.
void  SetHorizonMs(float ms);         float GetHorizonMs();
void  SetLeadMs(float ms);            float GetLeadMs();
void  SetHitScale(float s);           float GetHitScale();
void  SetSafeWalk(bool en);           bool  GetSafeWalk();
void  SetSpeedScale(bool en);         bool  GetSpeedScale();
void  SetPredictionAccuracy(bool en); bool  GetPredictionAccuracy();
void  SetFieldEscape(bool en);        bool  GetFieldEscape();
void  SetDebugOverlay(bool en);       bool  GetDebugOverlay();
void  SetMode(int mode);              int   GetMode();       // 0=Assist 1=Autopilot
void  SetLockFollow(bool en);         bool  GetLockFollow();
void  SetFollowLantern(bool en);      bool  GetFollowLantern();
void  SetStandOnType(int t);          int   GetStandOnType();

} // namespace UDodge
```

### `UDodge.cpp` — feature shell
Clone `PJDodge.cpp` structure (atomics, `ReadSettings` with the clamps
above, heap-backed `DebugSlot()` WITH its explanatory comment, `PublishDebug`
under `g_debugMutex`, `SetEnabled`/`OnEnter` calling
`ProjectileTracking::Install()` and resetting `CoreState` + debug), with
these changes:

1. **Intent selection** in `Tick` (replaces `PJDodge.cpp:130-141`) —
   priority: WASD → Autopilot goal → lock-follow external goal:
```cpp
    bool intentIsAuto = false, apHasTarget = false;
    Vec2 apTarget{};
    if (steer.active) {
        in.intentDir = { steer.dirX, steer.dirY };
    } else if (settings.mode == 1 /*Autopilot*/) {
        in.intentDir = AutopilotIntent(g_snapshot, in.player, settings, apHasTarget, apTarget);
        intentIsAuto = true;
    } else if (settings.lockFollow) {
        float gx = 0.f, gy = 0.f;
        if (DangerPlanner::GetExternalGoal(gx, gy)) {
            const float dx = gx - px, dy = gy - py, d = std::sqrt(dx*dx + dy*dy);
            if (d > 0.3f) { in.intentDir = { dx/d, dy/d }; intentIsAuto = true; }
        }
    }
```
   `AutopilotIntent` + `OrbitIntent` are ports of `RePP.cpp:96-154` with two
   substitutions: the boss lock comes from the snapshot fields
   (`g_snapshot.hasLock` / `g_snapshot.lockPos` — plan 31 put them there)
   instead of `sn.hasLock`; the settings fields are
   `settings.followLantern` / `settings.standOnType`. Keep the stand-on
   scan's `WorldTAB::GetEntities()` + `GetEntityLivePos` usage and its
   perf-warning comment.
2. **Auto-walk** (generalizes `PJDodge.cpp:159-169`'s lockWalk): when the
   core does not override, the intent is machine-generated, and the core
   judged the intent safe, walk it — with the same wall probe:
```cpp
    bool autoWalk = false;
    if (!g_out.overrideActive && intentIsAuto && LenSq(in.intentDir) > 1e-6f &&
        (g_out.decision == Decision::NoThreat || g_out.decision == Decision::PreserveSafeIntent)) {
        const Vec2 probe = Add(in.player, Mul(g_out.velocity, std::max(frameMs, 100.f)));
        autoWalk = Sensors::CanOccupy(probe.x, probe.y, settings.safeWalk);
    }
    if (g_out.overrideActive || autoWalk) {
        moveTarget = Add(in.player, Mul(g_out.velocity, frameMs));
        if (!DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y)) moveFailed = true;
    }
```
3. **CoreInput env**: `in.env.canOccupy = &Sensors::CanOccupy; in.env.isHazard
   = &Sensors::IsHazardAt;` and `in.playerOnHazard = settings.safeWalk &&
   Sensors::IsHazardAt(px, py);` exactly as `PJDodge.cpp:146-150`.
4. **Debug publish**: as `PJDodge.cpp:177-202` plus the new fields
   (`fieldActive`, `fieldTarget`, `hasLockTarget = apHasTarget`,
   `lockTarget = apTarget`).
5. **DiagView**: as `PJDodge.cpp:251-278` plus `fieldActive`,
   `hasLockTarget`/`lockX`/`lockY`.
6. **RenderSettings** (ImGui, render thread): sliders/checkboxes for every
   knob, `##udodge` suffixes, cloned from `PJDodge.cpp:205-240` + RePP's
   mode combo / lantern controls (`RePP.cpp:307-317`). Include the
   prediction-diag readout line (`PJDodge.cpp:226-230`).
7. Includes: `"UDodgeTypes.h"`, `"UDodgeCore.h"`, `"UDodgeSensors.h"`,
   `"UDodgeDebug.h"`, `"MovementRuntime.h"`, `"ProjectileTracking.h"`,
   `"SteerInput.h"`, `"DangerPlanner.h"`, `"AutoAim.h"`,
   `"gui/tabs/TestTAB.h"`, `"gui/tabs/WorldTAB.h"` (bare names resolve via
   the include path; first include stays `"pch-il2cpp.h"`).

### `UDodgeDebug.{h,cpp}` — overlay
Port `internal/src/features/movement/pjdodge/PJDodgeDebug.{h,cpp}` (namespace
→ `UDodge::Debug`), then add:
- Banner decision text for `Decision::FieldEscape` (`"field-escape"`) in
  `DecisionText`.
- Field pocket marker: when `snap.fieldActive`, draw a hollow yellow circle
  + line from player to `snap.fieldTarget` (reuse `DrawWorldCircle` /
  `DrawLine`).
- Autopilot lock reticle: when `snap.hasLockTarget`, the red circle+cross
  from `internal/src/features/movement/repp/ReppDebug.cpp:116-123`.
- Candidate fan (`PJDodgeDebug.cpp:123-136`) loop already covers indices
  `1..kDirectionCount`; additionally draw the field candidate
  (`kFieldCandidate`) ray in orange when `snap.candidates[kFieldCandidate].valid`.

### Wiring edits (exact)
1. `internal/src/gui/tabs/TestTAB.h:17` — append `UDodge = 7,  // Unified dodge (PJDodge core + RePP field/goal layer).`
2. `internal/src/gui/tabs/TestTAB.cpp`:
   - top includes: add `#include "features/movement/udodge/UDodge.h"`.
   - `ApplyDodgeModeWithEnter` (141-204): add
     `UDodge::SetEnabled(nextMode == DodgeMode::UDodge);` beside lines
     165-169; extend the `DBG_FILE_LOG` mode list string (172-178) with
     `7=UDodge` and ` UDodge=" << UDodge::IsEnabled()`; add the enter branch
     `else if (nextMode == DodgeMode::UDodge) { UDodge::OnEnter(); DangerPlanner::TryInstall(); }`.
   - clamp at 1414: `(v >= 0 && v <= static_cast<int>(DodgeMode::UDodge))`.
   - mode combo labels (~line 928): append `"Unified"` to `modeLabels[]`.
   - settings dispatch (~939-951): add
     `else if (g_dodgeMode == DodgeMode::UDodge) { ImGui::Spacing(); UDodge::RenderSettings(); }`.
   - overlay dispatch (~616-627): add
     `if (UDodge::IsEnabled()) { UDodge::RenderDebugOverlay(camX, camY, angleRad, zoom, cx, cy); }`.
3. `internal/src/features/control/FeatureState.cpp:46` — clamp bound
   `TestTAB::DodgeMode::PJDodge` → `TestTAB::DodgeMode::UDodge`.
4. `internal/src/features/movement/dodge/DangerPlanner.cpp`:
   - includes: add `#include "features/movement/udodge/UDodge.h"`.
   - line 729: add `const bool uniOn = UDodge::IsEnabled();`; extend the
     gate on 730 with `|| uniOn`; dispatch (773-777) becomes
     `if (uniOn) UDodge::Tick(p, px, py, dt); else if (pjOn) ...` (UDodge
     first — it is the newest engine and mutual exclusivity is enforced at
     mode switch anyway).
5. `internal/src/features/control/FeatureCommandRegistry.cpp`:
   - includes: add `#include "features/movement/udodge/UDodge.h"` (note the
     other engines use bare includes because their dirs are on the include
     path; udodge is not — use the subpath).
   - add next to `ApplyPJDodgeFeature` (222-235):
```cpp
    bool ApplyUDodgeFeature(const FeatureCommand& f)
    {
        static const FeatureHandler h[] = {
            FH_FLOAT("udodgeHorizonMs", UDodge::SetHorizonMs),
            FH_FLOAT("udodgeLeadMs", UDodge::SetLeadMs),
            FH_FLOAT("udodgeHitScale", UDodge::SetHitScale),
            FH_INT_BOOL("udodgeSafeWalk", UDodge::SetSafeWalk),
            FH_INT_BOOL("udodgeSpeedScale", UDodge::SetSpeedScale),
            FH_INT_BOOL("udodgePredictionAccuracy", UDodge::SetPredictionAccuracy),
            FH_INT_BOOL("udodgeFieldEscape", UDodge::SetFieldEscape),
            FH_INT_BOOL("udodgeDebugOverlay", UDodge::SetDebugOverlay),
            FH_INT("udodgeMode", UDodge::SetMode),
            FH_INT_BOOL("udodgeLockFollow", UDodge::SetLockFollow),
            FH_INT_BOOL("udodgeFollowLantern", UDodge::SetFollowLantern),
            FH_INT("udodgeStandOnType", UDodge::SetStandOnType)
        };
        return ApplyFeatureTable(f, h, sizeof(h) / sizeof(h[0]));
    }
```
   - chain it in `Apply` (303-315) after `ApplyPJDodgeFeature`.
6. `internal/src/core/runtime/DiagBridge.cpp` — include
   `"features/movement/udodge/UDodge.h"`, and after the pjdodge block
   (313-331) emit a `"udodge"` JSON object with the same fields plus
   `"fieldActive"` and `"lock"` — clone the pjdodge snprintf block and adjust
   keys/format. Mind the running `len` budget guards the file uses.
7. Register `UDodge.cpp`, `UDodgeDebug.cpp` (`<ClCompile>`) and `UDodge.h`,
   `UDodgeDebug.h` (`<ClInclude>`) in
   `internal/il2cpp-dll-injection.vcxproj` + `.filters`, next to the
   existing udodge entries.

### Threading notes (unchanged from PJDodge)
`Tick` runs on the game-update thread (DangerPlanner detour);
`RenderSettings`/`RenderDebugOverlay`/`GetDiagView` on the render thread;
knobs are relaxed atomics; the debug snapshot crosses threads only through
`g_debugMutex` + the heap-backed slot.

## Steps

1. Create `UDodge.h` and a minimal `UDodge.cpp` (knobs, ReadSettings,
   SetEnabled/IsEnabled/OnEnter, empty-ish Tick that builds sensors + calls
   `Core::Evaluate` + movement, DiagView, PublishDebug; `RenderSettings` and
   `RenderDebugOverlay` may temporarily be stubs that compile). Register
   both files in vcxproj + filters.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Create `UDodgeDebug.{h,cpp}` (full port + additions) and complete
   `UDodge.cpp`'s `RenderSettings`/`RenderDebugOverlay`/debug publish.
   Register in vcxproj + filters.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Add the goal layer (`OrbitIntent`/`AutopilotIntent` port) and the
   auto-walk block to `UDodge.cpp`.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. Wiring edit 1-3 (TestTAB enum + transitions + clamps + UI + overlay,
   FeatureState clamp).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. Wiring edit 4-5 (DangerPlanner dispatch, FeatureCommandRegistry table).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

6. Wiring edit 6 (DiagBridge block).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

7. Guardrails + final sweep.
   **Verify:** `bash internal/tools/check-raw-access.sh` → exit 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors
bash internal/tools/check-raw-access.sh       # exit 0

# All five registration points wired:
grep -n 'UDodge' internal/src/gui/tabs/TestTAB.h                     # enum entry
grep -c 'UDodge' internal/src/gui/tabs/TestTAB.cpp                    # >= 6
grep -n 'uniOn\|UDodge::Tick' internal/src/features/movement/dodge/DangerPlanner.cpp
grep -n 'ApplyUDodgeFeature' internal/src/features/control/FeatureCommandRegistry.cpp  # 2 hits (def + call)
grep -n 'DodgeMode::UDodge' internal/src/features/control/FeatureState.cpp             # clamp updated
grep -n 'udodge' internal/src/core/runtime/DiagBridge.cpp

# Old engines untouched:
git diff --stat -- internal/src/features/movement/pjdodge internal/src/features/movement/repp \
  internal/src/features/movement/zdodge   # → empty
```
Manual smoke (user, not the implementer agent): build, inject, Test tab →
Movement → Mode "Unified"; confirm the overlay banner renders and
`dll-trace` shows `[DodgeSwap] ... UDodge=1`.

## Out of scope
- Do NOT modify anything under `pjdodge/`, `repp/`, `zdodge/`, or the
  engine files in `dodge/` other than the DangerPlanner dispatch lines
  listed above.
- Do NOT touch the client (`client/`) — plan 34.
- Do NOT delete or disable the old modes — plan 35, gated on user
  validation.
- Do NOT change tuning constants ported from PJDodge/RePP.
