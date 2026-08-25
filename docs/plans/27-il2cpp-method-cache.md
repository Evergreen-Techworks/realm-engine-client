# 27 — IL2CPP Method Resolution Cache

## Goal
Create a centralized `Il2CppMethodCache` (or extend `Il2CppHook`) that
resolves and caches `MethodInfo*` pointers by class+method+argcount, replacing
the 41 scattered `il2cpp_class_get_method_from_name` calls across `features/`
and `gui/` with a single cached lookup path. After this plan, method resolution
happens once per method and the result is reused across all callers.

## Dependencies
- **Plan 24 should ideally complete first** (it caches CameraTAB's 17 method
  lookups locally). If plan 24 runs first, this plan can consolidate those
  local caches into the central one. If they run in parallel, CameraTAB gets
  local caches from plan 24 and this plan skips CameraTAB.
- No hard dependency -- this plan can run independently.

Files touched:
- `internal/src/platform/hooks/Il2CppHook.h` (extend with ResolveMethodCached)
- `internal/src/platform/hooks/Il2CppHook.cpp` (add cache implementation)
- `internal/src/features/movement/dodge/DangerPlanner.cpp` (4 calls)
- `internal/src/features/movement/dodge/AoeTracking.cpp` (4 calls)
- `internal/src/features/movement/dodge/MovementRuntime.cpp` (3 calls)
- `internal/src/features/combat/autoaim/ProjNoclip.cpp` (2 calls)
- `internal/src/features/combat/autoability/AutoAbility.cpp` (2 calls)
- `internal/src/features/account/HwidCapture.cpp` (2 calls)
- `internal/src/features/account/CharSelect.cpp` (2 calls)
- `internal/src/features/movement/speedhack/SpeedHack.cpp` (1 call)
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` (1 call)
- `internal/src/features/combat/autonexus/AutoNexus.cpp` (1 call)
- `internal/src/features/visuals/FloatingTextService.cpp` (1 call)
- `internal/src/gui/tabs/PlayerTAB.cpp` (1 call)

## Current state

### 41 direct il2cpp_class_get_method_from_name calls in features/gui
Excluding `gui/tabs/CameraTAB.cpp` (17 calls, handled by plan 24), there
are 24 calls across 13 files. Many of these happen inside per-frame or
per-refresh code paths with no caching:

```cpp
// DangerPlanner.cpp (representative)
const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, "GJFKNDFMCJK", 3);
```

Some files do cache locally (e.g., SpeedHack caches in static variables),
but the caching pattern is inconsistent. Most do not cache at all.

### Existing Il2CppHook::ResolveMethod
`Il2CppHook.h` already has `ResolveMethod(className, methodName, argCount)`
which does `il2cpp_class_get_method_from_name`. But it does NOT cache -- it
resolves fresh every call. The hook-installation path (`InstallMinHook`)
calls it once during lazy init, so caching was not needed there.

### Files with most calls (excluding CameraTAB)
| File | Calls | Nature |
|------|-------|--------|
| DangerPlanner.cpp | 4 | ShowEffect/GjjKob hook targets, called once during init |
| AoeTracking.cpp | 4 | ShowEffect/GjjKob hook targets + GetNetworkTime, called once |
| MovementRuntime.cpp | 3 | Move/WASD-related, called during init |
| ProjNoclip.cpp | 2 | Hook targets, called once |
| AutoAbility.cpp | 2 | USEITEM sender, called during init |
| HwidCapture.cpp | 2 | SystemInfo methods, called once |
| CharSelect.cpp | 2 | CharSelect methods, called during init |

Most of these are one-time init lookups, not per-frame. The performance
benefit of caching is modest, but the real value is **consistency**: a single
lookup path with null-check, error logging, and the guarantee that if a
method name changes in a game patch, there is one place to update.

## Target design

### Extend Il2CppHook with cached resolution
Add to `Il2CppHook.h`:
```cpp
namespace Il2CppHook {
    // Existing:
    const MethodInfo* ResolveMethod(const char* className, const char* methodName, int argCount);
    bool InstallMinHook(void* target, void* detour, void** original, const char* label);

    // New: cached variant. Returns the same MethodInfo* on repeated calls
    // with the same (className, methodName, argCount) triple. Thread-safe
    // via a simple mutex around the lookup map. Returns nullptr if the
    // class or method cannot be found (same as ResolveMethod).
    const MethodInfo* ResolveMethodCached(const char* className,
                                           const char* methodName,
                                           int argCount);
}
```

Implementation: `std::unordered_map<std::string, const MethodInfo*>` keyed
by `"ClassName::MethodName::ArgCount"`. Populated on first call, returned
from cache on subsequent calls. Protected by `std::mutex` (these are init-
time lookups, not hot-path).

### Alternative: use Il2CppHook::ResolveMethod + local static caching
If extending Il2CppHook is too invasive, the simpler approach is to ensure
each call site uses a local `static const MethodInfo*` variable:

```cpp
static const MethodInfo* s_mi = nullptr;
if (!s_mi) s_mi = Il2CppHook::ResolveMethod("ClassName", "MethodName", 3);
```

This is already the pattern in some files. The plan should enforce it
everywhere. The central cache is nicer for debuggability but both approaches
achieve the goal.

## Steps

### Step 1 -- Add ResolveMethodCached to Il2CppHook
Files: `internal/src/platform/hooks/Il2CppHook.h`,
       `internal/src/platform/hooks/Il2CppHook.cpp`

Add the cached variant. Use a `static std::unordered_map` + `static std::mutex`
inside `Il2CppHook.cpp`. The key is a concatenated string
`"class\0method\0argcount"`.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Migrate DangerPlanner.cpp and AoeTracking.cpp
Files: `internal/src/features/movement/dodge/DangerPlanner.cpp`,
       `internal/src/features/movement/dodge/AoeTracking.cpp`

Replace `il2cpp_class_get_method_from_name(klass, "name", n)` with
`Il2CppHook::ResolveMethodCached("ClassName", "name", n)`.

Where the code first resolves the class via `Resolver::FindClass` or
`Resolver::FindClassLoose` and then gets the method, the
`ResolveMethodCached` call combines both steps (it calls FindClass
internally, matching the existing `ResolveMethod` behavior).

If the code needs the `Il2CppClass*` for other reasons besides method
resolution, keep the class lookup and just replace the method lookup
with the cached version.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 -- Migrate MovementRuntime.cpp, ProjNoclip.cpp, AutoAbility.cpp
Same mechanical pattern as step 2.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Migrate remaining files
Files: `HwidCapture.cpp`, `CharSelect.cpp`, `SpeedHack.cpp`,
       `ProjectileTracking.cpp`, `AutoNexus.cpp`, `FloatingTextService.cpp`,
       `PlayerTAB.cpp`

Same mechanical pattern.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 5 -- Final verification

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails still pass
bash internal/tools/check-raw-access.sh

# Direct il2cpp_class_get_method_from_name in features/gui should be
# substantially reduced:
grep -rc 'il2cpp_class_get_method_from_name' internal/src/features/ internal/src/gui/ | grep -v ':0$'
# Expected: 0 in features/ (all migrated), CameraTAB only if plan 24 not done
```

## Out of scope
- CameraTAB's 17 method calls -- handled by plan 24.
- Resolver::FindClass calls -- those are class lookups, not method lookups.
  A separate concern.
- The `il2cpp_class_for_each` pattern in CameraTAB's `FindClassByName` --
  handled by plan 24.
- Hook installation (already goes through `Il2CppHook::InstallMinHook`).
- Generated IL2CPP headers in `game/generated/` -- read-only reference.
