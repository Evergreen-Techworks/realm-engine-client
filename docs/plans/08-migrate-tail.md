# 08 — Migrate the long tail (account, visuals, misc, loot, core/runtime)

## Goal
The remaining raw-access sites outside combat/movement/projectiles/gui are
migrated onto the shared layers: `core/runtime/GameState.cpp`'s local `AddrOk`,
the account hooks (`CharSelect`, `CredentialCapture`) onto `Il2CppHook`, and the
scattered reads in `visuals`, `misc`, `loot`, `account`. After this plan every
consumer in the tree uses `Mem::` / `Il2CppC::` / `Il2CppHook::` and the guardrail
plan (09/10) can lock raw access out.

## Dependencies
MUST merge first: **01** (`Mem`), **03** (`Il2CppHook`) — 02 only if a walk
surfaces here (FloatingTextService uses `FindObjectsByType`, not a manual dict
walk, so 02 is likely unneeded; confirm with grep). Parallel-safe against
04/05/06/07 — this plan touches ONLY `core/runtime/GameState.cpp`,
`features/account/**`, `features/visuals/**`, `features/misc/**`,
`features/loot/**`, `features/runtime/**`. **Coordinate:** `GameState.cpp` is
also read (not written) by many plans; this plan is the ONLY one that edits it.

## Current state
### `core/runtime/GameState.cpp:25` — local `AddrOk` (`>= 0x10000` variant)
Replace with `Mem::AddrOk`. Divergence resolved in plan 01 (`>=` → `>`; inert).

### Account hooks — route through `Il2CppHook`
- `features/account/CredentialCapture.cpp:188-207` (`Connect`, `SetSteamId`
  MinHooks) — resolve + install boilerplate.
- `features/account/CharSelect.cpp:54-64` (`HookedCtor`, `HookedHide`).
Both also have raw `Resolver::` class/method lookups feeding the install.

### Scattered reads
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/visuals/ internal/src/features/misc/ internal/src/features/loot/ internal/src/features/account/ internal/src/features/runtime/
```
Known: `features/visuals/FloatingTextService.cpp` (1 read + a
`Resolver::FindObjectsByType` at `:51` — leave the FindObjectsByType call, only
migrate raw reads),
`features/visuals/skins/character/SkinChanger.cpp` (1 il2cpp call — leave the
property set/invoke; only migrate any raw offset read).

### Remaining local `AddrOk`
Confirm none remain outside the four migrated subtrees:
```
grep -rn 'bool AddrOk\|bool AddrValid' internal/src/ | grep -v core/runtime/MemRead.h
```
After plans 04–07 the only survivor should be `GameState.cpp` — migrate it here.

## Target design
Same mechanical rules as plans 04/03. For account hooks:
```cpp
// before (CredentialCapture.cpp)
MH_STATUS cs = MH_CreateHook(s_connectTarget, &ConnectDetour, (void**)&oConnect);
if (cs == MH_OK) MH_EnableHook(s_connectTarget); else DBG_FILE_LOG(...);
// after
#include "platform/hooks/Il2CppHook.h"
Il2CppHook::InstallMinHook(s_connectTarget, &ConnectDetour, (void**)&oConnect,
                           "credcap.Connect");
```
Where the target is currently resolved via bespoke `Resolver::` calls with an
obfuscated class name, switch to `Il2CppHook::ResolveMethod(cls, mtd, argc,
/*loose*/true)`; keep exact-name lookups with `loose=false`.

## Steps
1. `core/runtime/GameState.cpp`: replace local `AddrOk` with `Mem::AddrOk`
   (add `#include "core/runtime/MemRead.h"`). Build. **Do not change GameState's
   AppMgr/WorldMgr/LocalPtr resolution logic or Tick order.**
2. `features/account/CredentialCapture.cpp`: route hooks through `Il2CppHook`;
   migrate reads. Build.
3. `features/account/CharSelect.cpp` + `HwidCapture.cpp`: hooks + reads. Build.
4. `features/visuals/**` + `features/misc/**` + `features/loot/**` +
   `features/runtime/**`: migrate raw reads only (leave `FindObjectsByType`,
   property invokes, IPC). Build.
5. Full build both configs.

Each: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- `grep -rn 'bool AddrOk\|bool AddrValid' internal/src/ | grep -v core/runtime/MemRead.h`
  → empty (every local copy gone tree-wide).
- `grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/visuals/ internal/src/features/misc/ internal/src/features/loot/ internal/src/features/account/`
  → empty.
- `grep -rn 'MH_CreateHook' internal/src/features/account/` → empty.
- Runtime smoke: char-select capture still fires; floating damage text renders.

## Out of scope
- GameState resolution logic / Tick ordering.
- `Resolver::FindObjectsByType`, IL2CPP property get/set, and IPC calls — not
  part of the raw-offset-read migration.
- Files in combat/movement/projectiles/gui (other plans own those).
