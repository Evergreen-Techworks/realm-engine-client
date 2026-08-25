# 87 — Local shot-origin provider (DLL)

## Goal

After this plan the **local** projectile the game spawns for our own shot starts
at the killaura origin instead of the muzzle. That makes the game's own collision
detect the hit and emit the client-authored `ENEMYHIT` packet — which is the
packet that actually deals damage in RotMG. Without this, plan 86's outbound
rewrite produces a shot the *server* believes should hit but the *client* never
claims a hit for, and nothing dies.

Mechanically: the three ad-hoc origin-override branches currently inlined in
`SpawnProjectileDetour` are replaced by one `ShotOrigin::Resolve()` provider with
an explicit precedence order. MagnetAim and the muzzle-offset slider keep
byte-identical behaviour.

## Dependencies

**Plan 85 must be merged first** — this plan calls
`KillAura::ComputeShotOrigin()` and `KillAura::GetState()`, which plan 85 creates.

Files this plan touches that other plans also touch:

| File | Also touched by |
|---|---|
| `internal/il2cpp-dll-injection.vcxproj` (+ `.filters`) | 85, 88, 89 |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp` | 85, 88, 89 |
| `internal/src/features/movement/dodge/ProjectileTracking.cpp` | nobody else |
| `internal/src/features/combat/autoaim/FeatMagnetAim.{h,cpp}` | nobody else |

**BUILD HAZARD:** `internal/tools/wsl-build.sh` writes to a shared
`C:\rebuild\Debug`. Do not run it while another agent is building.

## Current state

### The one seam: `startX`/`startY` are shooter-RELATIVE offsets

`internal/src/features/movement/dodge/ProjectileTracking.cpp:77-91` binds the
game's spawn method:

```cpp
using SpawnProjectileFn = void* (__fastcall*)(
    void* projInstance, void* objProps, void* projProps,
    int32_t attackerObjId, uint32_t ownerObjId, float angle, int32_t bulletId,
    void* name, void* group,
    float startX, float startY,          // <-- SHOOTER-RELATIVE, vanilla length ~0.3
    bool canHitPlayer, bool isAbility, void* methodInfo);
```

Proof they are relative, not absolute:
* the muzzle path scales them (`:225`) `const float scale = muzzleTiles / kMuzzleMinTiles;`
  where `kMuzzleMinTiles = 0.3f` (`:34`);
* the store path adds the shooter position back (`:272-274`)
  `sx = entityX + spawnX; sy = entityY + spawnY;`.

This is the local half of the reference fork's mechanism, and it is **better**
than the reference's `MapObject::SetPosition` hook: we get it *before* the
projectile is constructed, so there is no one-shot arming and no second hook.

### The three branches to unify

`internal/src/features/movement/dodge/ProjectileTracking.cpp:190-234`:

```cpp
    float spawnX = startX;
    float spawnY = startY;
    const int32_t dk = g_LocalDictKey.load(std::memory_order_relaxed);
    const bool isLocalShot = dk != 0 && (attackerObjId == dk || (int32_t)ownerObjId == dk);
    if (isLocalShot && CombatTAB::FeatMagnetAim::IsEnabled()) {
        const float magnetTiles = CombatTAB::FeatMagnetAim::GetVisualOffsetTiles();
        bool useTarget = false;
        if (AutoAim::HasTarget()) {
            float targetX = 0.f, targetY = 0.f;
            AutoAim::GetAimTarget(targetX, targetY);
            float entityX = 0.f, entityY = 0.f;
            LookupShooterOrigin(attackerObjId, ownerObjId, entityX, entityY);
            if (fabsf(entityX) > 0.5f || fabsf(entityY) > 0.5f) {
                const float dx = targetX - entityX, dy = targetY - entityY;
                const float lenSq = dx * dx + dy * dy;
                if (lenSq > 1e-6f) {
                    const float invLen = 1.f / sqrtf(lenSq);
                    spawnX = dx * invLen * magnetTiles;
                    spawnY = dy * invLen * magnetTiles;
                    useTarget = true;
                }
            }
        }
        if (!useTarget) {
            spawnX = cosf(angle) * magnetTiles;
            spawnY = sinf(angle) * magnetTiles;
        }
    } else {
        const float muzzleTiles = g_localMuzzleOffsetTiles.load(std::memory_order_relaxed);
        if (muzzleTiles > kMuzzleMinTiles + kMuzzleVanillaEps && isLocalShot) {
            const float scale = muzzleTiles / kMuzzleMinTiles;
            if (fabsf(startX) > 1e-5f || fabsf(startY) > 1e-5f) {
                spawnX = startX * scale;
                spawnY = startY * scale;
            } else {
                spawnX = cosf(angle) * muzzleTiles;
                spawnY = sinf(angle) * muzzleTiles;
            }
        }
    }
```

Supporting pieces already present:
* `LookupShooterOrigin` (`:148-166`) — CS-guarded lookup of the shooter's world
  position from the `g_EntityPos` map fed by `OnWorldEntity` (`:484-490`).
* `CombatTAB::FeatMagnetAim::IsEnabled()` / `GetVisualOffsetTiles()`
  (`internal/src/features/combat/autoaim/FeatMagnetAim.cpp:16-24`, fixed
  `kVisualOffsetTiles = 2.0f`).
* Muzzle clamp + accessors (`ProjectileTracking.cpp:33-36, 576-587`).

### Divergences inside the existing code (record, do not "fix")

1. **MagnetAim's two branches disagree about what the offset points at.** With a
   target it is `normalize(target − shooter) * 2.0`; without one it is
   `(cos(angle), sin(angle)) * 2.0`. These are *different quantities* (target
   direction vs fired angle) that coincide only when auto-aim already aimed at
   the target. **Both are correct as-is** — the first is the magnet effect, the
   second is the "no target" fallback. Preserve both exactly.
2. **MagnetAim ignores the muzzle slider entirely** (`else` branch). That is
   deliberate and is even surfaced in the UI
   (`internal/src/gui/tabs/CombatTab/CombatTAB.cpp:76-77`: *"Manual spawn offset
   is overridden while Magnet Aim is enabled."*). Preserve the precedence.
3. **The muzzle path has a zero-length fallback** (`fabsf(startX) > 1e-5f` guard)
   that MagnetAim lacks. Preserve.

## Target design

### 7.1 `ShotOrigin` — one provider, explicit precedence

New file pair `internal/src/features/projectiles/ShotOrigin.h` / `.cpp`.
(`src/features/projectiles/` is **not** on the include path —
`internal/il2cpp-dll-injection.vcxproj:356,383` — so include it by full subpath:
`#include "features/projectiles/ShotOrigin.h"`.)

```cpp
#pragma once
#include <cstdint>

// ShotOrigin — the ONE place that decides where the LOCAL projectile for our own
// shot spawns. Called from ProjectileTracking's SpawnProjectileDetour, on the
// game thread, inside the hot path: no allocation, no IL2CPP calls, no locks
// beyond the shooter-position lookup the caller already performs.
//
// Coordinates are SHOOTER-RELATIVE tile offsets (the same space the game's
// spawn method takes; vanilla length ~0.3).
namespace ShotOrigin {

enum class Source : uint8_t {
    Vanilla  = 0,  // no override — pass the game's own startX/startY through
    Muzzle   = 1,  // manual muzzle-offset slider
    Magnet   = 2,  // MagnetAim visual offset
    KillAura = 3,  // killaura origin (only this one changes where the shot LANDS)
};

struct Request {
    bool  isLocalShot   = false;
    float angle         = 0.f;   // the fired angle, radians
    float startX        = 0.f;   // the game's own relative offset
    float startY        = 0.f;
    bool  haveShooter   = false; // shooter world position resolved?
    float shooterX      = 0.f;
    float shooterY      = 0.f;
    float muzzleTiles   = 0.3f;  // ProjectileTracking::GetLocalPlayerMuzzleOffsetTiles()
};

// Fills outX/outY with the relative offset to use. ALWAYS succeeds: on any
// failure it returns Source::Vanilla with outX/outY == req.startX/startY, so a
// broken override can never corrupt a shot.
Source Resolve(const Request& req, float& outX, float& outY);

} // namespace ShotOrigin
```

`Resolve` precedence, highest first:

| Order | Source | Condition | Offset |
|---|---|---|---|
| 1 | `KillAura` | `isLocalShot` && `KillAura::ComputeShotOrigin(req.angle, ox, oy)` returns true && `req.haveShooter` | `(ox - shooterX, oy - shooterY)` |
| 2 | `Magnet` | `isLocalShot` && `CombatTAB::FeatMagnetAim::IsEnabled()` | **verbatim** the existing MagnetAim logic (target branch then angle fallback) |
| 3 | `Muzzle` | `isLocalShot` && `muzzleTiles > 0.3f + 0.00051f` | **verbatim** the existing muzzle scale/fallback logic |
| 4 | `Vanilla` | otherwise | `startX, startY` |

Killaura outranks MagnetAim because MagnetAim is explicitly a *visual-only* path
(`FeatMagnetAim.cpp:32` — "Internal-only visual path for local player
projectiles") while killaura is the damage path. When killaura is armed but
`haveShooter` is false (the shooter's position was not in `g_EntityPos` yet),
`Resolve` must fall through to rule 2/3/4 rather than guessing — that is the
fail-closed behaviour.

`KillAura::ComputeShotOrigin` already enforces the `maxOffsetTiles` cap and
finiteness (plan 85 §5.2), so `ShotOrigin` adds no second policy. It must still
reject a non-finite result defensively before returning.

### 7.2 Rewiring the detour

`internal/src/features/movement/dodge/ProjectileTracking.cpp`: replace lines
190-234 with

```cpp
    float spawnX = startX;
    float spawnY = startY;
    const int32_t dk = g_LocalDictKey.load(std::memory_order_relaxed);
    const bool isLocalShot = dk != 0 && (attackerObjId == dk || static_cast<int32_t>(ownerObjId) == dk);

    ShotOrigin::Request req;
    req.isLocalShot = isLocalShot;
    req.angle       = angle;
    req.startX      = startX;
    req.startY      = startY;
    req.muzzleTiles = g_localMuzzleOffsetTiles.load(std::memory_order_relaxed);
    if (isLocalShot) {
        float ex = 0.f, ey = 0.f;
        LookupShooterOrigin(attackerObjId, ownerObjId, ex, ey);
        req.haveShooter = (fabsf(ex) > 0.5f || fabsf(ey) > 0.5f);
        req.shooterX = ex; req.shooterY = ey;
    }
    const ShotOrigin::Source src = ShotOrigin::Resolve(req, spawnX, spawnY);
    WitnessShotOrigin(src);   // transition-only log, see step 4
```

Note this hoists `LookupShooterOrigin` for local shots. That is fine and cheap
(the same call already happens later at `:268-269` for the store path, and it is
a short critical section), but the implementer must **keep the later call
unchanged** — do not try to share the result across the `g_OriginalSpawn` call,
because the entity map can be refreshed in between.

### 7.3 UI

`internal/src/gui/tabs/CombatTab/CombatTAB.cpp`: under the existing muzzle
slider block (`:60-79`), add a read-only line showing the last resolved source:
`Local spawn origin: VANILLA | MUZZLE | MAGNET | KILLAURA`, from a new
`ShotOrigin::LastSource()` accessor (a single relaxed atomic). Extend the
existing "overridden while Magnet Aim is enabled" hint to also mention killaura.

## Steps

1. **Create `ShotOrigin` with vanilla-only behaviour.**
   Create `internal/src/features/projectiles/ShotOrigin.h` and `.cpp`. Implement
   `Resolve` with **only** rule 4 (`Vanilla`) plus the `Source LastSource()`
   accessor. Register both files in
   `internal/il2cpp-dll-injection.vcxproj` (`<ClCompile Include="src\features\projectiles\ShotOrigin.cpp" />`
   next to the other `src\features\projectiles\*.cpp` entries, `<ClInclude>` next
   to their headers) and mirror in `.vcxproj.filters`. Nothing calls it yet.
   → `bash internal/tools/wsl-build.sh Debug`

2. **Move the Magnet and Muzzle branches in, verbatim.**
   Copy the two existing blocks from
   `internal/src/features/movement/dodge/ProjectileTracking.cpp:196-234` into
   `ShotOrigin::Resolve` as rules 2 and 3, character-for-character (same
   constants `2.0f` via `FeatMagnetAim::GetVisualOffsetTiles()`, same
   `kMuzzleMinTiles = 0.3f`, `kMuzzleVanillaEps = 0.00051f`, same `1e-6f`/`1e-5f`
   guards, same precedence). Expose the two muzzle constants from
   `ShotOrigin.cpp` or re-derive them there; do **not** change their values.
   Still nothing calls it.
   → `bash internal/tools/wsl-build.sh Debug`

3. **Switch the detour over (behaviour-identical).**
   Edit `internal/src/features/movement/dodge/ProjectileTracking.cpp`: add
   `#include "features/projectiles/ShotOrigin.h"` and replace lines 190-234 with
   the block in §7.2, **omitting the `WitnessShotOrigin` call for now**. Rule 1
   (killaura) is still absent, so behaviour is bit-identical to before.
   → `bash internal/tools/wsl-build.sh Debug`
   *Manual check: with MagnetAim on and an auto-aim target, local bullets still
   spawn 2 tiles toward the target; with MagnetAim off and the muzzle slider at
   1.0, bullets still spawn further out.*

4. **Add the killaura rule.**
   Edit `internal/src/features/projectiles/ShotOrigin.cpp`: add
   `#include "features/combat/killaura/KillAura.h"` and rule 1 at the top of
   `Resolve`, exactly as specified in §7.1 (including the `haveShooter` and
   finiteness fall-through). Add `WitnessShotOrigin(src)` to the detour: a
   transition-only `DBG_FILE_LOG` that fires only when the resolved `Source`
   **changes** (`static Source s_last = (Source)0xFF;`).
   → `bash internal/tools/wsl-build.sh Debug`

5. **UI readout.**
   Edit `internal/src/gui/tabs/CombatTab/CombatTAB.cpp` per §7.3.
   → `bash internal/tools/wsl-build.sh Debug` and
     `bash internal/tools/check-raw-access.sh`

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # "0 Error(s)"
bash internal/tools/check-raw-access.sh       # exit 0, no output
```

Must return **zero** results — the origin decision now lives in exactly one file,
so no other feature/GUI file may compute a spawn offset:

```bash
grep -rn "GetVisualOffsetTiles\|kMuzzleMinTiles\|kMuzzleVanillaEps" internal/src/ \
  | grep -v "internal/src/features/projectiles/ShotOrigin" \
  | grep -v "internal/src/features/combat/autoaim/FeatMagnetAim"
```

(`ProjectileTracking.cpp` may keep `kMuzzleMinTiles`/`kMuzzleMaxTiles` **only**
inside `SetLocalPlayerMuzzleOffsetTiles`'s clamp at `:576-587`; if the grep hits
those two lines, that is the one accepted result — narrow the grep to
`SpawnProjectileDetour`'s body instead.)

Must return **zero** results:

```bash
grep -rnE 'il2cpp_field_get_offset|il2cpp_class_get_field_from_name|MH_CreateHook' \
  internal/src/features/projectiles/ShotOrigin.cpp
```

In-game acceptance (requires plans 85 and 86 also merged): enable Killaura,
stand out of weapon range of an enemy, hold fire. The enemy must take damage and
the Combat tab must show `Local spawn origin: KILLAURA`. If the enemy takes no
damage but the trace log shows `KILLAURA`, the outbound half (plan 86) is not
armed — check its `REFUSED` log line.

## Out of scope

* **Do not** change MagnetAim's or the muzzle slider's numbers, precedence, or
  UI semantics. This plan moves them; it does not tune them.
* **Do not** touch anything after `g_OriginalSpawn(...)` in
  `SpawnProjectileDetour` — the store/trajectory/prediction path
  (`ProjectileTracking.cpp:255-352`) is auto-dodge's data source and must stay
  bit-identical.
* **Do not** add a second hook (no `MapObject::SetPosition`). The pre-spawn seam
  is sufficient and strictly better.
* **Do not** synthesize `ENEMYHIT`. Letting the game emit it naturally is the
  whole point of this plan.
* **Do not** modify `internal/src/features/combat/autoaim/AimHooks.cpp` (angle
  redirect) or `KillAura.cpp` (plan 85 owns it).
* **Do not** edit `internal/src/features/movement/udodge/UDodgeSolver.cpp` or
  `UDodgeTypes.h` (Phase-3 conflict zone).
