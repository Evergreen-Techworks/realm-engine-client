# 85 — Killaura core + aim-target publisher (DLL)

## Goal

After this plan the DLL has a **KillAura** feature module that, every frame,
selects a killaura target (at-target or at-mouse), computes the canonical
shot-origin parameters, and **publishes** them to the Electron client over the
existing named-pipe bridge as a new `aim` message. It also exposes
`KillAura::ComputeShotOrigin()` for the local-projectile consumer that plan 87
will add, and `KillAura::SetForcedTargetId()` for the auto-break-walls consumer
that plan 89 will add.

Nothing is rewritten yet. No shot behaviour changes. This plan is purely
additive: a new module, a new IPC message, new IPC feature keys, and a new
Combat-tab UI section. With the feature disabled (the default) the DLL behaves
exactly as before.

## Dependencies

**None — this is the C++ foundation.** Dispatch first.

Runs in parallel with plan 86 (TypeScript only, zero file overlap).

Files this plan touches that later plans also touch:

| File | Also touched by |
|---|---|
| `internal/il2cpp-dll-injection.vcxproj` (+ `.filters`) | 87, 88, 89 |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp` | 88, 89 |
| `internal/src/features/control/FeatureCommandRegistry.cpp` | 88, 89 |
| `internal/src/core/ipc/IpcMessages.{h,cpp}`, `IpcBridge.{h,cpp}` | nobody else |
| `internal/src/features/combat/autoaim/TargetSelector.{h,cpp}` | nobody else |

**BUILD HAZARD:** `internal/tools/wsl-build.sh` writes to a shared
`C:\rebuild\Debug`. Do not run it while another agent is building.

## Current state

### 1. Target selection exists, but has no killaura entry point

`internal/src/features/combat/autoaim/TargetSelector.h:6-43` declares one
selector:

```cpp
enum class Mode : int { ClosestToPlayer = 0, HighestHP = 1, ClosestToMouse = 2, Locked = 3 };
struct Config { Mode mode; bool shootInvulnerable; bool prioritizeBosses; bool ignoreWalls;
                float rangeLeadBias; bool mouseBoundingEnabled; float mouseBoundingRange;
                int32_t lockedEnemyId; const int32_t* skipObjTypes; int skipObjCount; };
Result Select(const Config&, float playerX, float playerY, float mouseX, float mouseY,
              const WeaponProfile& weapon);
```

`internal/src/features/combat/autoaim/TargetSelector.cpp:110-115` derives the
selection radius **from the weapon**, and only *shrinks* it in mouse mode:

```cpp
const float weaponRange = (weapon.rangeTiles > 2.f) ? weapon.rangeTiles : 15.f;
float maxRange = weaponRange + cfg.rangeLeadBias;
if (useMouseRef && cfg.mouseBoundingEnabled && cfg.mouseBoundingRange > 0.f
    && cfg.mouseBoundingRange < maxRange)
    maxRange = cfg.mouseBoundingRange;
```

There is **no way to ask for an absolute range** independent of the weapon —
which is exactly what killaura needs (killaura's whole point is to hit past
weapon range). Mouse world position is read inside `Select` from
`TestTAB::GetMouseWorldX/Y` (`TargetSelector.cpp:105-107`).

### 2. There is no killaura module, and MagnetAim is a dead-end stub

`internal/src/features/combat/autoaim/FeatMagnetAim.cpp:9-35` is the closest
thing that exists — a checkbox plus a fixed `kVisualOffsetTiles = 2.0f`, consumed
by `internal/src/features/movement/dodge/ProjectileTracking.cpp:196-220`. Its own
UI text calls it "Internal-only visual path" — it moves the local bullet but the
server never agrees, so it deals no damage. **Do not delete or change it in this
plan**; plan 87 subsumes it.

### 3. The DLL→client bridge has exactly one precedent for publishing a
   per-frame decision, and it is the shape to copy

* Payload struct + publisher API: `internal/src/core/ipc/IpcBridge.h:24-56`
  (`IpcThreat`, `IpcGround`, `IpcBridge_PublishThreats`).
* Double-buffer + "pending" flag: `internal/src/core/ipc/IpcBridge.cpp:120-137`.
* Encode + write on the pipe thread: `internal/src/core/ipc/IpcBridge.cpp:146-167`
  (`WriteThreats`).
* Called once per pipe-loop iteration: `internal/src/core/ipc/IpcBridge.cpp:371-374`.
* Loop cadence: `Sleep(25)` at `internal/src/core/ipc/IpcBridge.cpp:385`.
* Compact string encoder: `internal/src/core/ipc/IpcMessages.cpp:47-114`
  (`BuildThreats` + `EncodeThreats`), with the schema documented as the ONLY
  encoder whose ONLY decoder is the TypeScript side.

### 4. IPC feature keys are a flat table

`internal/src/features/control/FeatureCommandRegistry.cpp:93-110`:

```cpp
static const FeatureHandler h[] = {
    FH_BOOL("autoAimEnabled",  FeatureState::SetAutoAimEnabled),
    FH_INT ("autoAimMode",     FeatureState::SetAutoAimMode),
    FH_BOOL("autoAimPrioritizeBosses", AutoAim::SetPrioritizeBosses),
    ...
};
```

### 5. Combat tab wiring

`internal/src/gui/tabs/CombatTab/CombatTAB.cpp:19-33` (`Tick`) and `:46-80`
(`Render`) call each feature's `Tick`/`Render`. `CombatTAB::Tick` is invoked from
`internal/src/platform/hooks/DirectX.cpp:236` every frame regardless of menu
visibility.

## Target design

### 5.1 `TargetSelector` — one additive Config field + one wrapper

`internal/src/features/combat/autoaim/TargetSelector.h`, add to `Config`:

```cpp
    // Absolute selection radius in tiles. 0 = off (weapon-derived range, the
    // pre-existing behavior). When > 0 it REPLACES the weapon-derived maxRange
    // for both player-ref and mouse-ref modes. Killaura sets this so it can
    // select past weapon range; nothing else sets it.
    float overrideRangeTiles = 0.f;
```

and a new declaration:

```cpp
// Killaura selection. Thin wrapper over Select():
//   atMouse == false -> reference point is the player
//   atMouse == true  -> reference point is the mouse world position
// `rangeTiles` is an ABSOLUTE radius around the reference point (not weapon
// range). `forcedEnemyId != 0` pins the choice to that object id and disables
// the no-health-bar filter, so a breakable wall can be targeted (plan 89).
// Reads the current EnemyTracker snapshot — call after EnemyTracker::Tick().
Result SelectKillAura(bool atMouse, float rangeTiles,
                      float playerX, float playerY,
                      int32_t forcedEnemyId,
                      const WeaponProfile& weapon);
```

`TargetSelector.cpp`: after the existing `maxRange` computation
(currently lines 110-115) append **one** clause:

```cpp
    if (cfg.overrideRangeTiles > 0.f) maxRange = cfg.overrideRangeTiles;
```

and implement the wrapper at the bottom of the file:

```cpp
Result SelectKillAura(bool atMouse, float rangeTiles,
                      float playerX, float playerY,
                      int32_t forcedEnemyId,
                      const WeaponProfile& weapon)
{
    Config cfg;
    cfg.mode                 = forcedEnemyId != 0 ? Mode::Locked
                             : (atMouse ? Mode::ClosestToMouse : Mode::ClosestToPlayer);
    cfg.lockedEnemyId        = forcedEnemyId != 0 ? forcedEnemyId : -1;
    cfg.shootInvulnerable    = false;
    cfg.prioritizeBosses     = false;
    // A forced target may be a breakable wall (noHealthBar) — do not filter it.
    cfg.ignoreWalls          = (forcedEnemyId == 0);
    cfg.mouseBoundingEnabled = false;
    cfg.overrideRangeTiles   = (rangeTiles > 0.f) ? rangeTiles : 0.f;
    return Select(cfg, playerX, playerY, 0.f, 0.f, weapon);
}
```

**Divergence warning.** `Select`'s `Locked` branch (`TargetSelector.cpp:77-97`)
`break`s and *falls through to normal selection* when the locked id is missing or
filtered. That fall-through is correct for AutoAim (lock target died → keep
shooting) but **wrong for a forced killaura target**: auto-break-walls must know
its wall is gone, not silently retarget. `SelectKillAura` therefore must
post-check and reject a mismatch:

```cpp
    Result r = Select(cfg, playerX, playerY, 0.f, 0.f, weapon);
    if (forcedEnemyId != 0 && (!r.found || r.enemyId != forcedEnemyId)) return {};
    return r;
```

Correct behavior = **reject**, because plan 89's release condition is "my target
is gone", and a silent retarget would keep autofire pinned on a live enemy the
user never chose.

### 5.2 `KillAura` module

New files `internal/src/features/combat/killaura/KillAura.h` / `.cpp`.
(Note: this directory is **not** in `AdditionalIncludeDirectories`
— `internal/il2cpp-dll-injection.vcxproj:356,383` — so every consumer must
include it by full subpath: `#include "features/combat/killaura/KillAura.h"`.
That is the same convention `features/movement/udodge/` uses.)

```cpp
#pragma once
#include <cstdint>

// KillAura — redirects where an ALREADY-FIRED shot originates so it lands on a
// chosen target. It never pulls the trigger. Two coordinated consumers use the
// origin this module computes:
//   * the LOCAL bullet spawn (plan 87) so the game's own collision fires ENEMYHIT
//   * the OUTBOUND PLAYERSHOOT.projectilePosition (client proxy, plan 86) so the
//     server's simulation agrees
// Owns no hook. Ticked from CombatTAB::Tick on the render thread.
namespace KillAura {

enum class Mode : int { AtTarget = 0, AtMouse = 1 };

// Render thread, once per frame. Selects a target and publishes the aim state.
void Tick();

void  SetEnabled(bool on);            bool  IsEnabled();
void  SetMode(Mode m);                Mode  GetMode();
void  SetRangeTiles(float t);         float GetRangeTiles();       // clamp [1, 40], default 8
void  SetStandoffTiles(float t);      float GetStandoffTiles();    // clamp [0.05, 1.5], default 0.35
void  SetMaxOffsetTiles(float t);     float GetMaxOffsetTiles();   // clamp [1, 40], default 12

// Forced target override (auto-break-walls, plan 89). 0 = clear.
void    SetForcedTargetId(int32_t id);
int32_t GetForcedTargetId();

// Snapshot of the last Tick. Plain value copy of atomics — no lock.
struct State {
    bool     armed    = false;   // enabled AND a target was selected this tick
    int32_t  targetId = 0;
    float    tx = 0.f, ty = 0.f; // lead-predicted aim point (tiles)
    float    px = 0.f, py = 0.f; // local player position at publish time
    uint32_t stampMs  = 0;       // GetTickCount64() low 32 bits
};
State GetState();

// The ONE shot-origin formula, shared by every consumer:
//   origin = target - (cos(shotAngle), sin(shotAngle)) * standoff
// Returns false (and leaves ox/oy untouched) when not armed, when the inputs are
// not finite, or when the result would sit further than GetMaxOffsetTiles() from
// the local player — fail-closed, the caller then leaves the shot alone.
bool ComputeShotOrigin(float shotAngleRad, float& ox, float& oy);

// Render thread. Draws the Combat-tab section.
void RenderSettings();

} // namespace KillAura
```

**Ownership / threading.** All settings are `std::atomic` with
`memory_order_relaxed`, matching `AutoAim.cpp:23-45`. `Tick()` runs on the render
thread only (it calls `EnemyTracker::Tick()` and `TestTAB::GetMouseWorld*`, both
render-thread-only). `GetState()` / `ComputeShotOrigin()` are safe from the
projectile-spawn detour thread because they only read atomics; the state fields
are individual atomics and a torn read across fields is harmless (one stale
frame, bounded by the `maxOffset` cap).

**Caching / hot path.** `Tick()` is throttled to 8 ms exactly like
`AutoAim::Tick` (`internal/src/features/combat/autoaim/AutoAim.cpp:131-134`) and
early-outs in a single relaxed atomic load when disabled. `ComputeShotOrigin` is
called from the spawn detour and must stay branch-and-two-trig cheap — no
allocation, no IL2CPP calls, no locks.

`Tick()` body (behaviour spec):

```
if (!enabled) { armed = false; publish(armed=0) at most every 250 ms; return; }
throttle 8 ms
local = GameState::GetLocalPtr(); if (!local) -> disarm
Mem::TryRead(local, RuntimeOffsets::PosX/PosY, px, py); on failure -> disarm
WeaponCalibrator::Tick(local); EnemyTracker::Tick();
r = TargetSelector::SelectKillAura(mode == AtMouse, rangeTiles, px, py,
                                   forcedTargetId, WeaponCalibrator::GetProfile());
armed = r.found; targetId = r.found ? r.enemyId : 0; tx = r.aimX; ty = r.aimY;
stampMs = (uint32_t)GetTickCount64();
IpcBridge_PublishAim(...)   // every tick while armed; on the disarm EDGE publish once more
log ARMED/disarmed on the EDGE only, with targetId and mode
```

### 5.3 `aim` IPC message

`internal/src/core/ipc/IpcBridge.h` — add next to the threat block:

```cpp
// ── Killaura aim state ───────────────────────────────────────────────────
// Wire schema v1 (encoder: IpcMessages::EncodeAim, decoder: client
// src/bridge/DllAimBus.ts). Keep the two in lockstep.
constexpr int AIM_SCHEMA_VERSION = 1;

struct IpcAim {
    uint8_t  armed    = 0;    // 0/1
    uint8_t  mode     = 0;    // 0 = at-target, 1 = at-mouse
    int32_t  targetId = 0;
    float    tx = 0.f, ty = 0.f;
    float    px = 0.f, py = 0.f;
    float    standoffTiles  = 0.f;
    float    maxOffsetTiles = 0.f;
    uint32_t stampMs = 0;
};

void IpcBridge_PublishAim(const IpcAim& aim);
```

`internal/src/core/ipc/IpcMessages.h` / `.cpp`:

```cpp
int BuildAim(char* buf, int bufSize, const char* payload);
int EncodeAim(char* out, int outSize, const IpcAim& aim);
```

```cpp
int BuildAim(char* buf, int bufSize, const char* payload)
{ return snprintf(buf, bufSize, "{\"type\":\"aim\",\"aim\":\"%s\"}", payload); }

// "1;<armed>;<mode>;<targetId>;<tx>;<ty>;<px>;<py>;<standoff>;<maxOffset>;<stamp>"
// EXACTLY 11 ';'-separated tokens. This is the ONLY encoder; the ONLY decoder is
// decodeAimPayload in client/src/bridge/DllAimBus.ts. Field order is
// authoritative here and there.
int EncodeAim(char* out, int outSize, const IpcAim& a)
{
    if (!out || outSize <= 0) return -1;
    const int wrote = snprintf(out, (size_t)outSize,
        "%d;%d;%d;%d;%.3f;%.3f;%.3f;%.3f;%.3f;%.3f;%u",
        AIM_SCHEMA_VERSION, (int)a.armed, (int)a.mode, a.targetId,
        (double)a.tx, (double)a.ty, (double)a.px, (double)a.py,
        (double)a.standoffTiles, (double)a.maxOffsetTiles, a.stampMs);
    return (wrote <= 0 || wrote >= outSize) ? -1 : wrote;
}
```

`internal/src/core/ipc/IpcBridge.cpp` — mirror the threat double-buffer exactly
(`IpcBridge.cpp:120-167`): a `std::mutex s_aimMutex`, `IpcAim s_aim`,
`bool s_aimPending`, a `IpcBridge_PublishAim` that stores + sets pending, and a
`static bool WriteAim(HANDLE, char*, int)` that returns `true` when nothing is
pending. Call `WriteAim` in the pipe loop **immediately after** the existing
`WriteThreats` call (`IpcBridge.cpp:371-374`), with the same
`if (!WriteAim(...)) { connected = false; break; }` shape.

Payload buffer: `char payload[192]` is ample for the fixed 11-token layout.

### 5.4 IPC feature keys

Add to the `ApplyCoreFeature` table in
`internal/src/features/control/FeatureCommandRegistry.cpp` (after the
`autoAim*` rows):

```cpp
FH("killauraEnabled",        KillAura::SetEnabled(f.Bool())),
FH("killauraMode",           KillAura::SetMode(f.Int() == 1 ? KillAura::Mode::AtMouse
                                                            : KillAura::Mode::AtTarget)),
FH_FLOAT("killauraRangeTiles",     KillAura::SetRangeTiles),
FH_FLOAT("killauraStandoffTiles",  KillAura::SetStandoffTiles),
FH_FLOAT("killauraMaxOffsetTiles", KillAura::SetMaxOffsetTiles),
```

(Plan 86 adds the matching entries to `client/src/bridge/contract.ts`
`DLL_FEATURE_KEYS`. Unknown keys are already tolerated on both sides — see the
"Unknown keys are intentionally treated as applied" note at
`FeatureCommandRegistry.cpp:9-10` — so the two halves can land in either order.)

### 5.5 UI

`KillAura::RenderSettings()` draws: Enable checkbox, Mode radio (At target / At
mouse), Range slider `1..40` tiles, Standoff slider `0.05..1.5`, Max offset
slider `1..40`, and a read-only status line
`ARMED id=<targetId> t=(tx,ty) age=<ms>ms` / `disarmed`. Follow the style of
`internal/src/features/combat/autoaim/FeatAutoAim.cpp:52-70`.

## Steps

1. **`TargetSelector` extension.**
   Edit `internal/src/features/combat/autoaim/TargetSelector.h`: add
   `float overrideRangeTiles = 0.f;` to `Config` and declare `SelectKillAura`.
   Edit `internal/src/features/combat/autoaim/TargetSelector.cpp`: append the
   single `if (cfg.overrideRangeTiles > 0.f) maxRange = cfg.overrideRangeTiles;`
   line after the existing `maxRange` block (currently line 114), and add the
   `SelectKillAura` implementation from §5.1 (including the forced-target
   post-check).
   *Behaviour-neutral: `overrideRangeTiles` defaults to 0 and no existing caller sets it.*
   → `bash internal/tools/wsl-build.sh Debug`

2. **`aim` message encoder.**
   Edit `internal/src/core/ipc/IpcBridge.h` (add `AIM_SCHEMA_VERSION`, `IpcAim`,
   `IpcBridge_PublishAim`) and `internal/src/core/ipc/IpcMessages.h` / `.cpp`
   (add `BuildAim`, `EncodeAim` exactly as in §5.3).
   *Nothing calls them yet.*
   → `bash internal/tools/wsl-build.sh Debug`

3. **`aim` publisher on the pipe thread.**
   Edit `internal/src/core/ipc/IpcBridge.cpp`: add `s_aimMutex` / `s_aim` /
   `s_aimPending`, `IpcBridge_PublishAim`, `WriteAim`, and the `WriteAim` call
   right after the `WriteThreats` call in the loop.
   *Still behaviour-neutral: nothing publishes, so `WriteAim` always returns
   early on `!s_aimPending`.*
   → `bash internal/tools/wsl-build.sh Debug`

4. **Create the KillAura module.**
   Create `internal/src/features/combat/killaura/KillAura.h` and `KillAura.cpp`
   per §5.2. Includes it will need (full subpaths where the folder is not on the
   include path):
   ```cpp
   #include "pch-il2cpp.h"
   #include "features/combat/killaura/KillAura.h"
   #include "features/combat/enemytracker/EnemyTracker.h"
   #include "TargetSelector.h"      // features/combat/autoaim is on the include path
   #include "WeaponProfile.h"
   #include "GameState.h"
   #include "RuntimeOffsets.h"
   #include "core/runtime/MemRead.h"
   #include "core/ipc/IpcBridge.h"
   #include "DbgFileLog.h"
   #include <imgui/imgui.h>
   ```
   Implement everything except `RenderSettings()` (stub it to a single
   `ImGui::TextDisabled("KILLAURA")` for now).
   Register both files in `internal/il2cpp-dll-injection.vcxproj` — add
   `<ClCompile Include="src\features\combat\killaura\KillAura.cpp" />` next to
   the other `src\features\combat\autoaim\*.cpp` entries (around line 92) and
   `<ClInclude Include="src\features\combat\killaura\KillAura.h" />` near line 215
   — and mirror both in `internal/il2cpp-dll-injection.vcxproj.filters`.
   *Nothing calls `KillAura::Tick()` yet.*
   → `bash internal/tools/wsl-build.sh Debug`

5. **Wire the tick + UI.**
   Edit `internal/src/gui/tabs/CombatTab/CombatTAB.cpp`:
   add `#include "features/combat/killaura/KillAura.h"`, call `KillAura::Tick();`
   inside `CombatTAB::Tick` (after `FeatMagnetAim::Tick(menuVisible);`, currently
   line 22), and add a separator + `KillAura::RenderSettings();` at the end of
   `CombatTAB::Render()`.
   Fill in `RenderSettings()` per §5.5.
   *Killaura defaults to disabled, so `Tick` early-outs on one atomic load and
   nothing changes in game.*
   → `bash internal/tools/wsl-build.sh Debug`

6. **IPC feature keys.**
   Edit `internal/src/features/control/FeatureCommandRegistry.cpp`: add the
   include and the five `killaura*` handler rows from §5.4.
   → `bash internal/tools/wsl-build.sh Debug`

7. **Self-witnessing logs.**
   In `KillAura.cpp` add, using `DBG_FILE_LOG`:
   * one-time on first successful selection:
     `[KillAura] armed via TargetSelector::SelectKillAura mode=<n> range=<t>`
   * ARMED/disarmed **edge only** (compare against a `static int s_lastArmed = -1`),
     including `targetId` and the disarm reason
     (`no-local` / `pos-read-failed` / `no-target` / `forced-target-gone`).
   * rate-limited (`(s_n++ % 240) == 0`) line when `IpcBridge_PublishAim` has
     never been drained (i.e. `armed` for > 2 s with the bridge disconnected),
     so "client not listening" is visible.
   * liveness stamp: while enabled, one line every 30 s
     `[KillAura] alive armed=<0/1> id=<n> pub=<count>` — KillAura owns no hook, so
     this is the only proof it is running.
   → `bash internal/tools/wsl-build.sh Debug` and
     `bash internal/tools/check-raw-access.sh`

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # "0 Error(s)"
bash internal/tools/check-raw-access.sh       # exit 0, no output
```

Must return **zero** results (no private field/method resolution, no raw offset
reads in the new module):

```bash
grep -rnE 'il2cpp_field_get_offset|il2cpp_class_get_field_from_name|il2cpp_class_get_method_from_name|MH_CreateHook' \
  internal/src/features/combat/killaura/
```

Must return **exactly one** hit each (the sanctioned encoder/decoder pair is
single-sourced):

```bash
grep -rn 'EncodeAim' internal/src/          # 1 definition + 1 call site
grep -rn 'AIM_SCHEMA_VERSION' internal/src/ # header + encoder only
```

In-game smoke test (manual, optional but recommended): open **Combat → KILLAURA**,
enable it near an enemy, confirm the status line shows `ARMED id=<n>` and that
`%LOCALAPPDATA%\RotMG Exalt DLL Trace.log` shows exactly **one** ARMED line per
edge (not one per frame).

## Out of scope

* **Do not** rewrite any shot origin, angle, packet, or projectile. Publishing
  only. (Local rewrite = plan 87, outbound rewrite = plan 86.)
* **Do not** touch `internal/src/features/combat/autoaim/AimHooks.cpp`. Its
  angle-redirect behaviour and its `Shot_Angle = 0x1C` manual offset stay exactly
  as they are.
* **Do not** modify or delete `FeatMagnetAim` or the `SpawnProjectileDetour`
  origin logic in `internal/src/features/movement/dodge/ProjectileTracking.cpp`.
  Plan 87 owns that file.
* **Do not** add a `SocketManager::SendMessage` hook or any packet-model code to
  the DLL. See plan 84's pivotal finding: the outbound half is done in the client
  proxy.
* **Do not** edit `internal/src/features/movement/udodge/UDodgeSolver.cpp` or
  `UDodgeTypes.h` (Phase-3 conflict zone).
* **Do not** change `RuntimeOffsets` — killaura needs no new game field.
