# 01 — Memory-read primitives (`core/runtime/MemRead.h`)

## Goal
After this plan a single header `core/runtime/MemRead.h` (namespace `Mem`)
provides the canonical SEH-safe pointer-validity check and typed offset-read
helpers that today are copy-pasted ~13 times as `AddrOk` and open-coded ~90
times as `*reinterpret_cast<T*>(base + off)`. This plan **only creates the
header** and wires it into the PCH/include path; it migrates **no** call sites
(those are plans 04–08). The repo builds and behaves identically because nothing
yet calls the new header.

## Dependencies
None — parallel-safe foundation. This is a dependency of plans 03, 04, 05, 06,
07, 08. It creates one new file and does not edit any existing source, so it
cannot conflict with any other plan.

## Current state
The same two primitives are re-implemented all over the tree.

### Pointer-validity check (`AddrOk` / `AddrValid`) — 14 divergent copies
Enumerate them:
```
grep -rn 'bool AddrOk\|bool AddrValid' internal/src/
```
Known sites (definitions):
- `features/projectiles/ProjectileRuntimeReader.cpp:12`
- `features/projectiles/ProjectileStore.cpp:49`
- `features/projectiles/ProjectileTrajectory.cpp:70`
- `features/combat/autoaim/AimHooks.cpp:54`
- `features/combat/autoaim/WeaponProfile.cpp:20`
- `features/combat/autoaim/AutoAim.cpp:20`
- `features/combat/autoaim/ProjNoclip.cpp:38`
- `features/combat/enemytracker/EnemyTracker.cpp:50`
- `features/movement/dodge/ProjectileTracking.cpp:101`
- `features/movement/dodge/AoeTracking.cpp:145`
- `features/movement/noclip/NoclipHook.cpp:12`
- `features/movement/speedhack/SpeedHack.cpp:70`
- `core/runtime/GameState.cpp:25`
- `gui/tabs/WorldTAB.cpp:337` (named `AddrValid`)

**These copies DIVERGE — see "Target design → divergence" below. The migration
must adopt ONE behavior, so the canonical value is decided here.**

### Typed offset read — ~90 open-coded sites + 1 partial abstraction
The read idiom is `*reinterpret_cast<T*>(reinterpret_cast<uint8_t*>(base) + off)`,
usually inside a feature-local `__try` or a `Resolver::Protection::safe_call`.
Enumerate:
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/
```
Representative:
```cpp
// features/movement/dodge/DangerPlanner.cpp:66
outX = *reinterpret_cast<const float*>(lp + RuntimeOffsets::PosX);
// features/movement/dodge/AoeTracking.cpp:199
ox = *reinterpret_cast<float*>(base + RuntimeOffsets::Gjj_OriginX);
```
A **partial abstraction already exists** and is the model to generalize:
```cpp
// gui/tabs/WorldTAB.cpp:322
template<typename T>
static bool SafeRead(const void* base, uint32_t offset, T& out) {
    return Resolver::Protection::safe_call([&]() {
        out = *reinterpret_cast<const T*>(
            reinterpret_cast<const uint8_t*>(base) + offset);
    });
}
```
`RuntimeOffsets::ReadField<T>` (`core/runtime/RuntimeOffsets.h:93`) is the same
idea but keyed on `FieldInfo*`, not a raw offset — keep it; `Mem` is the raw
offset path.

## Target design
Create `internal/src/core/runtime/MemRead.h`:

```cpp
#pragma once
#include <cstdint>
// SEH-safe raw-memory helpers for reading IL2CPP object fields by byte offset.
// This is the raw-offset counterpart to RuntimeOffsets::ReadField<T> (which is
// keyed on FieldInfo*). Every consumer that today writes
// `*reinterpret_cast<T*>(base + off)` should use Mem::TryRead / Mem::ReadOr.
namespace Mem {

    // Canonical user-mode pointer sanity check. Replaces every local AddrOk /
    // AddrValid. Range is the majority behavior in the tree (see divergence).
    inline bool AddrOk(const void* p) {
        const uintptr_t a = reinterpret_cast<uintptr_t>(p);
        return a > 0x10000 && a < 0x7FFFFFFFFFFFULL;
    }

    // SEH-safe read of a T at (base + off). Returns false and leaves `out`
    // untouched on null base or access violation.
    template<typename T>
    inline bool TryRead(const void* base, uint32_t off, T& out) {
        if (!AddrOk(base)) return false;
        __try {
            out = *reinterpret_cast<const T*>(
                reinterpret_cast<const uint8_t*>(base) + off);
            return true;
        } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }

    // SEH-safe read returning `fallback` on failure.
    template<typename T>
    inline T ReadOr(const void* base, uint32_t off, T fallback) {
        T v; return TryRead(base, off, v) ? v : fallback;
    }

    // SEH-safe pointer-field read (the `*(void**)(base+off)` idiom). Returns
    // nullptr on failure; the returned pointer is itself AddrOk-validated.
    inline void* ReadPtr(const void* base, uint32_t off) {
        void* p = nullptr;
        if (!TryRead(base, off, p)) return nullptr;
        return AddrOk(p) ? p : nullptr;
    }
}
```

**Location:** `core/runtime/` (alongside `RuntimeOffsets.h`, `GameState.h`).
**Ownership:** header-only, no `.cpp`, no state — pure inline helpers.
**Thread-safety:** stateless; safe from render thread and hook threads.
**Hot path:** all helpers are `inline` and compile to the same code the manual
reads generate today (SEH frame is free on x64 when no exception is thrown), so
there is **no per-frame regression**. The dictionary-walk inner loop (plan 02)
may still read without the per-element SEH frame where it already wraps the whole
loop in one `__try`; `Mem::TryRead` is for scattered scalar reads, not tight
inner loops.

### Divergence — decide the canonical `AddrOk` here
The copies disagree on two things:
- **Lower bound:** most use `a > 0x10000` (exclusive); `SpeedHack.cpp:71` and
  `GameState.cpp:26` use `a >= 0x10000u` (inclusive). Difference is only the
  single address `0x10000`, never a real IL2CPP object. **Canonical: `> 0x10000`**
  (majority).
- **Upper bound:** most use `< 0x7FFFFFFFFFFFULL` (12 hex F, ~128 TB, the x64
  user-mode ceiling); `WorldTAB.cpp:340` uses `< 0x7FFFFFFFFFFull` (11 hex F,
  ~8 TB — **too low**, would reject valid high heap addresses).
  `Resolver::Protection::IsValidIl2CppObject` (`Il2CppResolver.h:25`) uses the
  same 12-F ceiling. **Canonical: `< 0x7FFFFFFFFFFFULL`** (12 F).
This is a behavior change for exactly two call sites (SpeedHack/GameState lose
the `0x10000` inclusive edge — inert) and WorldTAB (gains the correct higher
ceiling). See the Divergence-bugs note in `00-overview.md`; adopting the
canonical value is intended.

## Steps
1. Create `internal/src/core/runtime/MemRead.h` with the exact content above.
2. Confirm it is reachable by the include root: it lives under `src/`, so
   consumers include it as `#include "core/runtime/MemRead.h"`. No project-file
   change is needed for a header-only file included on demand (the `.vcxproj`
   globs headers for IntelliSense only; compilation is driven by `#include`).
   Optionally add it to the header list in `il2cpp-dll-injection.vcxproj` next to
   `RuntimeOffsets.h` so it shows in the Solution Explorer.
3. Build to prove the header compiles under the PCH:
   `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`
   (Windows / VS2022 v145). It must build with **no new warnings**; since nothing
   includes the header yet, this only validates the file is syntactically valid
   if referenced. To force a compile check, temporarily add
   `#include "core/runtime/MemRead.h"` to `core/runtime/GameState.cpp`, build,
   then remove it.

## Verification
- `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`
  succeeds (and `x64 | Debug`).
- File exists: `test -f internal/src/core/runtime/MemRead.h`.
- No behavior change: this plan adds zero call sites. `grep -rc 'Mem::' internal/src/`
  returns only the header itself.

## Out of scope
- Do NOT migrate any `AddrOk` / `AddrValid` copy or any `reinterpret_cast` read
  yet — that is plans 04–08.
- Do NOT touch `RuntimeOffsets::ReadField<T>` or `Resolver::Protection` — they
  keep their own SEH wrappers; `Mem` is additive.
- Do NOT add dictionary/array walking here — that is plan 02.
