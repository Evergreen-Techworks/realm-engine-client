# 42 — PlayerTAB + CameraTAB Migration

## Goal
`gui/tabs/PlayerTAB.cpp` stops carrying a private field-offset
resolution mini-framework (duplicating `FindFieldOnHierarchy` and resolving
fields plan 37 already put in the registry) and a private UTF-8 string
reader that duplicates `Il2CppC::ReadStringUtf8`. `gui/tabs/CameraTAB.cpp`
stops calling `il2cpp_class_get_method_from_name` directly (11 call sites —
the guardrail's method-resolution check only scopes `features/`, so these
have evaded it since it was added). Both route through the sanctioned homes:
`RuntimeOffsets`, `Il2CppC::ReadStringUtf8`, `Mem::`, and
`Il2CppHook::ResolveMethodCached`. Behavior is preserved (divergences noted
below).

## Dependencies
- **Plan 37 must be merged first** (uses `RuntimeOffsets::EM_EquipSlots`,
  `Item_ObjProps`, `Item_ObjType`, `Player_CondRaw`).
- **Plan 38 must be merged first** (uses `Il2CppC::ReadStringUtf8`).
- Parallel-safe with plans 39, 40, 41 (disjoint files).

Files touched (no other plan in this wave touches them):
- `internal/src/gui/tabs/PlayerTAB.cpp`
- `internal/src/gui/tabs/CameraTAB.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
Do NOT touch `internal/src/core/runtime/RuntimeOffsets.{h,cpp}` or
`internal/src/platform/hooks/Il2CppHook.{h,cpp}` (plans 37/38's files —
already merged and closed by the time this plan runs).
Do NOT touch `internal/src/gui/tabs/WorldTAB.cpp`, `internal/src/gui/CamState.cpp`
(plan 41's files) or `internal/src/gui/tabs/TestTAB.cpp` (plan 40's file).

## Current state

### PlayerTAB.cpp

#### 1. Private field-offset mini-framework for EquipmentManager/ItemSlot
`PlayerTAB.cpp:19-38`:
```cpp
static constexpr uint32_t kFB_EM_SLOTS  = 0x48;
static constexpr uint32_t kFB_ITEM_OP   = 0x58;
static constexpr uint32_t kFB_ITEM_TYPE = 0x60;

static constexpr uint32_t kCondRawOffset = 0x440;

static uint32_t s_emEquipSlots   = kFB_EM_SLOTS;
static uint32_t s_itemObjProps   = kFB_ITEM_OP;
static uint32_t s_itemObjType    = kFB_ITEM_TYPE;
static bool     s_equipResolved  = false;
```
`FindFieldOnHierarchy` (`PlayerTAB.cpp:40-48`) is a verbatim duplicate of the
same-named helper in `PlayerCollider.cpp:36-43` (which plan 40 deletes) and
of the class-walk logic `RuntimeOffsets.cpp:223-230` already does inside the
registry:
```cpp
static FieldInfo* FindFieldOnHierarchy(Il2CppClass* klass, const char* fieldName)
{
    for (Il2CppClass* k = klass; k; k = il2cpp_class_get_parent(k)) {
        FieldInfo* f = il2cpp_class_get_field_from_name(k, fieldName);
        if (f)
            return f;
    }
    return nullptr;
}
```
`ResolveEquipmentManagerClass`/`ResolveItemSlotClass` (`PlayerTAB.cpp:50-64`)
and `EnsureEquipmentOffsets` (`PlayerTAB.cpp:68-94`) resolve
`EquipmentManager.equipmentSlots`, `ItemSlot.HLJFBHLMANJ`,
`ItemSlot.INAAIAHOEFE` into `s_emEquipSlots`/`s_itemObjProps`/
`s_itemObjType`:
```cpp
static void EnsureEquipmentOffsets()
{
    if (s_equipResolved)
        return;

    Il2CppClass* em = ResolveEquipmentManagerClass();
    if (em) {
        FieldInfo* es = FindFieldOnHierarchy(em, "equipmentSlots");
        if (es)
            s_emEquipSlots = static_cast<uint32_t>(il2cpp_field_get_offset(es));
    }

    Il2CppClass* item = ResolveItemSlotClass();
    if (item) {
        FieldInfo* fOp = FindFieldOnHierarchy(item, "HLJFBHLMANJ");
        if (fOp)
            s_itemObjProps = static_cast<uint32_t>(il2cpp_field_get_offset(fOp));
        FieldInfo* fTid = FindFieldOnHierarchy(item, "INAAIAHOEFE");
        if (fTid)
            s_itemObjType = static_cast<uint32_t>(il2cpp_field_get_offset(fTid));
    }

    if (em || item)
        s_equipResolved = true;
}
```
Called once from `DoRefresh()` at `PlayerTAB.cpp:244`. Plan 37 added these
exact three fields to the registry as `RuntimeOffsets::EM_EquipSlots`
(fallback 0x48), `RuntimeOffsets::Item_ObjProps` (fallback 0x58), and
`RuntimeOffsets::Item_ObjType` (fallback 0x60) — same BeeByte names, same
fallback values, specifically because of this duplication (plan 37 "Current
state" table cites `PlayerTAB.cpp:24-26`). `kCondRawOffset` (0x440, no
BeeByte name — "raw `[this+0x440]` from .lst analysis") became the plan-37
manual constant `RuntimeOffsets::Player_CondRaw`.

`kCondRawOffset`'s one call site is `PlayerTAB.cpp:284`:
```cpp
Mem::TryRead(lp, kCondRawOffset, s.condRaw);
```

#### 2. Raw offset-parameter reads in `ReadEquipmentSlots`
`PlayerTAB.cpp:178-231` takes the (now-to-be-deleted) resolved offsets as
plain `uint32_t` parameters and dereferences with `reinterpret_cast` — this
evades BOTH guardrail check 2 (which requires `RuntimeOffsets::` literally
on the cast line) and check 5 (which only catches reference-bound aliases,
not by-value parameters):
```cpp
static void ReadEquipmentSlots(void* localFk, PlayerSnap& s,
                                uint32_t offSlots, uint32_t offOp, uint32_t offTid)
{
    ...
    const uint32_t offEm = RuntimeOffsets::PlayerEquipMgr;

    const bool ok = Resolver::Protection::safe_call([&]() {
        void* em = *reinterpret_cast<void**>(
            reinterpret_cast<uint8_t*>(localFk) + offEm);
        if (!Mem::AddrOk(em))
            return;

        void* arr = *reinterpret_cast<void**>(
            reinterpret_cast<uint8_t*>(em) + offSlots);
        if (!Mem::AddrOk(arr))
            return;

        const uint32_t lenU = il2cpp_array_length(reinterpret_cast<Il2CppArray*>(arr));
        if (lenU == 0)
            return;

        const int n = (static_cast<int>(lenU) < kEquipSlotCount)
            ? static_cast<int>(lenU)
            : kEquipSlotCount;

        for (int i = 0; i < n; ++i) {
            void* slot = GET_ARRAY_ELEMENT(arr, i);
            if (!Mem::AddrOk(slot))
                continue;

            uint8_t* sp = reinterpret_cast<uint8_t*>(slot);
            void* op = *reinterpret_cast<void**>(sp + offOp);
            int32_t tid = *reinterpret_cast<int32_t*>(sp + offTid);
            ...
        }
    });
    ...
}
```
Called once, `PlayerTAB.cpp:271`:
```cpp
ReadEquipmentSlots(lp, s, s_emEquipSlots, s_itemObjProps, s_itemObjType);
```
This loop runs at most 4 iterations, once per manual/auto-refresh interval
(not a hot per-frame path) — no `raw-access-ok` hot-loop justification
applies here; it should go through `Mem::` like the rest of the file.

#### 3. `ReadManagedString` — local UTF-8 reader duplicating `Il2CppC::ReadStringUtf8`
`PlayerTAB.cpp:157-175`:
```cpp
static bool ReadManagedString(const void* strPtr, char* buf, int bufSize)
{
    if (!Mem::AddrOk(strPtr)) return false;
    int32_t len = 0;
    if (!Mem::TryRead(strPtr, 0x10u, len)) return false;
    if (len <= 0 || len >= bufSize) return false;

    wchar_t wbuf[128] = {};
    bool ok = Resolver::Protection::safe_call([&]() {
        const wchar_t* chars = reinterpret_cast<const wchar_t*>(
            reinterpret_cast<const uint8_t*>(strPtr) + 0x14u);
        int n = (len < 127) ? len : 127;
        memcpy(wbuf, chars, static_cast<size_t>(n) * sizeof(wchar_t));
    });
    if (!ok) return false;
    WideCharToMultiByte(CP_UTF8, 0, wbuf, len, buf, bufSize - 1, nullptr, nullptr);
    return buf[0] != '\0';
}
```
`0x10`/`0x14` hardcode `Il2CppC::kStrLen`/`kStrChars`
(`Il2CppContainers.h:22-23`). This is exactly the pattern plan 38 built
`Il2CppC::ReadStringUtf8` to replace (plan 38's own "Current state" cites
this file: "Copy B: `gui/tabs/PlayerTAB.cpp:158-175`... plan 41 migrated by
plan 42" — note: the overview's plan table lists PlayerTAB under plan 42,
not 41; this plan is that migration). One call site, `PlayerTAB.cpp:266-267`:
```cpp
void* namePtr = nullptr;
if (Mem::TryRead(lp, RuntimeOffsets::PlayerName, namePtr))
    ReadManagedString(namePtr, s.name, sizeof(s.name));
```

### CameraTAB.cpp

#### 4. Eleven direct `il2cpp_class_get_method_from_name` calls
Guardrail check 8 in `internal/tools/check-raw-access.sh` forbids
`il2cpp_class_get_method_from_name` in `features/` only
(`scope_feat=("$root/features" "$root/gui")` is check 8's argument list
in every OTHER check, but check 8 itself is hardcoded to `"$root/features"`
— see `check-raw-access.sh:88-94`). `gui/tabs/CameraTAB.cpp` has 11 call
sites that have therefore never been caught:

| Line | Call | Resolved from |
|---|---|---|
| 115 | `il2cpp_class_get_method_from_name(cmKlass, "SetCameraAngle", 1)` | live `CameraManager` instance's class |
| 117 | `il2cpp_class_get_method_from_name(cmKlass, "ChangeOffsetMode", 0)` | same |
| 119 | `il2cpp_class_get_method_from_name(cmKlass, "ANBDPNHJBHG", 0)` | same |
| 121 | `il2cpp_class_get_method_from_name(cmKlass, "get_IOABMGFJLLP", 0)` | same |
| 123 | `il2cpp_class_get_method_from_name(cmKlass, "IOABMGFJLLP", 0)` | same |
| 134 | `il2cpp_class_get_method_from_name(xk, "get_eulerAngles", 0)` | live `Transform` instance's class |
| 136 | `il2cpp_class_get_method_from_name(xk, "get_position", 0)` | same |
| 148 | `il2cpp_class_get_method_from_name(ck, "get_pixelRect", 0)` | live `UnityEngine.Camera` instance's class |
| 176 | `il2cpp_class_get_method_from_name(screen, "get_width", 0)` | `Resolver::FindClass("UnityEngine", "Screen")` |
| 177 | `il2cpp_class_get_method_from_name(screen, "get_height", 0)` | same |
| 709 | `il2cpp_class_get_method_from_name(klass, "WorldToScreenPoint", 1)` | live `Camera` instance's class (`camObj`) |

Full context for the `cmKlass` group, `CameraTAB.cpp:106-156`
(`EnsureCameraMethods`); the `xk`/`ck` group, `CameraTAB.cpp:126-150` (also
inside `EnsureCameraMethods`); the `screen` pair,
`CameraTAB.cpp:171-182` (`GetUnityScreenSize`); the last one,
`CameraTAB.cpp:696-711` (`CameraTAB::CalibrateScreenBasis`).

#### 5. Field-disambiguation loop — KEEP, do not migrate (see Target design)
`CameraTAB.cpp:274-310` resolves the `UnityEngine.Camera` field on
`CameraManager` by iterating every field and matching on TYPE, not name,
because (per the comment at `CameraTAB.cpp:278-281`) the obfuscator reused
one field name across two differently-typed fields on the same class. This
uses `il2cpp_class_get_fields` (an iterator) and `il2cpp_field_get_offset`
— NOT `il2cpp_class_get_field_from_name` — so it is not part of the
duplication being removed here. See Target design for why it stays.

## Target design

No new abstractions — every replacement below uses an API that already
exists (post plan-37/38 merge):

- `RuntimeOffsets::EM_EquipSlots`, `Item_ObjProps`, `Item_ObjType`,
  `Player_CondRaw` — `core/runtime/RuntimeOffsets.h`.
- `Il2CppC::ReadStringUtf8(void* strPtr, char* out, int outCap) -> int` —
  `core/il2cpp/Il2CppContainers.h`.
- `Mem::TryRead<T>`, `Mem::ReadPtr`, `Mem::ReadOr<T>`, `Mem::AddrOk` —
  `core/runtime/MemRead.h`.
- `Il2CppHook::ResolveMethodCached(className, methodName, argCount, loose=true, namespaze="") -> const MethodInfo*` —
  `platform/hooks/Il2CppHook.h`.

### Why CameraTAB's method lookups can move from live-instance resolution to name-based `ResolveMethodCached`
Every one of the 11 methods lives on a Unity built-in engine type
(`UnityEngine.Transform`, `UnityEngine.Camera`, `UnityEngine.Screen`) or on
`CameraManager` (the game's own singleton camera-manager class, already
resolved by short name elsewhere in this same file via
`Resolver::FindClassLoose("CameraManager")` at `CameraTAB.cpp:226`). Unity's
built-in `Transform` and `Camera` component types are sealed native-backed
wrapper classes that the game code does not subclass — there is exactly one
`Il2CppClass*` for `"Transform"` and one for `"Camera"` in the whole IL2CPP
metadata, so `il2cpp_object_get_class(liveInstance)` and
`Resolver::FindClassLoose("Transform")` / `Resolver::FindClassLoose("Camera")`
resolve to the identical class pointer. Routing through
`Il2CppHook::ResolveMethodCached` by class name is therefore behavior
identical to the current per-instance `il2cpp_object_get_class(...)` lookup,
while gaining the shared cache and the one sanctioned home. This is NOT true
in general (a method resolved off an arbitrary live object could be an
overridden virtual on a subclass) — it is true here specifically because
these are non-subclassable Unity/engine singleton-shaped types, same
reasoning the codebase already relies on for `CameraManager`.

### Divergence warnings
- **`ReadManagedString` reject-vs-truncate.** The local version rejects
  (returns `false`, `s.name` stays `""`, later defaulted to `"<?>"` by the
  caller) any name with `len >= bufSize` (64). The canonical
  `Il2CppC::ReadStringUtf8` truncates to `outCap - 1` instead (per plan 38's
  target design, rejects only `len <= 0 || len > 4096`). Player display
  names in this game are short (well under 64 chars) in every normal case;
  this only changes behavior for an implausibly long name, where the new
  behavior (show a truncated name) is strictly more useful than the old
  (show `"<?>"`). Same "adopt canonical truncate semantics" choice as plan
  41's WorldTAB string-reader migration — consistent across the wave.
- **Field-disambiguation loop is INTENTIONALLY not migrated.** Do not fold
  `CameraTAB.cpp:274-310` into a plain `RuntimeOffsets::CM_UnityCam` read.
  The loop exists because a simple by-name field lookup was historically
  ambiguous for this specific field (obfuscator name collision, see item 5
  above) — `RuntimeOffsets::CM_UnityCam` itself is already used as this
  loop's OWN fallback value (`CameraTAB.cpp:282`:
  `uint32_t camFieldOff = RuntimeOffsets::CM_UnityCam; // hardcoded fallback`),
  so the registry is already wired in as the safety net. Whether the
  registry's plain by-name resolution (`RuntimeOffsets.cpp:331`, keyed on
  BeeByte name `KNAIAEFDCLM`) is itself immune to the same collision that
  motivated this loop is an open question that requires live-game
  verification this plan does not have — same category of question as the
  overview's `NFJGJKLPLBA` conflict. Leave the loop exactly as it is.

## Steps

### Step 1 — Delete the EquipmentManager/ItemSlot offset mini-framework
File: `internal/src/gui/tabs/PlayerTAB.cpp`

Delete lines 19-38 (`kFB_EM_SLOTS`, `kFB_ITEM_OP`, `kFB_ITEM_TYPE`,
`kCondRawOffset`, and the section comment; `s_emEquipSlots`,
`s_itemObjProps`, `s_itemObjType`, `s_equipResolved`). Delete
`FindFieldOnHierarchy` (lines 40-48), `ResolveEquipmentManagerClass` /
`ResolveItemSlotClass` (lines 50-64), and `EnsureEquipmentOffsets` (lines
66-94, including its header comment).

**Verify:** `bash internal/tools/wsl-build.sh Debug` (expected to fail here
— call sites still reference the deleted names; that's fine, fix in the
next two steps before verifying again). If your workflow requires a green
build after every step, do steps 1-3 together before the first build.

### Step 2 — Rewrite `ReadEquipmentSlots` to use `Mem::` + `RuntimeOffsets::`
File: `internal/src/gui/tabs/PlayerTAB.cpp`

Replace the function (lines 178-231) with:
```cpp
// EquipmentManager.equipmentSlots[i] → ItemSlot HLJFBHLMANJ (ObjectProperties*), INAAIAHOEFE (type id).
static void ReadEquipmentSlots(void* localFk, PlayerSnap& s)
{
    for (int i = 0; i < kEquipSlotCount; ++i)
        s.equipment[i] = {};

    if (!localFk || !Mem::AddrOk(localFk))
        return;

    const bool ok = Resolver::Protection::safe_call([&]() {
        void* em = Mem::ReadPtr(localFk, RuntimeOffsets::PlayerEquipMgr);
        if (!Mem::AddrOk(em))
            return;

        void* arr = Mem::ReadPtr(em, RuntimeOffsets::EM_EquipSlots);
        if (!Mem::AddrOk(arr))
            return;

        const uint32_t lenU = il2cpp_array_length(reinterpret_cast<Il2CppArray*>(arr));
        if (lenU == 0)
            return;

        const int n = (static_cast<int>(lenU) < kEquipSlotCount)
            ? static_cast<int>(lenU)
            : kEquipSlotCount;

        for (int i = 0; i < n; ++i) {
            void* slot = GET_ARRAY_ELEMENT(arr, i);
            if (!Mem::AddrOk(slot))
                continue;

            void* op = Mem::ReadPtr(slot, RuntimeOffsets::Item_ObjProps);
            int32_t tid = Mem::ReadOr<int32_t>(slot, RuntimeOffsets::Item_ObjType, 0);

            EquipSlotSnap& es = s.equipment[i];
            es.readable = true;
            const bool hasOp = Mem::AddrOk(op);
            if (!hasOp && tid == 0)
                es.empty = true;
            else
                es.objType = tid;
        }
    });

    if (!ok) {
        for (int i = 0; i < kEquipSlotCount; ++i)
            s.equipment[i] = {};
    }
}
```
Update the call site (line 271):
```cpp
// Before
ReadEquipmentSlots(lp, s, s_emEquipSlots, s_itemObjProps, s_itemObjType);
// After
ReadEquipmentSlots(lp, s);
```
And delete the `EnsureEquipmentOffsets();` call in `DoRefresh()` (line 244)
— nothing needs pre-resolving anymore; `RuntimeOffsets::EnsureAll()` already
runs once per frame from `dPresent` (see `platform/hooks/DirectX.cpp:178`)
and keeps `EM_EquipSlots`/`Item_ObjProps`/`Item_ObjType` current.

**Verify:** `bash internal/tools/wsl-build.sh Debug` — still expected to
have unresolved symbols for `kCondRawOffset`/`ReadManagedString` until step
3; if your toolchain requires a green build every step, fold step 3 in here
too.

### Step 3 — `kCondRawOffset` and `ReadManagedString`
File: `internal/src/gui/tabs/PlayerTAB.cpp`

Replace the call site at line 284:
```cpp
// Before
Mem::TryRead(lp, kCondRawOffset, s.condRaw);
// After
Mem::TryRead(lp, RuntimeOffsets::Player_CondRaw, s.condRaw);
```
Delete `ReadManagedString` (lines 157-175, including its header comment).
Replace its one call site (lines 265-267):
```cpp
// Before
void* namePtr = nullptr;
if (Mem::TryRead(lp, RuntimeOffsets::PlayerName, namePtr))
    ReadManagedString(namePtr, s.name, sizeof(s.name));
// After
void* namePtr = nullptr;
if (Mem::TryRead(lp, RuntimeOffsets::PlayerName, namePtr))
    Il2CppC::ReadStringUtf8(namePtr, s.name, sizeof(s.name));
```
Add `#include "core/il2cpp/Il2CppContainers.h"` to the include block
(`PlayerTAB.cpp:1-17`) — not currently included in this file.

**Verify:** `bash internal/tools/wsl-build.sh Debug` (0 warnings / 0 errors)
and `bash internal/tools/check-raw-access.sh` (exit 0).

### Step 4 — CameraManager method group → `Il2CppHook::ResolveMethodCached`
File: `internal/src/gui/tabs/CameraTAB.cpp`

Add `#include "Il2CppHook.h"` to the include block (`CameraTAB.cpp:5-22`) —
matches the bare-name include convention already used for this header
elsewhere in the tree (e.g. `PlayerTAB.cpp:13`).

In `EnsureCameraMethods` (`CameraTAB.cpp:106-156`), replace the `cmKlass`
group (lines 114-124):
```cpp
// Before
if (cmKlass && !s_setCameraAngle)
    s_setCameraAngle = il2cpp_class_get_method_from_name(cmKlass, "SetCameraAngle", 1);
if (cmKlass && !s_changeOffsetMode)
    s_changeOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "ChangeOffsetMode", 0);
if (cmKlass && !s_getOffsetMode) {
    s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "ANBDPNHJBHG",    0);
    if (!s_getOffsetMode)
        s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "get_IOABMGFJLLP", 0);
    if (!s_getOffsetMode)
        s_getOffsetMode = il2cpp_class_get_method_from_name(cmKlass, "IOABMGFJLLP",    0);
}
// After
if (!s_setCameraAngle)
    s_setCameraAngle = Il2CppHook::ResolveMethodCached("CameraManager", "SetCameraAngle", 1);
if (!s_changeOffsetMode)
    s_changeOffsetMode = Il2CppHook::ResolveMethodCached("CameraManager", "ChangeOffsetMode", 0);
if (!s_getOffsetMode) {
    s_getOffsetMode = Il2CppHook::ResolveMethodCached("CameraManager", "ANBDPNHJBHG", 0);
    if (!s_getOffsetMode)
        s_getOffsetMode = Il2CppHook::ResolveMethodCached("CameraManager", "get_IOABMGFJLLP", 0);
    if (!s_getOffsetMode)
        s_getOffsetMode = Il2CppHook::ResolveMethodCached("CameraManager", "IOABMGFJLLP", 0);
}
```
Note the `cmKlass &&` guards are dropped (method resolution by name no
longer depends on having a live `camMgrObj` to pull a class off) but
`cmKlass` itself stays declared and used by the `xk`/`ck` block below — do
not delete its declaration (`CameraTAB.cpp:111`).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 5 — Transform/Camera method group → `Il2CppHook::ResolveMethodCached`
File: `internal/src/gui/tabs/CameraTAB.cpp`

Still inside `EnsureCameraMethods`, replace lines 133-136 and 148:
```cpp
// Before
if (!s_getEulerAngles)
    s_getEulerAngles = il2cpp_class_get_method_from_name(xk, "get_eulerAngles", 0);
if (!s_getPosition)
    s_getPosition = il2cpp_class_get_method_from_name(xk, "get_position", 0);
...
s_getPixelRect = il2cpp_class_get_method_from_name(ck, "get_pixelRect", 0);
// After
if (!s_getEulerAngles)
    s_getEulerAngles = Il2CppHook::ResolveMethodCached("Transform", "get_eulerAngles", 0, true, "UnityEngine");
if (!s_getPosition)
    s_getPosition = Il2CppHook::ResolveMethodCached("Transform", "get_position", 0, true, "UnityEngine");
...
s_getPixelRect = Il2CppHook::ResolveMethodCached("Camera", "get_pixelRect", 0, true, "UnityEngine");
```
Leave the surrounding `xfrm`/`xk` and `unityCam`/`ck` resolution blocks
(the `Mem::TryRead(camMgrObj, RuntimeOffsets::CM_Transform, xfrm)` /
`RuntimeOffsets::CM_UnityCam` reads and the `Mem::AddrOk(...)` guards) in
place unchanged — they still gate WHEN this file first attempts the method
lookup (same timing as before), even though the lookup itself no longer
needs `xk`/`ck`. `xk` and `ck` become unused locals after this edit — if
the compiler warns, remove their declarations
(`Il2CppClass* xk = il2cpp_object_get_class(...)` /
`Il2CppClass* ck = il2cpp_object_get_class(...)`) but KEEP the
`Mem::TryRead`/`Mem::AddrOk` gating around them exactly as before, just
without assigning to the now-unused class pointer.

**Verify:** `bash internal/tools/wsl-build.sh Debug` — must report 0
warnings; if `xk`/`ck` produce an unused-variable warning, remove those two
declarations per the note above and rebuild.

### Step 6 — Screen methods → `Il2CppHook::ResolveMethodCached`
File: `internal/src/gui/tabs/CameraTAB.cpp`

Replace `GetUnityScreenSize` (lines 171-182):
```cpp
// Before
static bool GetUnityScreenSize(float& outWidth, float& outHeight)
{
    if (!s_screenWidthMethod || !s_screenHeightMethod) {
        Il2CppClass* screen = Resolver::FindClass("UnityEngine", "Screen");
        if (!screen) return false;
        s_screenWidthMethod = il2cpp_class_get_method_from_name(screen, "get_width", 0);
        s_screenHeightMethod = il2cpp_class_get_method_from_name(screen, "get_height", 0);
        if (!s_screenWidthMethod || !s_screenHeightMethod) return false;
    }
    return InvokeStaticIntGetter(s_screenWidthMethod,  outWidth)
        && InvokeStaticIntGetter(s_screenHeightMethod, outHeight);
}
// After
static bool GetUnityScreenSize(float& outWidth, float& outHeight)
{
    if (!s_screenWidthMethod || !s_screenHeightMethod) {
        s_screenWidthMethod  = Il2CppHook::ResolveMethodCached("Screen", "get_width",  0, false, "UnityEngine");
        s_screenHeightMethod = Il2CppHook::ResolveMethodCached("Screen", "get_height", 0, false, "UnityEngine");
        if (!s_screenWidthMethod || !s_screenHeightMethod) return false;
    }
    return InvokeStaticIntGetter(s_screenWidthMethod,  outWidth)
        && InvokeStaticIntGetter(s_screenHeightMethod, outHeight);
}
```
(`loose=false` + `namespaze="UnityEngine"` preserves the original's exact
namespace match via `Resolver::FindClass("UnityEngine", "Screen")` rather
than switching to a short-name scan.)

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 7 — `WorldToScreenPoint` → `Il2CppHook::ResolveMethodCached`
File: `internal/src/gui/tabs/CameraTAB.cpp`

In `CameraTAB::CalibrateScreenBasis` (lines 705-711):
```cpp
// Before
if (!s_worldToScreenPointMethod) {
    Il2CppClass* klass = il2cpp_object_get_class(camObj);
    if (!klass) return false;
    s_worldToScreenPointMethod =
        il2cpp_class_get_method_from_name(klass, "WorldToScreenPoint", 1);
    if (!s_worldToScreenPointMethod) return false;
}
// After
if (!s_worldToScreenPointMethod) {
    s_worldToScreenPointMethod =
        Il2CppHook::ResolveMethodCached("Camera", "WorldToScreenPoint", 1, true, "UnityEngine");
    if (!s_worldToScreenPointMethod) return false;
}
```

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
bash internal/tools/wsl-build.sh Debug             # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh             # exit 0

# PlayerTAB's private field-resolution mini-framework gone (expect ZERO hits):
grep -n 'kFB_EM_SLOTS\|kFB_ITEM_OP\|kFB_ITEM_TYPE\|kCondRawOffset\|FindFieldOnHierarchy\|ResolveEquipmentManagerClass\|ResolveItemSlotClass\|EnsureEquipmentOffsets\|ReadManagedString' internal/src/gui/tabs/PlayerTAB.cpp

# CameraTAB no longer calls the raw method-resolution API directly (expect ZERO hits):
grep -n 'il2cpp_class_get_method_from_name' internal/src/gui/tabs/CameraTAB.cpp

# CameraTAB's field-disambiguation loop is UNCHANGED (expect exactly 1 hit — do not delete this one):
grep -c 'il2cpp_class_get_fields' internal/src/gui/tabs/CameraTAB.cpp
```

## Out of scope
- Migrating `CameraTAB.cpp:274-310`'s field-disambiguation loop to
  `RuntimeOffsets::CM_UnityCam` directly — see Target design and Divergence
  warnings above. Do not touch it.
- `WorldTAB.cpp`, `CamState.cpp` (plan 41), `TestTAB.cpp` (plan 40).
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
- Any change to `PlayerTAB`'s or `CameraTAB`'s observable behavior, timing,
  or UI layout, including the equipment-read gating behavior (unlike plan
  39's `AJJJBDBNBLM` gating change, `PlayerTAB` already reads through the
  0x668 `PlayerEquipMgr` fallback today with no strict gate — nothing
  changes here).
