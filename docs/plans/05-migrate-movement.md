# 05 — Migrate `features/movement/**` to the shared layers

## Goal
Every file under `internal/src/features/movement/` reads memory via `Mem::`,
walks containers via `Il2CppC::WalkDict`, and installs hooks via `Il2CppHook::`.
The dodge subtree (the heaviest raw-read consumer, ~34 read sites) plus noclip,
speedhack, and collider lose their local `AddrOk` copies, open-coded reads,
duplicated dict-layout constants, and hook boilerplate. Behavior identical.

## Dependencies
MUST merge first: **01** (`Mem`), **02** (`Il2CppC`), **03** (`Il2CppHook`).
Parallel-safe against 04/06/07/08 — touches ONLY `features/movement/**`.

## Current state
Subtree: `dodge/`, `noclip/`, `collider/`, `speedhack/`, `pjdodge/`, `repp/`,
`zdodge/`. (pjdodge/repp/zdodge have **no** raw `RuntimeOffsets::` reads — they
work off snapshots — so they need little/no change; verify with the greps.)

### Local `AddrOk` copies — replace with `Mem::AddrOk`
- `dodge/AoeTracking.cpp:145`
- `dodge/ProjectileTracking.cpp:101`
- `noclip/NoclipHook.cpp:12`
- `speedhack/SpeedHack.cpp:70`
Note the divergence resolved in plan 01: `SpeedHack.cpp:71` used `>= 0x10000`
(inclusive); the canonical `Mem::AddrOk` uses `> 0x10000`. Inert (0x10000 is
never a live object).

### Raw field reads (~34, concentrated in dodge) — `Mem::TryRead`/`ReadOr`
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/movement/
```
Heavy files: `dodge/AoeTracking.cpp`, `dodge/DangerPlanner.cpp`,
`dodge/ProjectileTracking.cpp`, `dodge/MovementRuntime.cpp`. Representative:
```cpp
// dodge/AoeTracking.cpp:199-203
ox = *reinterpret_cast<float*>(base + RuntimeOffsets::Gjj_OriginX); ...
// dodge/DangerPlanner.cpp:66
outX = *reinterpret_cast<const float*>(lp + RuntimeOffsets::PosX);
```

### Duplicated dict-layout constants + walks — `Il2CppC::WalkDict`
`dodge/AoeTracking.cpp:272-279` (`kDict_Entries/kDict_Count/kArr_MaxLen/kArr_Data/
kEntrySize/kEntry_Hash/kEntry_Value/kEntry_Key`) with two walk sites
(`FindOwnerIsEnemyAtPos` ~:280 and `FindEntityIsEnemyById` ~:340). Both walk
`GameState::GetWorldMgr() + RuntimeOffsets::WM_AllDict`.

### Hook installers — route through `Il2CppHook`
- `dodge/AoeTracking.cpp:841,908,943,981` (four `ShowEffect`/`GjjKob`/`FhohKob`/
  `ExplSpawn` detours).
- `dodge/DangerPlanner.cpp:860-867`.
- `dodge/ProjectileTracking.cpp:441-445`.
- `noclip/NoclipHook.cpp:34` (`FindMethod`) + `:129-149` install.
- `speedhack/SpeedHack.cpp:390` uses **`DetourAttach`, not MinHook — LEAVE IT**.

## Target design
Identical mechanical rules to plan 04. Key specifics:

**AoeTracking dict walks — before/after:**
```cpp
// before: __try { ... hand loop over kEntrySize ... } __except {}
// after:
#include "core/il2cpp/Il2CppContainers.h"
Il2CppC::WalkDict(dictPtr, 4096, [&](int32_t key, void* entity){
    if (!Mem::AddrOk(entity)) return;
    float ex, ey;
    if (!Mem::TryRead(entity, RuntimeOffsets::PosX, ex)) return;
    if (!Mem::TryRead(entity, RuntimeOffsets::PosY, ey)) return;
    // ... existing tolerance / isEnemy logic, reads via Mem ...
});
```
`FindEntityIsEnemyById` walks by key — `WalkDict`'s callback provides `key`, so
match on it directly (delete the local `kEntry_Key` read). Delete all local
`kDict_*/kArr_*/kEntry*` constants.

**NoclipHook:** replace `FindMethod` with
`Il2CppHook::ResolveMethod(className, methodName, argc, /*loose*/true)` (it
already used `FindClassLoose`), and the install block with
`Il2CppHook::InstallMinHook`. Uninstall stays as-is.

## Steps
1. `dodge/DangerPlanner.cpp`: AddrOk + reads; route its hook install through
   `Il2CppHook`. Build.
2. `dodge/ProjectileTracking.cpp`: AddrOk + reads + hook install. Build.
3. `dodge/MovementRuntime.cpp` + any other `dodge/*.cpp` with raw reads (check
   grep): reads. Build.
4. `dodge/AoeTracking.cpp` (largest): AddrOk + reads + both `WalkDict` sites +
   four hook installs. Build.
5. `noclip/NoclipHook.cpp` + `noclip/Noclip.cpp`: AddrOk + `Il2CppHook`. Build.
6. `speedhack/SpeedHack.cpp` + `collider/PlayerCollider.cpp`: AddrOk + reads
   (do NOT touch the `DetourAttach` hook). Build.
7. Verify pjdodge/repp/zdodge: run the grep; migrate only if it returns hits.
   Build all both configs.

Each step: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- `grep -rn 'bool AddrOk' internal/src/features/movement/` → empty.
- `grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/movement/` → empty.
- `grep -rn 'kDict_\|kArr_\|kEntry_\|kEntrySize' internal/src/features/movement/` → empty.
- `grep -rn 'MH_CreateHook' internal/src/features/movement/` → empty (SpeedHack's
  `DetourAttach` is NOT MinHook and is expected to remain).
- Runtime smoke: auto-dodge still avoids AoEs; noclip toggles; speedhack multiplier applies.

## Out of scope
- The `DetourAttach` hook in `speedhack/SpeedHack.cpp` — do not convert it.
- Dodge planning math (pjdodge/repp/zdodge/rollout geometry) — behavior-preserving only.
- Files outside `features/movement/`.
