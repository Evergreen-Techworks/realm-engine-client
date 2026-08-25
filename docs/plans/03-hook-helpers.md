# 03 — IL2CPP hook helpers (`platform/hooks/Il2CppHook.h/.cpp`)

## Goal
After this plan a small helper module `platform/hooks/Il2CppHook.{h,cpp}`
(namespace `Il2CppHook`) provides two functions every feature that installs a
MinHook on an IL2CPP method needs: `ResolveMethod(className, methodName, argc)`
(returns the method pointer or null) and `InstallMinHook(target, detour,
&original, label)` (the `MH_CreateHook` + `MH_EnableHook` + logging sequence).
Today each of the 8 hooking features open-codes both. This plan creates the
helper and does NOT migrate features (that happens inside the per-family plans
04–08, which already touch those files). The repo builds and behaves identically.

## Dependencies
None strictly required, but SHOULD be merged before plans 04, 05, 08 (they
migrate the hook installers and will call these helpers). It only creates one new
module and edits nothing existing, so no file conflicts.

## Current state
### Method resolution — divergent copies
```cpp
// features/combat/autoaim/AimHooks.cpp:146
static void* ResolveMethod(const char* cls, const char* method, int params) {
    Il2CppClass* klass = Resolver::GetClass("", cls);
    if (!klass) return nullptr;
    const MethodInfo* mi = il2cpp_class_get_method_from_name(klass, method, params);
    return (mi && mi->methodPointer) ? reinterpret_cast<void*>(mi->methodPointer) : nullptr;
}
// features/movement/noclip/NoclipHook.cpp:34  — same idea, but resolves the class
//   via Resolver::FindClassLoose (obfuscated name) and wraps the lookup in safe_call.
static const MethodInfo* FindMethod(Il2CppClass* klass, const char* name, int argc) { ... }
// features/combat/autoaim/ProjNoclip.cpp:149  — inline, no helper.
```
**Divergence:** AimHooks resolves the class with `Resolver::GetClass("", cls)`
(exact il2cpp lookup); NoclipHook uses `Resolver::FindClassLoose` (first loose
match, obfuscation-proof). The unified helper must support **both** — obfuscated
IL2CPP class names get renamed by BeeByte every patch, so `FindClassLoose` is
the more robust default. See divergence note below.

### Install sequence — repeated in 8 files
```
grep -rn 'MH_CreateHook' internal/src/features/
```
- `features/combat/autoaim/AimHooks.cpp:174-183`
- `features/combat/autoaim/ProjNoclip.cpp:199-215`
- `features/movement/noclip/NoclipHook.cpp:129-149`
- `features/movement/dodge/AoeTracking.cpp:841,908,943,981`
- `features/movement/dodge/DangerPlanner.cpp:860-867`
- `features/movement/dodge/ProjectileTracking.cpp:441-445`
- `features/account/CredentialCapture.cpp:188-207`
- `features/account/CharSelect.cpp:54-64`
Each is: `MH_CreateHook(target, detour, &original)` → check `MH_OK` → log →
`MH_EnableHook(target)` → check `MH_OK` → log. `SpeedHack.cpp:390` uses
`DetourAttach` instead (Detours, not MinHook) — **leave it alone**, it is the
one non-MinHook feature hook and does not fit this helper.

## Target design
Create `internal/src/platform/hooks/Il2CppHook.h`:
```cpp
#pragma once
#include <cstdint>
struct MethodInfo;
namespace Il2CppHook {
    // Resolve a method pointer for hooking. If `loose` (default), the class is
    // found via Resolver::FindClassLoose (BeeByte-rename proof); otherwise via
    // Resolver::GetClass(namespaze,className). Returns nullptr if the class or
    // method (with matching argc) is missing or has no methodPointer. SEH-safe.
    void* ResolveMethod(const char* className, const char* methodName,
                        int argc, bool loose = true, const char* namespaze = "");

    // MH_CreateHook(target, detour, &original) + MH_EnableHook(target) with the
    // standard DBG_FILE_LOG on each failure. Returns true only if both succeed.
    // `label` is used purely for logging. Assumes MH_Initialize already ran
    // (DirectX.cpp / first hook installs it — keep that behavior).
    bool InstallMinHook(void* target, void* detour, void** original,
                        const char* label);
}
```
Bodies go in `Il2CppHook.cpp`.

**Location:** `platform/hooks/` (alongside `InitHooks.cpp`, the hook-lifecycle
concern folder).
**Ownership:** stateless helpers; the per-feature `Install()`/`Uninstall()`
functions keep owning their own target pointers and trampolines — this plan does
NOT introduce a central registry that owns lifecycles (teardown stays in
`InitHooks.cpp::DetourUninitialization`, whose deliberate reverse order —
`InitHooks.cpp:94-100` — must not change).
**Thread-safety:** install happens on the render thread / lazy-init path; helpers
add no state, so thread-safety is unchanged.
**Hot path:** install is one-time per feature, not per-frame — no perf concern.

### Divergence to resolve
Standardize `ResolveMethod` on `FindClassLoose` by default (`loose=true`). During
migration (plans 04/05/08), AimHooks currently uses exact `GetClass("", cls)`; it
must switch to the loose default UNLESS its class name is a stable non-obfuscated
name. Check each call: if the class token is a 10–11 char BeeByte blob
(e.g. `HBEAKBIHANL`), use loose; if it is a real .NET name, pass `loose=false`.
State this per call site in the consuming plan.

## Steps
1. Create `internal/src/platform/hooks/Il2CppHook.h` (signatures above).
2. Create `internal/src/platform/hooks/Il2CppHook.cpp` implementing both,
   reusing `Resolver::FindClassLoose` / `Resolver::GetClass` and
   `il2cpp_class_get_method_from_name`, wrapping the lookup in
   `Resolver::Protection::safe_call`. Add both files to the `.vcxproj` next to
   `InitHooks.cpp`.
3. Force-compile check: `#include` the header in `InitHooks.cpp` temporarily,
   build both configs, remove.
4. Build:
   `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`
   and Debug.

## Verification
- Both configs build, no new warnings.
- `grep -c Il2CppHook internal/il2cpp-dll-injection.vcxproj` ≥ 2.
- No consumer migrated: `grep -rc 'Il2CppHook::' internal/src/` counts only the
  new module.

## Out of scope
- Do NOT change `SpeedHack.cpp`'s `DetourAttach` hook — it is Detours, not
  MinHook.
- Do NOT alter `DetourUninitialization()` teardown order or introduce a hook
  registry that owns Uninstall — features keep their own `Uninstall()`.
- Do NOT migrate any feature's `Install()` here — that is the per-family plans.
