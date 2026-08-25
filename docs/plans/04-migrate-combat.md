# 04 — Migrate `features/combat/**` to the shared layers

## Goal
Every file under `internal/src/features/combat/` reads IL2CPP memory through
`Mem::` (plan 01), walks containers through `Il2CppC::` (plan 02), and installs
hooks through `Il2CppHook::` (plan 03). All 5 local `AddrOk` copies, the
open-coded field reads, the EnemyTracker dictionary walk, and the AimHooks /
ProjNoclip install boilerplate in this subtree are gone, replaced 1:1 by calls
into the shared layers. Behavior is identical.

## Dependencies
MUST merge first: **01** (`Mem`), **02** (`Il2CppC`), **03** (`Il2CppHook`).
Parallel-safe against plans 05/06/07/08 — this plan touches ONLY
`features/combat/**`, which no other consumer plan touches. No shared files.

## Current state
Files in scope (combat family): `autoaim/{AimHooks,AimMath,AutoAim,FeatAutoAim,
FeatMagnetAim,ProjNoclip,TargetSelector,WeaponProfile}.cpp`,
`autoability/AutoAbility.cpp`, `autonexus/AutoNexus.cpp`,
`enemytracker/EnemyTracker.cpp`, `ghostHit/GhostHit.cpp`.

### Local `AddrOk` copies (5) — replace with `Mem::AddrOk`
- `autoaim/AimHooks.cpp:54`
- `autoaim/WeaponProfile.cpp:20`
- `autoaim/AutoAim.cpp:20`
- `autoaim/ProjNoclip.cpp:38`
- `enemytracker/EnemyTracker.cpp:50`

### Raw field reads (~13) — replace with `Mem::TryRead` / `Mem::ReadOr`
Authoritative list:
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/combat/
```
Representative (`AutoAbility.cpp`, `ProjNoclip.cpp`, `WeaponProfile.cpp`,
`AimMath.cpp`). Also catch the `*(T*)(base+off)` form:
```
grep -rnE '\*\s*\(\s*(const\s+)?(float|int32_t|uint32_t|int|bool|uint8_t)\s*\*\s*\)' internal/src/features/combat/
```

### EnemyTracker dictionary walk — replace with `Il2CppC::WalkDict`
`enemytracker/EnemyTracker.cpp:29-33` (local `kOffDictEnt/kOffDictCnt/kOffArrMax/
kOffArrData/kEntryStride`) and the walk at `:250-300`. This is the per-frame
snapshot builder (`Tick()`), the hottest walk in the tree.

### Hook installers — route through `Il2CppHook`
- `autoaim/AimHooks.cpp:146` local `ResolveMethod` + `:174-183` install block.
- `autoaim/ProjNoclip.cpp:149-215` inline resolve + install.

## Target design
Mechanical replacements only. No logic, ordering, or value changes.

**AddrOk:** delete each local `static ... AddrOk(...)` definition; add
`#include "core/runtime/MemRead.h"`; replace bare `AddrOk(` calls with
`Mem::AddrOk(`. (If a file uses `AddrOk` heavily, a local
`using Mem::AddrOk;` at file scope keeps call sites untouched — allowed.)

**Field reads — before/after:**
```cpp
// before
float sp = *reinterpret_cast<float*>(base + RuntimeOffsets::PP_Speed);
// after
float sp = Mem::ReadOr<float>(base, RuntimeOffsets::PP_Speed, 0.0f);
```
```cpp
// before (already inside a __try that returns false on AV)
outX = *reinterpret_cast<const float*>(lp + RuntimeOffsets::PosX);
// after — TryRead is itself SEH-safe; keep the outer guard or drop it if the
// only thing it protected was this read (preserve the false-return semantics)
if (!Mem::TryRead(lp, RuntimeOffsets::PosX, outX)) return false;
```
Pointer-field reads `*(void**)(base+off)` → `Mem::ReadPtr(base, off)`.

**EnemyTracker walk — before/after:**
```cpp
// before: hand loop over kOffDictEnt/kEntryStride with per-slot reads
// after:
#include "core/il2cpp/Il2CppContainers.h"
Il2CppC::WalkDict(allDict, /*maxEntries*/4096, [&](int32_t key, void* entity){
    if (!Mem::AddrOk(entity)) return;
    // ... existing per-entity field reads, now via Mem::ReadOr ...
});
```
Delete the local `kOffDict*/kOffArr*/kEntryStride` constants. **Divergence note:**
EnemyTracker previously walked by stride without the `hashCode < 0` skip;
`Il2CppC::WalkDict` adds that skip. This is correct (it filters free/tombstone
slots that EnemyTracker's value-pointer `AddrOk` check was already discarding),
so the visible entry set is unchanged. Verify the snapshot count is stable in the
Test tab after migration.

**Hooks — before/after (AimHooks):**
```cpp
// before
g_csaTarget = ResolveMethod(kPlayerClass, kCSAMethod, 4);
if (MH_CreateHook(g_csaTarget, &ComputeShootAngleDetour, (void**)&oCSA) != MH_OK) ...
MH_EnableHook(g_csaTarget);
// after
#include "platform/hooks/Il2CppHook.h"
g_csaTarget = Il2CppHook::ResolveMethod(kPlayerClass, kCSAMethod, 4, /*loose*/false);
if (!Il2CppHook::InstallMinHook(g_csaTarget, &ComputeShootAngleDetour,
                                (void**)&oCSA, "AutoAim.CSA")) return false;
```
Decide `loose` per class token: `kPlayerClass`/`kShootClass` in AimHooks are
BeeByte blobs → pass `loose=true` (default) unless they are real names; ProjNoclip
uses `HBEAKBIHANL` (obfuscated) → `loose=true`. Keep MinHook `MH_Initialize`
where it already is.

## Steps
1. `autoaim/AutoAim.cpp` + `autoaim/AimMath.cpp`: replace AddrOk + reads. Build.
2. `autoaim/WeaponProfile.cpp` + `autoaim/TargetSelector.cpp` +
   `autoaim/FeatAutoAim.cpp` + `autoaim/FeatMagnetAim.cpp`: reads/AddrOk. Build.
3. `autoaim/AimHooks.cpp`: reads + AddrOk + route installs through `Il2CppHook`.
   Build.
4. `autoaim/ProjNoclip.cpp`: reads + AddrOk + installs. Build.
5. `autoability/AutoAbility.cpp` + `autonexus/AutoNexus.cpp` +
   `ghostHit/GhostHit.cpp`: reads. Build.
6. `enemytracker/EnemyTracker.cpp`: AddrOk + `Il2CppC::WalkDict` + reads. Build.
7. Full build both configs.

Each step ends with:
`msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`

## Verification
- Both configs build, no new warnings.
- Zero raw patterns remain in this subtree:
  - `grep -rn 'bool AddrOk' internal/src/features/combat/` → empty.
  - `grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/combat/` → empty.
  - `grep -rn 'kOffDict\|kEntryStride\|MH_CreateHook' internal/src/features/combat/` → empty.
- Runtime smoke (Windows, if available): Test → OFFSET HEALTH unchanged; EnemyTracker
  snapshot count matches pre-migration; auto-aim still fires.

## Out of scope
- Do NOT change auto-aim/enemy-selection logic, thresholds, or velocity blending.
- Do NOT touch files outside `features/combat/`.
- Do NOT centralize the game-specific `WM_AllDict` offset (stays in RuntimeOffsets).
