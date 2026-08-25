# 24 — CameraTAB Offset Centralization

## Goal
Move CameraTAB's hardcoded CameraManager field offsets (`OFF_CM_TRANSFORM`
0x28, `OFF_CM_UNITY_CAM` 0x50) into the `RuntimeOffsets` self-healing table
so they survive game patches. Consolidate the 17
`il2cpp_class_get_method_from_name` calls into cached, null-checked statics
resolved once. Reduce the file's 24 unmarked `reinterpret_cast` sites by
routing game-object reads through `Mem::` where applicable. The file remains
a GUI diagnostic tab -- no new abstraction layer is created.

## Dependencies
None -- parallel-safe. No other plan touches `CameraTAB.cpp`.

Potential minor conflict with plan 22 if both edit IpcBridge.h imports in the
same file, but CameraTAB.cpp does not include IpcBridge.h, so no conflict.

Files touched:
- `internal/src/core/runtime/RuntimeOffsets.h` (add 2 offset variables)
- `internal/src/core/runtime/RuntimeOffsets.cpp` (add 2 table entries)
- `internal/src/gui/tabs/CameraTAB.cpp` (main migration target)

## Current state

### Hardcoded offsets (CameraTAB.cpp:43-44)
```cpp
static constexpr uint32_t OFF_CM_TRANSFORM  = 0x28;  // mainCameraContainer Transform*
static constexpr uint32_t OFF_CM_UNITY_CAM  = 0x50;  // UnityEngine.Camera*
```
These are CameraManager class fields. When the game patches and Deca reorders
fields, these offsets silently break. Every other game field offset goes
through `RuntimeOffsets::EnsureAll()` which self-heals by looking up the
field by BeeByte-obfuscated name at runtime.

### Duplicated il2cpp_class_get_method_from_name calls
CameraTAB resolves the same methods repeatedly without caching:

1. `get_eulerAngles` on Transform -- line 214 (inside DoRefresh, called
   every auto-refresh cycle)
2. `get_width`/`get_height` on Screen -- lines 130-131 (cached in statics,
   but the class lookup `Resolver::FindClass("UnityEngine","Screen")` is not)
3. `get_pixelRect` on Camera -- line 284 (inside DoRefresh)
4. `get_position` on Transform -- line 309 (inside DoRefresh)
5. `SetCameraAngle` on CameraManager -- line 388 (inside ApplyAngle)
6. `ANBDPNHJBHG`/`get_IOABMGFJLLP`/`IOABMGFJLLP` offset-mode getter --
   lines 333-335 AND 456-460 (duplicated lookup in both DoRefresh and Render)

Total: 17 `il2cpp_class_get_method_from_name` calls in the file.

### reinterpret_cast sites (24 total, 0 raw-access-ok)
Most are:
- Unboxing IL2CPP invoke results (e.g., `reinterpret_cast<const float*>(unboxed)`)
- Casting void* pointers for `il2cpp_object_get_class` calls
- Storing/retrieving `uintptr_t` camera pointers

The unboxing casts are inherent to IL2CPP interop and cannot be eliminated.
The pointer-offset reads at lines 210, 270, 305 currently use `Mem::TryRead`
which is correct. The remaining casts are structural (casting between
`void*`/`Il2CppObject*`/`uintptr_t`).

## Target design

### New RuntimeOffsets entries
Add to `RuntimeOffsets.h`:
```cpp
// CameraManager (DecaGames.RotMG.Managers.CameraManager)
extern uint32_t CM_Transform;    // mainCameraContainer Transform*  fallback 0x28
extern uint32_t CM_UnityCam;     // UnityEngine.Camera*             fallback 0x50
```

Add corresponding entries to the `RuntimeOffsets.cpp` self-healing table,
resolving against the CameraManager class. The BeeByte-obfuscated field names
need to be identified from the current dump -- use the same field-iterator
approach CameraTAB already does (type-check for "Camera" and "Transform") as
the resolution strategy in RuntimeOffsets, or use the known BeeByte names if
available in `BeebyteName.h`.

If the exact BeeByte names are not in the map, use a **type-disambiguated
resolver**: iterate CameraManager fields, match by field type name
("Transform" for CM_Transform, "Camera" for CM_UnityCam). This matches the
existing pattern at CameraTAB.cpp:243-268.

### Method caching
Create file-scoped statics for every resolved MethodInfo*, initialized once
on first use (the existing pattern for `s_screenWidthMethod`/
`s_screenHeightMethod` at lines 109-110). Consolidate the duplicated
IOABMGFJLLP getter resolution (currently done in both DoRefresh and Render)
into a single static.

### No new files or classes
This is a local cleanup within CameraTAB.cpp and an extension of the existing
RuntimeOffsets table. No new headers, no new namespace.

## Steps

### Step 1 -- Add CM_Transform and CM_UnityCam to RuntimeOffsets
Files: `internal/src/core/runtime/RuntimeOffsets.h`,
       `internal/src/core/runtime/RuntimeOffsets.cpp`

In `RuntimeOffsets.h`, add in the appropriate section:
```cpp
// CameraManager
extern uint32_t CM_Transform;    // fallback 0x28
extern uint32_t CM_UnityCam;     // fallback 0x50
```

In `RuntimeOffsets.cpp`, add definition + self-healing table entry. The
CameraManager class name in BeeByte may be the readable name "CameraManager"
(check `BeebyteName.h` -- if not there, use
`Resolver::FindClass("DecaGames.RotMG.Managers", "CameraManager")` for the
class, then the field-by-type-name iterator pattern).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Replace hardcoded offsets in CameraTAB.cpp
File: `internal/src/gui/tabs/CameraTAB.cpp`

1. Remove lines 43-44 (`static constexpr OFF_CM_TRANSFORM`, `OFF_CM_UNITY_CAM`).
2. Replace all uses of `OFF_CM_TRANSFORM` with `RuntimeOffsets::CM_Transform`
   (lines 210, 305).
3. Replace `OFF_CM_UNITY_CAM` / `camFieldOff` fallback (line 240) with
   `RuntimeOffsets::CM_UnityCam`. The dynamic field-iterator block
   (lines 242-268) can remain as a validation/logging mechanism, but its
   hardcoded fallback should reference `RuntimeOffsets::CM_UnityCam` instead
   of the deleted local constant.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 -- Cache method lookups
File: `internal/src/gui/tabs/CameraTAB.cpp`

Create file-scoped cached statics:
```cpp
static const MethodInfo* s_getEulerAngles = nullptr;
static const MethodInfo* s_getPixelRect   = nullptr;
static const MethodInfo* s_getPosition    = nullptr;
static const MethodInfo* s_setCameraAngle = nullptr;
static const MethodInfo* s_getOffsetMode  = nullptr;  // ANBDPNHJBHG
static bool s_methodsSearched = false;
```

Create a `EnsureCameraMethods()` helper that resolves all five methods once
(from the CameraManager class and its Transform/Camera field types). Guard
each resolve with null-check + `s_methodsSearched` flag.

Replace the inline lookups in `DoRefresh()` (lines 214, 284, 309, 333-335)
and `ApplyAngle()` (line 388) and `Render()` (lines 456-460) with the
cached statics.

Consolidate the duplicated IOABMGFJLLP getter resolution: the exact same
three-name fallback chain (`ANBDPNHJBHG` -> `get_IOABMGFJLLP` ->
`IOABMGFJLLP`) appears at lines 333-335 AND 456-460. After this step it
appears once in `EnsureCameraMethods()`.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Final cleanup
File: `internal/src/gui/tabs/CameraTAB.cpp`

1. Remove the now-unused `FindClassByName()` local helper (lines 87-98) if
   it is no longer called (it was used for CameraManager class lookup which
   should now go through `Resolver::FindClass` or the RuntimeOffsets table).
2. Review remaining `reinterpret_cast` sites -- mark any that are structural
   IL2CPP interop (unboxing, void*-to-Il2CppObject* casts) as understood.
   Do NOT add `raw-access-ok` markers to these -- they are not game-data
   offset reads and are not flagged by the guardrail script.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails still pass
bash internal/tools/check-raw-access.sh

# No hardcoded camera offsets remain:
grep -n 'OFF_CM_TRANSFORM\|OFF_CM_UNITY_CAM' internal/src/gui/tabs/CameraTAB.cpp
# Expected: EMPTY

# Method lookups should be substantially reduced:
grep -c 'il2cpp_class_get_method_from_name' internal/src/gui/tabs/CameraTAB.cpp
# Expected: <= 5 (down from 17; the cache-init helper still calls them once)
```

## Out of scope
- Extracting CameraTAB's camera logic into a `CameraManager` service class --
  that is a larger refactor beyond offset centralization.
- Migrating the unboxing `reinterpret_cast` sites -- these are inherent to
  IL2CPP property invoke and cannot be replaced with `Mem::` reads.
- The `CamState` snapshot system (already working, separate concern).
- The `W2S` (World-to-Screen) helper -- already a separate header.
