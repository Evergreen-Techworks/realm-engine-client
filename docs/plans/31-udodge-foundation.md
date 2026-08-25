# 31 — UDodge Foundation: Types + Sensors

## Goal
After this plan, the repo contains a new dodge-engine module skeleton at
`internal/src/features/movement/udodge/` with two compiled-but-not-yet-wired
components: `UDodgeTypes.h` (pure data/math, no game includes) and
`UDodgeSensors.{h,cpp}` (the sensor pipeline that builds a per-frame threat
snapshot from the shared trackers). Both are registered in the Visual Studio
project and compile clean. No existing behavior changes — nothing calls this
code yet.

Background (one paragraph): the repo has two auto-dodge engines being merged
into one. **PJDodge** (`internal/src/features/movement/pjdodge/`) has the
better sensor pipeline — calibrated per-shot clock, dense resampling of the
game's own trajectory function for curved shots, the game's real Chebyshev
hit threshold, AoEs modeled as landing-instant events, zero-allocation hazard
memo. **RePP** (`internal/src/features/movement/repp/`) has the better goal
layer — its sensor pass also computes an "autopilot boss lock" (highest-maxHp
enemy). The unified sensor = PJDodge's pipeline + RePP's boss lock + one new
extension (lingering AoE zones). This plan ports exactly that.

## Dependencies
None — parallel-safe. First plan of the UDodge series (see
`docs/plans/30-unified-dodge-overview.md` for the rationale).

Files this plan touches that other plans also touch:
- `internal/il2cpp-dll-injection.vcxproj` and `.filters` (plans 32/33 add
  more files to the same ItemGroups — sequential by design).

## Current state
Two divergent copies of the same sensor logic exist:
- `internal/src/features/movement/pjdodge/PJDodgeSensors.cpp` (332 lines) —
  the superior copy being ported.
- `internal/src/features/movement/repp/ReppSensors.cpp` (319 lines) — the
  copy contributing only the boss-lock block (lines 217-238).

Key divergences (decided in plan 30; the PJDodge behavior is correct):
- Hit half-size: `PJDodgeSensors.cpp:275-277` uses `runtimeChebyshevHalf`
  (game IsHit threshold, fallback `projHalfSize`, then 0.5). RePP
  (`ReppSensors.cpp:49-54`) used `projHalfSize` with fallback 0.10 — WRONG,
  do not port.
- AoE: `PJDodgeSensors.cpp:284-308` emits landing-instant events. RePP
  (`ReppSensors.cpp:151-188`) blocked the whole remaining lifetime — do not
  port, EXCEPT the case it covered that PJDodge dropped: a zone that has
  already landed but still has lifetime remaining. That case becomes the new
  `activeNow` flag (see Target design).
- Hazard memo: `PJDodgeSensors.cpp:26-70` fixed open-addressing table (no
  allocation) vs RePP `ReppSensors.cpp:27` `std::unordered_map` — port the
  PJDodge one.

Neither engine is modified by this plan.

## Target design

### Directory
`internal/src/features/movement/udodge/` — new. Files reference each other
with bare `#include "UDodgeTypes.h"` (MSVC searches the including file's
directory first); cross-module includes use directories already on the
include path (`MovementRuntime.h`, `ProjectileTracking.h`, `AoeTracking.h`
resolve because `src\features\movement\dodge` is on
`AdditionalIncludeDirectories`; anything else uses the `src`-rooted subpath,
e.g. `#include "features/combat/enemytracker/EnemyTracker.h"`). Do NOT add
the new folder to `AdditionalIncludeDirectories`.

### `UDodgeTypes.h` — pure data + inline math, namespace `UDodge`
Start from a copy of `internal/src/features/movement/pjdodge/PJDodgeTypes.h`
(203 lines), rename namespace `PJDodge` → `UDodge`, then apply these deltas:

1. Candidate layout gains a 35th slot for the field-escape direction
   (consumed by plan 32):
```cpp
// 0 = stand, 1..32 = compass headings, 33 = intent, 34 = field escape.
constexpr int   kDirectionCount  = 32;
constexpr int   kStandCandidate  = 0;
constexpr int   kIntentCandidate = kDirectionCount + 1;   // 33
constexpr int   kFieldCandidate  = kDirectionCount + 2;   // 34
constexpr int   kCandidateCount  = kDirectionCount + 3;   // 35
```
2. `AoeThreat` gains the lingering-zone fields:
```cpp
struct AoeThreat {
    Vec2  pos{};
    float radius = 1.f;
    float landingMs = 0.f;   // ms from now; 0 when activeNow
    bool  activeNow = false; // already detonated, zone persists
    float remainMs = 0.f;    // only meaningful when activeNow: remaining life
};
```
3. `Snapshot` gains the autopilot boss lock (from RePP):
```cpp
struct Snapshot {
    ProjectileThreat projectiles[kMaxProjectiles]{};
    int  projectileCount = 0;
    AoeThreat aoes[kMaxAoes]{};
    int  aoeCount = 0;
    EnemyBlocker enemies[kMaxEnemies]{};
    int  enemyCount = 0;
    bool projectileSourceUnavailable = false;
    bool limited = false;
    // Autopilot boss lock — highest-maxHp enemy with a health bar, NOT
    // range-culled (computed in the same enemy pass; RePP semantics).
    bool    hasLock = false;
    int32_t lockId  = 0;
    Vec2    lockPos{};
};
```
4. `Settings` is the union of both engines' knobs:
```cpp
struct Settings {
    float horizonMs   = 600.f;   // prediction window        [200, 2000]
    float leadMs      = 40.f;    // command-latency lead     [0, 250]
    float hitScale    = 1.0f;    // × per-shot hit threshold [0.25, 2.5]
    bool  safeWalk    = true;    // avoid damaging ground in path checks
    bool  speedScale  = true;    // match gentle overrides to intent speed
    bool  predictionAccuracy = true;
    bool  fieldEscape = true;    // Dijkstra pocket search when boxed in
    bool  debugOverlay = true;
    int   mode        = 0;       // 0 = Assist, 1 = Autopilot
    bool  lockFollow  = false;   // consume DangerPlanner external goal as intent
    bool  followLantern = false; // Autopilot: stand-on object scan (perf cost)
    int   standOnType   = 0;     // objType to stand on (0 = off)
};
```
5. `Decision` enum: keep all PJDodge values and append `FieldEscape` at the
   end (after `HazardEscape`).
6. `CoreOutput` gains field-escape debug info:
```cpp
    bool  fieldActive = false;   // field candidate was generated this frame
    Vec2  fieldTarget{};         // pocket cell (world) the field routed to
```
7. Everything else from `PJDodgeTypes.h` carries over unchanged: `Vec2` +
   inline math + `MinChebOnSegment` (lines 37-68), controller constants
   (lines 26-35), `ProjectileThreat`, `EnemyBlocker`, `Env`,
   `CandidateDebug`, `CoreInput`, `CoreState`, `DebugSnapshot` (the
   `DebugSnapshot` gets the two new CoreOutput fields mirrored:
   `fieldActive`/`fieldTarget`, plus `bool hasLockTarget; Vec2 lockTarget;`
   for the autopilot reticle).
8. Update the top-of-file comment to say this is the unified engine
   ("UDodge — unified auto-dodge: PJDodge predictive core + RePP field
   escape/goal layer. Pure data + inline math. No game/IL2CPP includes.").

### `UDodgeSensors.h` — namespace `UDodge::Sensors`
Mirror `internal/src/features/movement/pjdodge/PJDodgeSensors.h` (20 lines),
renamed:
```cpp
#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Sensors {

// Build the per-frame snapshot (game-update thread only).
void Build(Snapshot& out, float playerX, float playerY, const Settings& settings);

// Host environment probes (match the Env fn-pointer signatures).
bool IsHazardAt(float worldX, float worldY);
bool CanOccupy(float worldX, float worldY, bool safeWalk);

} } // namespace UDodge::Sensors
```

### `UDodgeSensors.cpp`
Start from a copy of `PJDodgeSensors.cpp`, rename namespace, then:

1. **Boss lock** — extend the enemy loop (source pattern
   `PJDodgeSensors.cpp:220-229`) with RePP's lock selection
   (`ReppSensors.cpp:217-238`). The enemy pass becomes:
```cpp
    EnemyTracker::Tick();
    int32_t lockId = 0, lockMaxHp = -1;
    float   lockX = 0.f, lockY = 0.f;
    for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
        if (!IsFinitePoint(e.x, e.y)) continue;
        if (DistSq(e.x, e.y, playerX, playerY) <= cullSq) {
            if (out.enemyCount >= kMaxEnemies) { out.limited = true; }
            else {
                EnemyBlocker& b = out.enemies[out.enemyCount++];
                b.pos = { e.x, e.y };
                b.radius = kEnemyRadius;
            }
        }
        // Boss lock: biggest real-HP enemy (sticky via constant maxHp), NOT
        // range-culled so autopilot keeps range to a far boss.
        if (e.hasHealthBar && e.hp > 0 && e.maxHp > 0 &&
            (e.maxHp > lockMaxHp || (e.maxHp == lockMaxHp && e.id < lockId))) {
            lockMaxHp = e.maxHp; lockId = e.id; lockX = e.x; lockY = e.y;
        }
    }
    if (lockMaxHp >= 0) { out.hasLock = true; out.lockId = lockId; out.lockPos = { lockX, lockY }; }
```
   (Note the `limited` branch no longer `break`s — the lock scan must see all
   enemies. This intentionally differs from `PJDodgeSensors.cpp:225`.)
   Remember to zero the new lock fields at the top of `Build` alongside the
   existing count resets.
2. **Lingering AoE zones** — in the AoE loop (source
   `PJDodgeSensors.cpp:288-308`), replace the early-skip
   `if (landingMs <= 0.f || landingMs > windowMs) continue;` with:
```cpp
        const float remainMs = lifeMs - elapsedMs;   // lifeMs = the landAt fallback lifetime
        if (landingMs > windowMs) continue;           // lands beyond the window
        const bool activeNow = landingMs <= 0.f;
        if (activeNow && remainMs <= 25.f) continue;  // effectively expired
```
   where `lifeMs` is `(IsFinite(a.lifetime) && a.lifetime > 0.f ? a.lifetime : 2000.f)`
   (same fallback as `ReppSensors.cpp:165`). Fill the threat:
```cpp
        AoeThreat& t = out.aoes[out.aoeCount++];
        t.pos = { a.destX, a.destY };
        t.radius = radius;
        t.activeNow = activeNow;
        t.landingMs = activeNow ? 0.f : landingMs;
        t.remainMs  = activeNow ? remainMs : 0.f;
```
3. Everything else is a verbatim port: hazard memo table (lines 26-70),
   `TryPredict` (88-99), `CachedAnchorIndex` (101-129), `AddCachedPath`
   (131-157), `IsCurved` (159-163), `AddFreshPath` (167-197), the projectile
   loop with `usePred`/calibrated-clock selection (231-278) including the
   `hitHalf` assignment (275-277), and `IsHazardAt`/`CanOccupy` (311-331).
4. Keep the include set of `PJDodgeSensors.cpp:1-14` but include
   `"UDodgeSensors.h"` and note `EnemyTracker.h` is included as
   `"features/combat/enemytracker/EnemyTracker.h"`.

### Threading / lifetime / cost
Identical to PJDodge: `Build` and the probes run only on the game-update
thread (the `AppEngineManager::Update` detour); statics (`s_projs`,
`s_aoes`, the memo table) are single-consumer; the vectors are static so
allocation amortizes to zero. No IL2CPP raw access anywhere — everything
routes through `ProjectileTracking`, `AoeTracking`, `EnemyTracker`,
`WorldTAB`, `TestTAB` facades, which is what
`internal/tools/check-raw-access.sh` enforces.

## Steps

1. Create `internal/src/features/movement/udodge/UDodgeTypes.h` per the
   Target design (copy `PJDodgeTypes.h`, rename namespace, apply deltas 1-8).
   No build change yet (header not included anywhere).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors
   (unchanged build proves nothing broke).

2. Create `internal/src/features/movement/udodge/UDodgeSensors.h` per the
   Target design.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Create `internal/src/features/movement/udodge/UDodgeSensors.cpp` per the
   Target design (port + the two deltas). Keep `#include "pch-il2cpp.h"` as
   the first include (every .cpp in this project starts with it).

4. Register the new files in the project:
   - `internal/il2cpp-dll-injection.vcxproj`: add
     `<ClCompile Include="src\features\movement\udodge\UDodgeSensors.cpp" />`
     next to the pjdodge entries (near line 59-62), and
     `<ClInclude Include="src\features\movement\udodge\UDodgeTypes.h" />` +
     `<ClInclude Include="src\features\movement\udodge\UDodgeSensors.h" />`
     near lines 238-242.
   - `internal/il2cpp-dll-injection.vcxproj.filters`: add matching entries
     next to the pjdodge ones (`.filters` lines 43-46 / 170-174). Copy the
     `<Filter>` child element style used by the pjdodge entries.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors, 0
   warnings; `UDodgeSensors.cpp` appears in the MSBuild compile output.

5. Run the guardrail check.
   **Verify:** `bash internal/tools/check-raw-access.sh` → exit 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors; DLL produced
bash internal/tools/check-raw-access.sh       # exit 0
ls internal/src/features/movement/udodge      # UDodgeTypes.h UDodgeSensors.h UDodgeSensors.cpp
grep -c 'udodge' internal/il2cpp-dll-injection.vcxproj          # >= 3
grep -rn 'namespace PJDodge' internal/src/features/movement/udodge/   # → empty (rename complete)
grep -rn 'il2cpp_' internal/src/features/movement/udodge/             # → empty (no raw IL2CPP)
```

## Out of scope
- Do NOT modify anything under `pjdodge/`, `repp/`, `zdodge/`, or `dodge/`.
- Do NOT wire UDodge into TestTAB / DangerPlanner / FeatureCommandRegistry /
  DiagBridge (plan 33).
- Do NOT create `UDodgeCore`/`UDodgeField`/`UDodge`/`UDodgeDebug` (plans
  32-33).
- Do NOT touch the client (`client/`).
- Do NOT add the udodge folder to `AdditionalIncludeDirectories`.
