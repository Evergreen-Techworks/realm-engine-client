# 40 — ProjNoclip / PlayerCollider / TestTAB Offset Migration

## Goal
Three files stop carrying private field-offset fallbacks and private
offset-resolution code, and read/write those fields through the
`RuntimeOffsets` entries added by plan 37. PlayerCollider additionally loses
its local duplicates of `Mem::ReadPtr` and the field-resolution mini-framework.
Behavior is preserved (divergences noted below).

## Dependencies
- **Plan 37 must be merged first** (uses `Hbeak_NoclipGuard`, `KJ_TileRef`,
  `Sq_Layer`, `OP_CollRadiusMult`).
- Parallel-safe with plans 38, 39, 41, 42 (disjoint files).
- **Cross-wave conflict:** `gui/tabs/TestTAB.cpp` is also edited by dodge
  plans 33/35 (dodge-mode enum/transitions around TestTAB.cpp:141-211 and
  ~1414). This plan edits different regions (~219-267, ~731, ~796-801), but
  line numbers WILL drift — merge this plan after dodge plans 33/35 and
  re-locate by the quoted code, not by line number.

Files touched:
- `internal/src/features/combat/autoaim/ProjNoclip.cpp`
- `internal/src/features/movement/collider/PlayerCollider.cpp`
- `internal/src/gui/tabs/TestTAB.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.

## Current state

### ProjNoclip.cpp — private offset statics + resolution block
- Statics (lines 42-44): `s_npmOff` (HBEAKBIHANL.NPMECLDKGEF, no fallback),
  `s_eokOff` (KJMONHENJEN.EOKJOGFPLOA), `s_ebclOff` (BGAIOPJMHLO.EBCLNFDKKEH).
- Local fallbacks (lines 51, 54): `kFallbackEokOff = 0x58`,
  `kFallbackEbclOff = 0x44`.
- Private resolution in `Install()` (lines 152-177): three
  `il2cpp_class_get_field_from_name` + `il2cpp_field_get_offset` blocks
  (one walks the class hierarchy manually, lines 155-158).
- Gate (line 180): `if (s_npmOff == 0) return;` — the hook must NOT install
  unless NPMECLDKGEF resolved from metadata.
- Uses: hook body reads at lines 81-100 (single `__try` sequence: read npm
  bool → read tile ptr → save layer → write 37), restore write at line 120.
- `Install()` also does `Resolver::GetClass("", "HBEAKBIHANL")` (line 141)
  solely to seed the field walk.

### PlayerCollider.cpp — private mini-framework over registry-known fields
- `kOffCollisionMultiplierFallback = 0x780` (line 12) +
  `g_collisionMultiplierOffset` (line 30) — the field has a real name,
  `ObjectProperties.collisionRadiusMultiplier` (line 115), registry entry
  `OP_CollRadiusMult` after plan 37.
- `FindFieldOnHierarchy` (lines 36-43) — copy of RuntimeOffsets.cpp:223-230.
- `ResolveFieldOffset` (lines 70-87) — generic field→offset resolver.
- `ReadPointerRef` (lines 89-100) — functional duplicate of `Mem::ReadPtr`
  plus an `offset == 0` early-out.
- `ResolveCollisionMultiplierOffset` (lines 107-119) — validates the object
  is an `ObjectProperties` and re-resolves 0x780.
- `ResolveObjectPropertiesOffset` (lines 121-133) — re-resolves
  `OBAKMCCDBJA`/`KKENJFFDMPO`/`GGBCADDBAPN` per entity class, even though the
  call site at lines 307-311 already seeds the offsets from
  `RuntimeOffsets::ObjProps`/`MoObjectProps`/`PlayerCollisionProps`.
- `ResolveViewDestroyEntity` (lines 135-151) — re-resolves
  `KJ_ViewHandler`/`VH_DestroyEntity`, both already registry rows.
- `ReadCollisionMultiplier`/`WriteCollisionMultiplier` (lines 153-175) —
  hand-rolled SEH read/write ≡ `Mem::TryRead`/`Mem::TryWrite`.

### TestTAB.cpp — duplicated constants + raw teleport writes
- Lines 219-221:
  ```cpp
  static constexpr uint32_t kOffObjProps1      = 0x18;   // KJMONHENJEN.OBAKMCCDBJA
  static constexpr uint32_t kOffObjProps2      = 0x1C8;  // LKHPPBEGNOM.KKENJFFDMPO
  static constexpr uint32_t kOffCollisionMult  = 0x780;  // ObjectProperties.collisionRadiusMultiplier
  ```
  — duplicates of `RuntimeOffsets::ObjProps`, `RuntimeOffsets::MoObjectProps`
  and (post-plan-37) `RuntimeOffsets::OP_CollRadiusMult`. Used in
  `ReadCollisionMult`/`ReadCollisionMultAlt` (lines 233-261, reads carry
  `raw-access-ok` markers).
- Lines 796-801, Ctrl+Click teleport:
  ```cpp
  __try {
      *(float*)((uint8_t*)localPlayer + 0x3C) =  tpX;
      *(float*)((uint8_t*)localPlayer + 0x40) =  tpY;
      *(float*)((uint8_t*)localPlayer + 0x68) =  tpX;
      *(float*)((uint8_t*)localPlayer + 0x6C) = -tpY;
  } __except (EXCEPTION_EXECUTE_HANDLER) {}
  ```
  0x3C/0x40 are `RuntimeOffsets::PosX`/`PosY`; 0x68/0x6C are
  `RuntimeOffsets::KJ_Float3Pos` x/y (see RuntimeOffsets.h:115 — "written on
  teleport/move"). These C-style casts evade every guardrail check and do
  NOT self-heal.

## Target design / migration rules

- ProjNoclip: delete statics, fallbacks, and the whole resolution block; use
  `RuntimeOffsets::Hbeak_NoclipGuard` / `KJ_TileRef` / `Sq_Layer` directly at
  the read/write sites. The install gate becomes
  `if (RuntimeOffsets::Hbeak_NoclipGuard == 0) return;` — identical
  semantics because plan 37 gave that entry fallback 0 and `Install()` is
  retried until it succeeds (`s_installed` stays false; callers:
  FeatAutoAim.cpp:49, FeatureRuntime.cpp:56).
- Hook-body reads/writes STAY raw (single shared `__try` whose fault must
  abort the whole save-modify sequence atomically) — add a same-line
  `raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must
  abort atomically` comment to each line that now names `RuntimeOffsets::`,
  otherwise guardrail check 2 fires.
- PlayerCollider: delete the mini-framework; reads/writes go through `Mem::`
  and registry values.
- TestTAB: constants replaced by registry names; teleport writes become
  `Mem::TryWrite` calls.

### Divergence warnings
- **PlayerCollider resolution robustness:** the deleted per-object
  `ResolveFieldOffset` walk could succeed even when the registry's
  `FindClassLoose`-by-name row failed (it resolves off the live object's
  class). Chosen behavior: registry values (single source, health-panel
  visibility). If a future patch renames a class, the registry row goes
  STALE-visible instead of the collider silently self-healing — a
  stale-but-visible failure mode (flagged in the Test → OFFSET HEALTH panel)
  is preferable to a silent per-object fallback nobody can see, consistent
  with the choice plan 41 makes for the same tradeoff on WorldTAB's Square
  live-hazard fields. This has never been observed to actually diverge in
  practice: every field this plan touches (`collisionRadiusMultiplier`,
  `OBAKMCCDBJA`/`KKENJFFDMPO`/`GGBCADDBAPN`, `MPGOFIHIDML`/`destroyEntity`)
  already has a working registry row today.
- **ProjNoclip self-healing cadence change (improvement, not a regression):**
  today `s_npmOff`/`s_eokOff`/`s_ebclOff` are resolved once, the first time
  `Install()` succeeds, and then frozen for the rest of the process
  (`Install()` short-circuits on `s_installed` before ever re-running the
  resolution block). After migration, the hook body reads
  `RuntimeOffsets::Hbeak_NoclipGuard`/`KJ_TileRef`/`Sq_Layer` directly, and
  those externs are refreshed every frame by `RuntimeOffsets::EnsureAll()`
  (`platform/hooks/DirectX.cpp:178`, which runs before
  `FeatureRuntime::ApplyOverrides()` at line 188 and `AutoAim::Tick()` at
  line 193 — i.e. before `ProjNoclip::Install()` can be reached on any given
  frame). The hook therefore keeps self-healing for the lifetime of the
  process instead of freezing at first-successful-install. This cannot make
  the hook read a WORSE offset than before (both paths start from the same
  fallback/metadata resolution); it can only make it recover from a
  hypothetical mid-session relocation that the old code could not.
- **TestTAB teleport-write atomicity:** the original wraps all four field
  writes in ONE shared `__try`/`__except` — if a fault occurs on any one of
  the four writes, none of the later writes in that block execute (though
  earlier ones in the same block already did; SEH does not roll back
  completed writes either way). `Mem::TryWrite` performs its own
  `AddrOk(base)` check and its own `__try`/`__except` per call, so after
  migration each of the four writes independently succeeds or fails instead
  of sharing one exception scope. All four writes target the same
  `localPlayer` base pointer at small (<0x100) offset deltas, so in every
  realistic scenario either all four addresses are in the same committed
  page range and all four succeed, or the base pointer itself is bad and
  `Mem::TryWrite`'s `AddrOk` check fails all four identically before any
  write happens — the "some writes land, others don't" case the shared
  `__try` was guarding against is not reachable in practice for this
  specific 4-field, sub-page-sized write. This is the same reasoning plan 37
  and 39 already applied to other multi-field reads/writes in this file.

## Steps

### Step 1 — ProjNoclip: delete the private resolution block and statics
File: `internal/src/features/combat/autoaim/ProjNoclip.cpp`

Delete:
- The static offset variables and their comment block (lines 40-44):
  ```cpp
  // ── Runtime field offsets (resolved once at Install time) ────────────────────
  // No ACTK shift: HBEAKBIHANL and BGAIOPJMHLO are both non-LKHPPBEGNOM classes.
  static uint32_t s_npmOff  = 0;   // HBEAKBIHANL.NPMECLDKGEF (bool)
  static uint32_t s_eokOff  = 0;   // KJMONHENJEN.EOKJOGFPLOA (BGAIOPJMHLO*)
  static uint32_t s_ebclOff = 0;   // BGAIOPJMHLO.EBCLNFDKKEH (int32_t/enum)
  ```
- The fallback constants and their comment block (lines 46-55):
  ```cpp
  // Fallback offsets derived from il2cpp-types.h struct layout.
  // KJMONHENJEN layout (known from resolved PosX=0x3C, ObjType=0x30):
  //   ptr×4 [0x10..0x28], int32×2 [0x30,0x34], bool×3 [0x38,0x39,0x3A], pad [0x3B],
  //   float PosX [0x3C], float PosY [0x40], float [0x44], bool [0x48], int32 [0x4C],
  //   float [0x50], pad [0x54..0x57], BGAIOPJMHLO* [0x58]
  static constexpr uint32_t kFallbackEokOff  = 0x58;
  // BGAIOPJMHLO layout (known from TileX=0x38, TileY=0x3C, TileType=0x40):
  //   uint16 [0x40], bool×2 [0x42,0x43], EBCLNFDKKEH int32 [0x44]
  static constexpr uint32_t kFallbackEbclOff = 0x44;
  // HBEAKBIHANL.NPMECLDKGEF — resolved only via IL2CPP; no reliable static fallback.
  ```
(Keep the file-level mechanism comment above these, lines 13-36 — it
documents the hook design, not the offsets.)

**Verify:** `bash internal/tools/wsl-build.sh Debug` — expected to fail
(the hook bodies and `Install()` still reference the deleted names). That is
fine; fix in steps 2-3 before the next build. If your workflow requires a
green build after every step, do steps 1-3 together before the first build.

### Step 2 — ProjNoclip: migrate the hook bodies
File: `internal/src/features/combat/autoaim/ProjNoclip.cpp`

In `IACODGNOFMH_hook` (currently lines 75-105):
```cpp
// Before
if (s_npmOff != 0 && Mem::AddrOk(thisPtr))
{
    __try {
        const bool npm = *reinterpret_cast<bool*>(
            reinterpret_cast<uint8_t*>(thisPtr) + s_npmOff);
        if (npm)
        {
            void* tile = *reinterpret_cast<void**>(
                reinterpret_cast<uint8_t*>(thisPtr) + s_eokOff);
            if (Mem::AddrOk(tile))
            {
                int32_t* layerPtr = reinterpret_cast<int32_t*>(
                    reinterpret_cast<uint8_t*>(tile) + s_ebclOff);
                s_savedLayer    = *layerPtr;
                s_savedTile     = tile;
                *layerPtr       = 37;
                s_noclipApplied = true;
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}
// After
if (RuntimeOffsets::Hbeak_NoclipGuard != 0 && Mem::AddrOk(thisPtr))
{
    __try {
        const bool npm = *reinterpret_cast<bool*>(
            reinterpret_cast<uint8_t*>(thisPtr) + RuntimeOffsets::Hbeak_NoclipGuard);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
        if (npm)
        {
            void* tile = *reinterpret_cast<void**>(
                reinterpret_cast<uint8_t*>(thisPtr) + RuntimeOffsets::KJ_TileRef);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
            if (Mem::AddrOk(tile))
            {
                int32_t* layerPtr = reinterpret_cast<int32_t*>(
                    reinterpret_cast<uint8_t*>(tile) + RuntimeOffsets::Sq_Layer);  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
                s_savedLayer    = *layerPtr;
                s_savedTile     = tile;
                *layerPtr       = 37;
                s_noclipApplied = true;
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}
```
In `GJFKGLJEGKO_hook` (currently lines 109-127), the restore write:
```cpp
// Before
*reinterpret_cast<int32_t*>(
    reinterpret_cast<uint8_t*>(s_savedTile) + s_ebclOff) = s_savedLayer;
// After
*reinterpret_cast<int32_t*>(
    reinterpret_cast<uint8_t*>(s_savedTile) + RuntimeOffsets::Sq_Layer) = s_savedLayer;  // raw-access-ok: hot-loop __try field sweep; shared-SEH save/restore must abort atomically
```
`RuntimeOffsets.h` is already included (`ProjNoclip.cpp:4`).

**Verify:** `bash internal/tools/wsl-build.sh Debug` — still expected to
fail until step 3 removes the dangling references inside `Install()`.

### Step 3 — ProjNoclip: migrate `Install()`
File: `internal/src/features/combat/autoaim/ProjNoclip.cpp`

Delete the class-seed line (line 141):
```cpp
Il2CppClass* hbeakKlass = Resolver::GetClass("", "HBEAKBIHANL");
if (!hbeakKlass) return;
```
Delete the whole three-block resolution (lines 152-177):
```cpp
// Resolve field offsets via IL2CPP (no ACTK shift for these classes).
{
    // HBEAKBIHANL.NPMECLDKGEF (bool) — walk hierarchy to find it.
    FieldInfo* fi = nullptr;
    for (Il2CppClass* k = hbeakKlass; k && !fi; k = il2cpp_class_get_parent(k))
        fi = il2cpp_class_get_field_from_name(k, "NPMECLDKGEF");
    if (fi) s_npmOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
}
{
    // KJMONHENJEN.EOKJOGFPLOA (BGAIOPJMHLO*).
    Il2CppClass* kjmonKlass = Resolver::GetClass("", "KJMONHENJEN");
    if (kjmonKlass) {
        FieldInfo* fi = il2cpp_class_get_field_from_name(kjmonKlass, "EOKJOGFPLOA");
        if (fi) s_eokOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
    }
    if (s_eokOff == 0) s_eokOff = kFallbackEokOff;
}
{
    // BGAIOPJMHLO.EBCLNFDKKEH (int32/enum).
    Il2CppClass* bgaKlass = Resolver::GetClass("", "BGAIOPJMHLO");
    if (bgaKlass) {
        FieldInfo* fi = il2cpp_class_get_field_from_name(bgaKlass, "EBCLNFDKKEH");
        if (fi) s_ebclOff = static_cast<uint32_t>(il2cpp_field_get_offset(fi));
    }
    if (s_ebclOff == 0) s_ebclOff = kFallbackEbclOff;
}
```
Replace the gate that followed it (line 179-180):
```cpp
// Before
// NPMECLDKGEF must resolve; without it we can't guard the hook safely.
if (s_npmOff == 0) return;
// After
// NPMECLDKGEF must resolve; without it we can't guard the hook safely.
if (RuntimeOffsets::Hbeak_NoclipGuard == 0) return;
```
Remove the now-unused include (`ProjNoclip.cpp:3`):
```cpp
#include "Il2CppResolver.h"
```
`Resolver::` has no remaining references in this file after this step
(verify with `grep -n 'Resolver::' internal/src/features/combat/autoaim/ProjNoclip.cpp`
before deleting the include — it must print nothing).

**Verify:** `bash internal/tools/wsl-build.sh Debug` (0 warnings / 0 errors)
and `bash internal/tools/check-raw-access.sh` (exit 0).

### Step 4 — PlayerCollider: delete the field-resolution mini-framework, keep the type-check gates
File: `internal/src/features/movement/collider/PlayerCollider.cpp`

Two of the functions being removed do double duty as BOTH an offset
re-resolver AND a runtime type-check gate (confirm the object is really an
`ObjectProperties` / a real `FKALGHJIADI`) before the caller trusts the
pointer. Only the offset-re-resolution half is being deleted — the type
checks must be preserved exactly, just without re-deriving an offset nobody
needs anymore.

Delete `FindFieldOnHierarchy` (lines 36-43) and `ResolveFieldOffset` (lines
70-87) — after this step and the next, they have zero callers.

Delete `ReadPointerRef` (lines 89-100) and `ReadObjectPropertiesRef` (lines
102-105) — functional duplicates of `Mem::ReadPtr`. Replace their four call
sites:
```cpp
// Before (ResolveViewDestroyEntity, lines 143 and 150)
void* viewHandler = ReadPointerRef(localPlayer, viewHandlerOffset);
...
return ReadPointerRef(viewHandler, destroyEntityOffset);
// Before (CollectPlayerObjectProperties, line 232)
void* properties = ReadObjectPropertiesRef(entity, offset);
// Before (ApplyEntityMultiplierTargets, line 269 — dead code, zero callers
// anywhere in the tree today, but still compiled; migrate it too so
// ReadPointerRef/ReadObjectPropertiesRef have no remaining call sites)
void* properties = ReadObjectPropertiesRef(entityPtr, targets[i].offset);
```
```cpp
// After
void* viewHandler = Mem::ReadPtr(localPlayer, RuntimeOffsets::KJ_ViewHandler);
...
return Mem::ReadPtr(viewHandler, RuntimeOffsets::VH_DestroyEntity);
// After
void* properties = Mem::ReadPtr(entity, offset);
// After
void* properties = Mem::ReadPtr(entityPtr, targets[i].offset);
```
Replace `ResolveViewDestroyEntity` (lines 135-151) in full — it no longer
needs to resolve anything, just chase two already-registry offsets:
```cpp
// Before
void* ResolveViewDestroyEntity(void* localPlayer)
{
    Il2CppClass* localClass = nullptr;
    uint32_t viewHandlerOffset = RuntimeOffsets::KJ_ViewHandler;
    bool fromMetadata = false;
    if (TryGetObjectClass(localPlayer, localClass))
        ResolveFieldOffset(localClass, "MPGOFIHIDML", RuntimeOffsets::KJ_ViewHandler, viewHandlerOffset, fromMetadata);

    void* viewHandler = ReadPointerRef(localPlayer, viewHandlerOffset);
    Il2CppClass* viewClass = nullptr;
    uint32_t destroyEntityOffset = RuntimeOffsets::VH_DestroyEntity;
    fromMetadata = false;
    if (TryGetObjectClass(viewHandler, viewClass))
        ResolveFieldOffset(viewClass, "destroyEntity", RuntimeOffsets::VH_DestroyEntity, destroyEntityOffset, fromMetadata);

    return ReadPointerRef(viewHandler, destroyEntityOffset);
}
// After
void* ResolveViewDestroyEntity(void* localPlayer)
{
    void* viewHandler = Mem::ReadPtr(localPlayer, RuntimeOffsets::KJ_ViewHandler);
    return Mem::ReadPtr(viewHandler, RuntimeOffsets::VH_DestroyEntity);
}
```
Replace `ResolveObjectPropertiesOffset` (lines 121-133) — delete it
entirely; its only job was re-deriving an offset the caller already had.
Update its one call site in `CollectPlayerObjectProperties` (line 231):
```cpp
// Before
const uint32_t offset = ResolveObjectPropertiesOffset(entityClass, targets[i]);
// After
const uint32_t offset = targets[i].offset;
```
Replace `ResolveCollisionMultiplierOffset` (lines 107-119) with a
type-check-only helper (drop the offset re-resolution; keep the
`ObjectProperties`-hierarchy validation, which is what actually gates
whether `CollectPlayerObjectProperties` accepts this pointer):
```cpp
// Before
bool ResolveCollisionMultiplierOffset(void* properties)
{
    Il2CppClass* propertiesClass = nullptr;
    if (!TryGetObjectClass(properties, propertiesClass) || !ClassHierarchyHas(propertiesClass, "ObjectProperties"))
        return false;

    uint32_t offset = kOffCollisionMultiplierFallback;
    bool fromMetadata = false;
    ResolveFieldOffset(propertiesClass, "collisionRadiusMultiplier", kOffCollisionMultiplierFallback, offset, fromMetadata);
    (void)fromMetadata;
    g_collisionMultiplierOffset = offset;
    return true;
}
// After
bool IsObjectPropertiesInstance(void* properties)
{
    Il2CppClass* propertiesClass = nullptr;
    return TryGetObjectClass(properties, propertiesClass) &&
           ClassHierarchyHas(propertiesClass, "ObjectProperties");
}
```
Update its one call site in `CollectPlayerObjectProperties` (line 233):
```cpp
// Before
if (!ResolveCollisionMultiplierOffset(properties)) continue;
// After
if (!IsObjectPropertiesInstance(properties)) continue;
```
Do NOT touch `TryGetObjectClass` or `ClassHierarchyHas` themselves — both
still have live callers after this step (`IsObjectPropertiesInstance` above,
and the existing `FKALGHJIADI` check in `CollectPlayerObjectProperties`,
line 225) and neither duplicates a `RuntimeOffsets`/`Mem::` concern; they
are a generic "get this object's IL2CPP class" / "does this class chain
contain X" pair with no offset involved.

**Verify:** `bash internal/tools/wsl-build.sh Debug` — expected to fail
until step 5 removes the last references to `kOffCollisionMultiplierFallback`
/ `g_collisionMultiplierOffset`. If your workflow requires a green build
every step, fold step 5 in here too.

### Step 5 — PlayerCollider: `ReadCollisionMultiplier`/`WriteCollisionMultiplier` → `Mem::TryRead`/`Mem::TryWrite`
File: `internal/src/features/movement/collider/PlayerCollider.cpp`

Delete `kOffCollisionMultiplierFallback` (line 12) and
`g_collisionMultiplierOffset` (line 30).

Replace the two functions (lines 153-175):
```cpp
// Before
bool ReadCollisionMultiplier(void* properties, float& out)
{
    if (!properties) return false;
    bool ok = false;
    __try {
        out = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) + g_collisionMultiplierOffset);
        ok = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { ok = false; }
    return ok;
}

bool WriteCollisionMultiplier(void* properties, float value)
{
    if (!properties) return false;
    bool ok = false;
    __try {
        *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) + g_collisionMultiplierOffset) = value;
        ok = true;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { ok = false; }
    return ok;
}
// After
bool ReadCollisionMultiplier(void* properties, float& out)
{
    return Mem::TryRead(properties, RuntimeOffsets::OP_CollRadiusMult, out);
}

bool WriteCollisionMultiplier(void* properties, float value)
{
    return Mem::TryWrite(properties, RuntimeOffsets::OP_CollRadiusMult, value);
}
```
(`Mem::TryRead`/`Mem::TryWrite` already `AddrOk`-check `properties`
internally, matching the old `if (!properties) return false;` guard.)

Leave `ApplyEntityMultiplierTargets`'s own raw read at line 283
(`*reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(properties) +
collisionMultiplierOffset)`) untouched — see Out of scope.

**Verify:** `bash internal/tools/wsl-build.sh Debug` (0 warnings / 0 errors)
and `bash internal/tools/check-raw-access.sh` (exit 0).

### Step 6 — TestTAB: collision-multiplier constants → registry names
File: `internal/src/gui/tabs/TestTAB.cpp`

Delete the three constants (lines 219-221):
```cpp
static constexpr uint32_t kOffObjProps1      = 0x18;   // KJMONHENJEN.OBAKMCCDBJA
static constexpr uint32_t kOffObjProps2      = 0x1C8;  // LKHPPBEGNOM.KKENJFFDMPO
static constexpr uint32_t kOffCollisionMult  = 0x780;  // ObjectProperties.collisionRadiusMultiplier
```
In `ReadCollisionMult` (currently lines 233-246):
```cpp
// Before
void* op = *reinterpret_cast<void**>(e + kOffObjProps1);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
if (!op) return 1.0f;
if (!Mem::AddrOk(op)) return 1.0f;
float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + kOffCollisionMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
// After
void* op = *reinterpret_cast<void**>(e + RuntimeOffsets::ObjProps);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
if (!op) return 1.0f;
if (!Mem::AddrOk(op)) return 1.0f;
float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + RuntimeOffsets::OP_CollRadiusMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
```
In `ReadCollisionMultAlt` (currently lines 248-261), same substitution but
with `kOffObjProps2` → `RuntimeOffsets::MoObjectProps`:
```cpp
// Before
void* op = *reinterpret_cast<void**>(e + kOffObjProps2);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
...
float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + kOffCollisionMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
// After
void* op = *reinterpret_cast<void**>(e + RuntimeOffsets::MoObjectProps);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
...
float mult = *reinterpret_cast<float*>(reinterpret_cast<uint8_t*>(op) + RuntimeOffsets::OP_CollRadiusMult);  // raw-access-ok: hot-loop __try field sweep, per-field fallback would defeat the shared-SEH abort (plan 16)
```
The existing `raw-access-ok` markers already sit on both lines in both
functions — keep them verbatim; they are what keeps guardrail check 2 green
once these lines name `RuntimeOffsets::` directly. `RuntimeOffsets.h` is
already included (`TestTAB.cpp:33`).

**Note on line drift:** these lines currently sit at TestTAB.cpp:233-261
(function names `ReadCollisionMult` / `ReadCollisionMultAlt`, immediately
below the `kOffObjProps1`/`kOffObjProps2`/`kOffCollisionMult` declarations
and a `// Legacy game hitbox display helpers` section comment). If dodge
plans 33/35 have already merged by the time you execute this step, locate
this block by function name and the quoted code above, not by line number.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 7 — TestTAB: Ctrl+Click teleport → `Mem::TryWrite`
File: `internal/src/gui/tabs/TestTAB.cpp`

Locate the Ctrl+Click instant-teleport block — search for the comment
`Ctrl+Click instant teleport` and the local variables `tpX`/`tpY` inside the
block guarded by `g_ctrlClickTeleport && localPlayer && g_w2sValid`
(currently TestTAB.cpp:780-804; the write itself is at ~796-801). Replace:
```cpp
// Before
if (okLand) {
    __try {
        *(float*)((uint8_t*)localPlayer + 0x3C) =  tpX;
        *(float*)((uint8_t*)localPlayer + 0x40) =  tpY;
        *(float*)((uint8_t*)localPlayer + 0x68) =  tpX;
        *(float*)((uint8_t*)localPlayer + 0x6C) = -tpY;
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}
// After
if (okLand) {
    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosX, tpX);
    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosY, tpY);
    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos, tpX);
    Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos + 4u, -tpY);
}
```
(`RuntimeOffsets::KJ_Float3Pos` is the base offset of a 3-float
`{x,y,z}` struct — `+ 4u` reaches the `y` component, matching the original
`0x68`/`0x6C` pair exactly. See the Divergence warnings above for the
atomicity note — this is an accepted, extremely-low-risk behavior change,
not an oversight.)

**Note on line drift:** dodge plans 33/35 edit DodgeMode enum/transition
code in this same file, anchored at the function `ApplyDodgeModeWithEnter`
(currently TestTAB.cpp:141-211) and at `TestTAB::SetDodgeMode` (currently
around TestTAB.cpp:1410-1420) — different regions from this step's edits,
but if dodge plan 33 is still landing while you work, re-locate this step's
target by the `Ctrl+Click instant teleport` comment and the `tpX`/`tpY`
variable names, not by the line numbers above.

**Verify:** `bash internal/tools/wsl-build.sh Debug` (0 warnings / 0 errors)
and `bash internal/tools/check-raw-access.sh` (exit 0).

## Verification
```bash
bash internal/tools/wsl-build.sh Debug            # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh            # exit 0

# ProjNoclip's private resolution is gone (expect ZERO hits):
grep -n 's_npmOff\|s_eokOff\|s_ebclOff\|kFallbackEokOff\|kFallbackEbclOff' internal/src/features/combat/autoaim/ProjNoclip.cpp

# PlayerCollider's mini-framework is gone (expect ZERO hits):
grep -n 'FindFieldOnHierarchy\|ResolveFieldOffset\|ReadPointerRef\|ReadObjectPropertiesRef\|ResolveObjectPropertiesOffset\|g_collisionMultiplierOffset\|kOffCollisionMultiplierFallback' internal/src/features/movement/collider/PlayerCollider.cpp

# ResolveCollisionMultiplierOffset renamed/narrowed to a pure type check (expect ZERO hits for the old name, exactly 1 for the new one):
grep -c 'ResolveCollisionMultiplierOffset' internal/src/features/movement/collider/PlayerCollider.cpp   # expect 0
grep -c 'IsObjectPropertiesInstance' internal/src/features/movement/collider/PlayerCollider.cpp          # expect >= 2 (def + call site)

# TestTAB's duplicated constants and raw teleport casts are gone (expect ZERO hits):
grep -n 'kOffObjProps1\|kOffObjProps2\|kOffCollisionMult\b' internal/src/gui/tabs/TestTAB.cpp
grep -nE '\*\(float\*\)\(\(uint8_t\*\)localPlayer' internal/src/gui/tabs/TestTAB.cpp
```

## Out of scope
- `ApplyEntityMultiplier` / `ApplyEntityMultiplierTargets`
  (`PlayerCollider.cpp:241-290`, declared in `PlayerCollider.h:26-38`) — a
  public API with **zero callers anywhere in the tree** (verified: `grep -rn
  'ApplyEntityMultiplier' internal/src` only matches the declaration and
  definition). They take their collision-multiplier offset as a
  caller-supplied parameter rather than reading any private or global
  offset, so there is nothing to migrate — leave them, including the raw
  `reinterpret_cast` at line 283, exactly as they are.
- The `ObjectPropertiesTarget::label` field (`PlayerCollider.h:12`) —
  becomes write-only once `ResolveObjectPropertiesOffset`'s `strcmp`
  dispatch is deleted in step 4. Do not remove the field or restructure the
  struct; that is a data-shape change outside "offset migration," not an
  offset duplication.
- `TryGetObjectClass` / `ClassHierarchyHas` (`PlayerCollider.cpp`) — generic
  IL2CPP class/hierarchy helpers with no offset concern; both keep live
  callers after this plan. Do not touch them.
- `RuntimeOffsets::{h,cpp}` (plan 37's file, already merged and closed).
- `gui/tabs/CameraTAB.cpp`, `gui/tabs/PlayerTAB.cpp` (plan 42),
  `gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp` (plan 41).
- Any dodge-mode enum, transition, or `Detour_AppEngineUpdate` logic in
  `TestTAB.cpp` — that belongs to the concurrent dodge program (plans
  30-35), even where it lives in the same file this plan edits.
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
- Any change to ProjNoclip's, PlayerCollider's, or TestTAB's observable
  behavior, timing, or UI layout beyond the accepted atomicity divergence
  noted above.
