# 02 — IL2CPP container readers (`core/il2cpp/Il2CppContainers.h`)

## Goal
After this plan a single header `core/il2cpp/Il2CppContainers.h` (namespace
`Il2CppC`) owns the `.NET`/IL2CPP container **layout constants** (Dictionary,
Array, List, String) and provides `WalkDict`, `ListItems`, and `ReadString`
helpers. Today these layout offsets (`0x18` entries, `0x20` count, `0x10`
items, etc.) are re-declared with different names in at least four files, and
each file open-codes the walk loop. This plan creates the header and its one
canonical `WalkDict` (lifted from WorldTAB's proven implementation). It migrates
**no** consumers (plan 05/07 do that). The repo builds and behaves identically.

## Dependencies
Depends on **01** (uses `Mem::AddrOk` / `Mem::TryRead`). Otherwise
parallel-safe: creates one new file, edits nothing existing. Dependency of
plans 05 and 07.

## Current state
The IL2CPP `Dictionary<int,T>` / `T[]` / `List<T>` / string layout constants are
duplicated. `RuntimeOffsets.h:19-21` explicitly documents that these are **.NET
runtime invariants, intentionally NOT in RuntimeOffsets** — so a *separate*
container header (not RuntimeOffsets) is the correct home.

Divergent-name copies of the **same** values:
```
// features/movement/dodge/AoeTracking.cpp:272-279
kDict_Entries=0x18  kDict_Count=0x20  kArr_MaxLen=0x18  kArr_Data=0x20
kEntrySize=24  kEntry_Hash=0  kEntry_Value=16  kEntry_Key=8
// features/combat/enemytracker/EnemyTracker.cpp:29-33
kOffDictEnt=0x18  kOffDictCnt=0x20  kOffArrMax=0x18  kOffArrData=0x20  kEntryStride=24
// gui/tabs/WorldTAB.cpp:124-129
OFF_DICT_ENTRIES=0x18  OFF_DICT_COUNT=0x20  OFF_ARR_MAXLEN=0x18  OFF_ARR_DATA=0x20
OFF_LIST_ITEMS=0x10   OFF_LIST_SIZE=0x18   OFF_STR_LEN=0x10   DICT_ENTRY_SIZE(=24)
```
All three agree on the values. The **walk loops** are also near-duplicates. The
cleanest existing one (already SEH-safe, clamps count, skips negative hash) is
WorldTAB's — promote it:
```cpp
// gui/tabs/WorldTAB.cpp:346-380 (abridged)
template<typename Cb>
static void WalkDict(void* dictPtr, int maxEntries, Cb cb) {
    if (!AddrValid(dictPtr)) return;
    void* entriesArr = nullptr; int32_t count = 0;
    SafeRead(dictPtr, OFF_DICT_ENTRIES, entriesArr);
    SafeRead(dictPtr, OFF_DICT_COUNT,   count);
    if (!AddrValid(entriesArr)) return;
    int32_t maxLen = 0; SafeRead(entriesArr, OFF_ARR_MAXLEN, maxLen);
    if (maxLen <= 0 || maxLen > 65536) maxLen = maxEntries;
    if (count  <= 0 || count  > maxLen) count = maxLen;
    for (int32_t i = 0; i < count; ++i) {
        const uint8_t* entry = (uint8_t*)entriesArr + OFF_ARR_DATA + (size_t)i*DICT_ENTRY_SIZE;
        int32_t hash; SafeRead(entry, 0, hash); if (hash < 0) continue;
        void* value; SafeRead(entry, OFF_ENTRY_VALUE, value);
        int32_t key;  SafeRead(entry, OFF_ENTRY_KEY,  key);
        cb(key, value);
    }
}
```
Enumerate all consumers before/after:
```
grep -rn 'WalkDict\|kDict_\|kOffDict\|OFF_DICT_\|kEntryStride\|kEntrySize\|WM_AllDict\|WM_MapDict' internal/src/
```

### Divergence to preserve
The entry `hash < 0` skip guards against unused/tombstone slots. WorldTAB and
AoeTracking include it; EnemyTracker (`EnemyTracker.cpp:277+`) walks by stride
without the explicit hash check but validates the value pointer instead. **The
hash-skip is correct** (matches the .NET `Dictionary` entry layout where
`hashCode < 0` marks free slots) — the canonical `WalkDict` keeps it. Consumers
that additionally validate the value pointer keep doing so via the callback.

## Target design
Create `internal/src/core/il2cpp/Il2CppContainers.h`:

```cpp
#pragma once
#include <cstdint>
#include "core/runtime/MemRead.h"
// IL2CPP / .NET container memory layouts. These are runtime invariants (NOT
// game-specific offsets — do not move to RuntimeOffsets). x64 layouts.
namespace Il2CppC {
    // Dictionary<TKey,TValue> (managed): _entries ptr, _count int.
    inline constexpr uint32_t kDictEntries = 0x18;
    inline constexpr uint32_t kDictCount   = 0x20;
    // Entry<int,ptr> stride/fields inside the entries T[].
    inline constexpr uint32_t kEntryStride = 24;   // sizeof Entry<int,ptr>
    inline constexpr uint32_t kEntryHash   = 0;    // int hashCode (<0 => free)
    inline constexpr uint32_t kEntryKey    = 8;    // int key
    inline constexpr uint32_t kEntryValue  = 16;   // T value (ptr)
    // System.Array: max length header, first element.
    inline constexpr uint32_t kArrMaxLen   = 0x18;
    inline constexpr uint32_t kArrData     = 0x20;
    // List<T>: _items (T[]) ptr, _size int.
    inline constexpr uint32_t kListItems   = 0x10;
    inline constexpr uint32_t kListSize    = 0x18;
    // System.String: length int (chars follow at 0x14).
    inline constexpr uint32_t kStrLen      = 0x10;
    inline constexpr uint32_t kStrChars    = 0x14;

    // Walk a Dictionary<int, ptr>. cb(int key, void* value) per live entry.
    // maxEntries clamps a corrupt count. SEH-safe throughout.
    template<typename Cb>
    inline void WalkDict(void* dictPtr, int maxEntries, Cb cb) {
        if (!Mem::AddrOk(dictPtr)) return;
        void* entries = Mem::ReadPtr(dictPtr, kDictEntries);
        int32_t count = Mem::ReadOr<int32_t>(dictPtr, kDictCount, 0);
        if (!Mem::AddrOk(entries)) return;
        int32_t maxLen = Mem::ReadOr<int32_t>(entries, kArrMaxLen, 0);
        if (maxLen <= 0 || maxLen > 65536) maxLen = maxEntries;
        if (count  <= 0 || count  > maxLen) count  = maxLen;
        for (int32_t i = 0; i < count; ++i) {
            const void* e = reinterpret_cast<const uint8_t*>(entries)
                          + kArrData + static_cast<size_t>(i) * kEntryStride;
            if (Mem::ReadOr<int32_t>(e, kEntryHash, -1) < 0) continue;
            int32_t key   = Mem::ReadOr<int32_t>(e, kEntryKey, 0);
            void*   value = Mem::ReadPtr(e, kEntryValue);
            cb(key, value);
        }
    }

    // First `outMax` items of a List<T> of pointers into `out`; returns count.
    int ListItems(void* listPtr, void** out, int outMax);
    // Copy an IL2CPP string into a UTF-8 buffer (best effort). Returns length.
    int ReadString(void* strPtr, char* out, int outCap);
}
```
Put `ListItems`/`ReadString` bodies in a new `Il2CppContainers.cpp` (they need a
loop / UTF-16→8 narrowing; keep `WalkDict` header-inline since it is templated).

**Location:** `core/il2cpp/` (next to `il2cpp-init`, the IL2CPP concern folder).
**Ownership:** header owns the constants; `.cpp` owns the two non-template fns.
**Thread-safety:** stateless.
**Hot path:** `WalkDict` runs per-frame in EnemyTracker/AoeTracking. It is
`inline` + templated so the callback inlines; equivalent to today's hand loops.
Keep the single-`__try`-per-read model (via `Mem`) — do NOT wrap the whole loop
in one giant SEH frame, matching current per-read safety.

## Steps
1. Create `internal/src/core/il2cpp/Il2CppContainers.h` (constants + `WalkDict`).
2. Create `internal/src/core/il2cpp/Il2CppContainers.cpp` implementing
   `ListItems` and `ReadString`; add both files to the `.vcxproj` (ClCompile for
   the `.cpp`, ClInclude for the `.h`) next to `il2cpp-init.cpp`.
3. Force-compile check: temporarily `#include "core/il2cpp/Il2CppContainers.h"`
   in `core/il2cpp/il2cpp-init.cpp`, build both configs, remove the include.
4. Build:
   `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`
   and `/p:Configuration=Debug`.

## Verification
- Both configs build with no new warnings.
- Files exist and are in the project:
  `grep -c Il2CppContainers internal/il2cpp-dll-injection.vcxproj` ≥ 2.
- No consumer migrated yet: `grep -rc 'Il2CppC::' internal/src/` shows only the
  new files.

## Out of scope
- Do NOT migrate AoeTracking / EnemyTracker / WorldTAB / CameraTAB /
  FloatingTextService onto `Il2CppC::WalkDict` — that is plans 05 and 07.
- Do NOT move the **game-specific** `WM_AllDict` / `WM_MapDictA` offsets here;
  those stay in `RuntimeOffsets` (they change on game patches). Only the .NET
  container layout is centralized here.
