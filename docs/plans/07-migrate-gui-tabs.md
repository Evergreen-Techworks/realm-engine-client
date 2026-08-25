# 07 — Migrate `gui/tabs/**` to the shared layers (retire the WorldTAB donor)

## Goal
The ImGui tab code reads memory via `Mem::` and walks containers via
`Il2CppC::`. Crucially, **WorldTAB.cpp's local `SafeRead` / `AddrValid` /
`WalkDict` — the proven implementation that plan 02 was lifted from — is deleted
and its call sites re-pointed at the shared `Il2CppC::WalkDict` / `Mem::`**, so
the donor no longer keeps a private fork. CameraTAB's dictionary walks and the
tabs' scattered field reads move to the shared layers too. Behavior identical.

## Dependencies
MUST merge first: **01** (`Mem`), **02** (`Il2CppC`). Does not need 03 (tabs
install no MinHooks). Parallel-safe against 04/05/06/08 — touches ONLY
`internal/src/gui/tabs/**`.

## Current state
Files: `WorldTAB.cpp`, `CameraTAB.cpp`, `PlayerTAB.cpp`, `TestTAB.cpp`,
`VisualsTAB.cpp`, `CombatTab/CombatTAB.cpp`.

### WorldTAB private container/memory layer — retire it
- `WorldTAB.cpp:322` `SafeRead<T>` (identical to `Mem::TryRead`).
- `WorldTAB.cpp:337` `AddrValid` (upper bound `0x7FFFFFFFFFF` — 11 F, the
  **too-low** ceiling; canonical `Mem::AddrOk` uses 12 F — this is the intended
  fix, see 00-overview Divergence bugs).
- `WorldTAB.cpp:124-129` local `OFF_DICT_ENTRIES/OFF_DICT_COUNT/OFF_ARR_MAXLEN/
  OFF_ARR_DATA/OFF_LIST_ITEMS/OFF_LIST_SIZE/OFF_STR_LEN` + `DICT_ENTRY_SIZE`.
- `WorldTAB.cpp:346` `WalkDict<Cb>` template, called at `:481` and `:694`
  (and other `WalkDict(` sites — 14 dict/list references total per grep).

### CameraTAB dict/entity walks
`CameraTAB.cpp` walks the world dict and caches `CameraManager` via
`Resolver::FindObjectsByType` (`:196`). Its inline field reads and any local
layout constants move to `Mem::`/`Il2CppC::`.

### Scattered reads (~7) — `Mem::`
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/gui/tabs/
```

## Target design
**Retire WorldTAB's private layer — before/after:**
```cpp
// before (WorldTAB.cpp top): local SafeRead / AddrValid / WalkDict / OFF_* consts
// after: delete all of them, add:
#include "core/runtime/MemRead.h"
#include "core/il2cpp/Il2CppContainers.h"
// call sites:
WalkDict(dictPtr, 8192, cb);           →  Il2CppC::WalkDict(dictPtr, 8192, cb);
SafeRead(p, off, out);                 →  Mem::TryRead(p, off, out);
AddrValid(p);                          →  Mem::AddrOk(p);
OFF_DICT_ENTRIES / OFF_ARR_DATA / …    →  Il2CppC::kDictEntries / kArrData / …
OFF_LIST_ITEMS / OFF_LIST_SIZE         →  Il2CppC::kListItems / kListSize
OFF_STR_LEN                            →  Il2CppC::kStrLen
```
The callback signatures used at `WorldTAB.cpp:481,694` are `(int32_t key, void*
value)` — identical to `Il2CppC::WalkDict`'s callback, so the lambdas are unchanged.

**CameraTAB / other tabs:** replace raw reads with `Mem::ReadOr`/`TryRead`; if
CameraTAB has local dict constants, delete them and use `Il2CppC::`. Keep
`Resolver::FindObjectsByType` caching as-is (that is a separate concern, out of
scope).

## Steps
1. `WorldTAB.cpp`: delete local `SafeRead`/`AddrValid`/`WalkDict`/`OFF_*`
   constants; add the two includes; re-point every `WalkDict(`/`SafeRead(`/
   `AddrValid(`/`OFF_*` reference to the shared symbols. Build. **This is the
   largest single step — WorldTAB is ~2200 lines; do it carefully and confirm the
   grep for the retired symbols is empty afterward.**
2. `CameraTAB.cpp`: reads + any dict walk → `Il2CppC::`/`Mem::`. Build.
3. `PlayerTAB.cpp` + `TestTAB.cpp`: reads → `Mem::`. (Also see plan 09 for the
   `4 + 5.6*spd/75` speed formula duplicated here — that is a SEPARATE plan; do
   NOT touch the formula in this plan.) Build.
4. `VisualsTAB.cpp` + `CombatTab/CombatTAB.cpp`: reads if any. Build both configs.

Each: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- WorldTAB's private layer is gone:
  `grep -n 'SafeRead\|AddrValid\|static.*WalkDict\|OFF_DICT_\|OFF_ARR_\|OFF_LIST_\|OFF_STR_' internal/src/gui/tabs/WorldTAB.cpp`
  → empty.
- `grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/gui/tabs/` → empty.
- Runtime smoke: World tab entity list populates; Camera tab reads zoom/angle;
  Test tab OFFSET HEALTH panel renders. The World-tab entity list count must
  match pre-migration (the ceiling fix from 11→12 F only admits higher addresses
  that were never present in practice, so the visible set should be unchanged).

## Out of scope
- The move-speed formula (`4 + 5.6*spd/75`) in PlayerTAB/TestTAB — plan 09.
- `Resolver::FindObjectsByType` caching strategy in CameraTAB.
- ImGui layout / rendering.
- Files outside `gui/tabs/`.
