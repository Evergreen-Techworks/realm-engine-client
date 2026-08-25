# 09 — Shared camera W2S state + game formulas (`game/math/`)

## Goal
Two small shared modules exist and their duplicated copies are gone:
1. `gui/CamState.{h,cpp}` — a per-frame **camera/W2S parameter snapshot**
   (`camX, camY, angleRad, zoom, cx, cy, screenW, screenH, valid`) built once
   per frame, replacing the duplicated `BuildCamState` logic in TestTAB and
   CameraTAB.
2. `game/math/MoveSpeed.h` — the canonical Flash move-speed formula
   (`tilesPerSec = 4 + 5.6 * spd/75`) and its inverse, replacing the three
   hand-inlined copies.
Behavior identical; consumers keep their exact numeric results.

## Dependencies
None of plans 01–08 strictly required (this is orthogonal to the memory layer),
but it **touches `gui/tabs/TestTAB.cpp`, `gui/tabs/CameraTAB.cpp`, and
`gui/tabs/PlayerTAB.cpp`, which plan 07 also touches — merge AFTER 07** to avoid
conflicts. Parallel-safe against 04/05/06/08/10+.

## Current state
### Camera W2S parameter building — 2 divergent copies
- `gui/tabs/TestTAB.cpp:295` `static bool BuildCamState(float& camX, …,
  float& screenH)` — prefers the calibrated `CameraTAB::ScreenBasis` anchor when
  fresh (`TestTAB.cpp:379-392`, `kBasisMaxAgeMs` staleness gate), else falls back
  to CameraTAB getters (`GetCamWorldX/GetZoom/GetAngle/GetPixelRect*`).
- `gui/tabs/CameraTAB.cpp:624` — comment literally says
  `// Build per-frame camera state (same logic as TestTAB::BuildCamState)` —
  a hand-maintained copy.
Consumers of the produced params (they stay parameter-passing, do NOT change):
`TestTAB.cpp:742-746` passes them to `XDodge::RenderDebugPath`,
`RolloutDodge::RenderDebugPath`, `ZDodge::Target::Render`; also
`features/movement/pjdodge/PJDodgeDebug.cpp:14`, `features/movement/repp/ReppDebug.cpp:20`,
`features/movement/zdodge/ZDodgeDebug.cpp:23` receive them as args.

**Divergence check (implementer must do):** diff the two builders line by line.
If CameraTAB's copy lacks the ScreenBasis-staleness path or uses a different
viewport-centre formula, the TestTAB version is canonical — it is the one
feeding the movement overlays users actually rely on. Record any difference in
the PR description.

### Move-speed formula — 3 inline copies
- `gui/tabs/PlayerTAB.cpp:610` `tilesPerSec = 4.0f + 5.6f * (g_snap.spd / 75.0f);`
- `gui/tabs/TestTAB.cpp:558` `tilesPerSec = 4.0f + 5.6f * (50.f / 75.f);`
  and `:562` the **inverse** `spd = clamp((tps - 4)/5.6*75, 0, 120)` and `:582`
  the default `4 + 5.6*(50/75)`.
- Doc references: `TestTAB.cpp:412`, `PlayerTAB.cpp:613` (comment strings — keep).

## Target design
`internal/src/gui/CamState.h`:
```cpp
#pragma once
namespace CamState {
    struct Snapshot {
        float camX = 0, camY = 0;      // camera world pos (tiles)
        float angleRad = 0;            // camera rotation
        float zoom = 0;                // pixels per tile
        float cx = 0, cy = 0;          // screen-space centre (px)
        float screenW = 0, screenH = 0;
        bool  valid = false;           // false => don't draw overlays
    };
    // Rebuilds the snapshot (ScreenBasis-anchored when fresh, CameraTAB getters
    // otherwise). Call once per frame from dPresent AFTER CameraTAB's refresh;
    // cheap (reads cached getters only). Render-thread only.
    void Tick();
    const Snapshot& Get();
}
```
Body = the TestTAB implementation moved verbatim into `gui/CamState.cpp`
(including the `kBasisMaxAgeMs` staleness logic and `CalibrateScreenBasis`
interplay). TestTAB and CameraTAB then call `CamState::Get()`.
**Ownership/threading:** render-thread-only, like all tab state. No locks.
**Hot path:** one snapshot per frame instead of two duplicate rebuilds — a
strict improvement.

`internal/src/game/math/MoveSpeed.h`:
```cpp
#pragma once
#include <algorithm>
// Flash-parity movement speed. tilesPerSec = 4 + 5.6 * (spd / 75).
namespace GameMath {
    inline float TilesPerSecFromSpd(float spd) { return 4.0f + 5.6f * (spd / 75.0f); }
    inline float SpdFromTilesPerSec(float tps) {
        return std::clamp((tps - 4.0f) / 5.6f * 75.0f, 0.0f, 120.0f);
    }
}
```

## Steps
1. Create `gui/CamState.{h,cpp}`: move `BuildCamState` + its statics
   (`s_basis`, `s_lastGoodMs`, `kBasisMaxAgeMs`) from `TestTAB.cpp:295-…`
   verbatim; add files to `.vcxproj`. TestTAB keeps compiling by calling
   `CamState::Tick()/Get()` where it called `BuildCamState`. Add
   `CamState::Tick()` to the dPresent per-frame chain in
   `platform/hooks/DirectX.cpp` right after CameraTAB's per-frame work (or call
   it lazily from `Get()` guarded by a frame counter — pick one; lazy is safer
   because it needs no DirectX.cpp edit). Build.
2. `gui/tabs/CameraTAB.cpp:624` region: delete the duplicated builder; use
   `CamState::Get()`. Build.
3. Create `game/math/MoveSpeed.h`; replace `PlayerTAB.cpp:610`,
   `TestTAB.cpp:558`, `TestTAB.cpp:562`, `TestTAB.cpp:582` with
   `GameMath::TilesPerSecFromSpd` / `SpdFromTilesPerSec`. Build.
4. Full build both configs.

Each: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- `grep -rn 'BuildCamState' internal/src/` → only `gui/CamState.cpp`.
- `grep -rnE '4\.0?f? \+ 5\.6f?' internal/src/gui/` → empty (comments excluded —
  refine with `grep -v '//'`).
- Runtime smoke: Test tab overlay (walk target, entity boxes) lands on the same
  pixels as before; Player tab shows the same move-speed number.

## Out of scope
- Do NOT change how movement features RECEIVE cam params (they stay
  parameter-passed from their caller; only the builder is unified).
- `W2S.h` / `S2W` math — already shared and correct.
- `CalibrateScreenBasis` internals in CameraTAB.
