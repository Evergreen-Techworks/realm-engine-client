# 38 — Core Helper Consolidation (thread-attach, UTF-8 string read)

## Goal
Two helpers that feature code has re-implemented get a sanctioned home, and
the existing duplicates are deleted:

1. `Il2CppHook::EnsureThreadAttached()` — the thread-local
   "attach this OS thread to the IL2CPP domain once" guard, currently
   duplicated verbatim in SpeedHack and NoclipHook.
2. `Il2CppC::ReadStringUtf8()` — a proper UTF-16 → UTF-8 IL2CPP string copy
   (the behavior PlayerTAB hand-rolls), added alongside the existing
   ASCII-lossy `Il2CppC::ReadString`.

After this plan the DLL builds and behaves identically. `ReadStringUtf8` has
no consumers yet (plans 41/42 migrate them); the two thread-attach consumers
are migrated here because they are the only two and the diff is trivial.

## Dependencies
None — parallel-safe with plan 37. Plans 41 and 42 depend on this plan
(they call `Il2CppC::ReadStringUtf8`).

Files touched (no other plan in this wave touches them):
- `internal/src/platform/hooks/Il2CppHook.h`
- `internal/src/platform/hooks/Il2CppHook.cpp`
- `internal/src/core/il2cpp/Il2CppContainers.h`
- `internal/src/core/il2cpp/Il2CppContainers.cpp`
- `internal/src/features/movement/speedhack/SpeedHack.cpp`
- `internal/src/features/movement/noclip/NoclipHook.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.

## Current state

### Duplicate 1 — EnsureIl2CppThreadAttached (verbatim ×2)
`features/movement/speedhack/SpeedHack.cpp:194-208` and
`features/movement/noclip/NoclipHook.cpp:57-71` contain the identical
function:

```cpp
static bool EnsureIl2CppThreadAttached()
{
    static thread_local bool attached = false;
    if (attached)
        return true;
    if (!il2cpp_domain_get || !il2cpp_thread_attach)
        return false;

    Il2CppDomain* domain = il2cpp_domain_get();
    if (!domain)
        return false;

    attached = il2cpp_thread_attach(domain) != nullptr;
    return attached;
}
```

Call sites: `SpeedHack.cpp:404`, `NoclipHook.cpp:102`. (The third attach site,
`bootstrap/main.cpp:144-155`, is the startup `AttachIl2Cpp` — different
lifecycle, stays as-is.)

### Duplicate 2 — three IL2CPP string readers
- **Canonical:** `Il2CppC::ReadString` (`core/il2cpp/Il2CppContainers.cpp:36-51`)
  — ASCII-lossy (`ch & 0x7F`), truncates to `outCap-1`, SEH-safe per char.
- **Copy A:** `gui/tabs/WorldTAB.cpp:466-481` `ReadIl2CppString` — same ASCII
  masking, but *rejects* strings longer than 256 chars instead of truncating.
  (Migrated by plan 41.)
- **Copy B:** `gui/tabs/PlayerTAB.cpp:158-175` `ReadManagedString` — proper
  UTF-8 via `WideCharToMultiByte`, hardcodes the string header offsets
  `0x10`/`0x14` that already exist as `Il2CppC::kStrLen`/`kStrChars`
  (`Il2CppContainers.h:22-23`). (Migrated by plan 42.)

There is no UTF-8-correct reader in the sanctioned home, which is why
PlayerTAB rolled its own. This plan adds one.

## Target design

### Il2CppHook.h — add:
```cpp
// Attach the calling OS thread to the IL2CPP domain (idempotent per thread,
// thread_local cached). Required before calling IL2CPP APIs from a thread
// the runtime has not seen (detour threads, worker threads). Returns false
// if the IL2CPP API is not initialised yet or attach fails.
bool EnsureThreadAttached();
```

Implementation in `Il2CppHook.cpp`: move the function body above verbatim
(drop `static`, rename). `Il2CppHook.cpp` already builds against the IL2CPP
API via the PCH (`pch-il2cpp.h`); if `il2cpp_domain_get`/`il2cpp_thread_attach`
are not visible there, add the same include the two feature files use.

### Il2CppContainers.h — add:
```cpp
// Copy an IL2CPP System.String into a UTF-8 buffer via WideCharToMultiByte
// (correct for non-ASCII names). Rejects implausible lengths (len <= 0 or
// len > 4096 -> returns 0). Always null-terminates when outCap > 0.
// Returns bytes written (excluding the null). SEH-safe.
int ReadStringUtf8(void* strPtr, char* out, int outCap);
```

Implementation in `Il2CppContainers.cpp` (mirror PlayerTAB.cpp:158-175 but on
`Il2CppC::` constants and `Mem::` primitives):

```cpp
int ReadStringUtf8(void* strPtr, char* out, int outCap) {
    if (!Mem::AddrOk(strPtr) || out == nullptr || outCap <= 0) return 0;
    out[0] = '\0';
    int32_t len = Mem::ReadOr<int32_t>(strPtr, kStrLen, 0);
    if (len <= 0 || len > 4096) return 0;
    // Copy UTF-16 units under SEH, then convert.
    wchar_t wbuf[512];
    int n = (len < 511) ? len : 511;
    const uint8_t* chars = reinterpret_cast<const uint8_t*>(strPtr) + kStrChars;
    for (int i = 0; i < n; ++i) {
        uint16_t ch = Mem::ReadOr<uint16_t>(chars + static_cast<size_t>(i) * 2u, 0, 0);
        wbuf[i] = static_cast<wchar_t>(ch);
    }
    int written = WideCharToMultiByte(CP_UTF8, 0, wbuf, n, out, outCap - 1,
                                      nullptr, nullptr);
    if (written < 0) written = 0;
    out[written] = '\0';
    return written;
}
```

`Il2CppContainers.cpp` needs `<windows.h>` visibility for
`WideCharToMultiByte`; the PCH provides it (MemRead.h already relies on
`<windows.h>` from the PCH — see MemRead.h:20).

Do NOT change the existing `ReadString` — its ASCII behavior is depended on
by IPC/diag consumers and plan 41 keeps WorldTAB on it.

## Steps

### Step 1 — Add Il2CppHook::EnsureThreadAttached
Files: `internal/src/platform/hooks/Il2CppHook.h`,
       `internal/src/platform/hooks/Il2CppHook.cpp`

Add the declaration and definition exactly as in Target design.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 — Migrate SpeedHack and NoclipHook
Files: `internal/src/features/movement/speedhack/SpeedHack.cpp`,
       `internal/src/features/movement/noclip/NoclipHook.cpp`

In each file: delete the local `EnsureIl2CppThreadAttached()` function
(SpeedHack.cpp:194-208, NoclipHook.cpp:57-71) and replace its call sites
(SpeedHack.cpp:404, NoclipHook.cpp:102) with
`Il2CppHook::EnsureThreadAttached()`. Both files already include
`Il2CppHook.h` (SpeedHack uses `Il2CppHook::ResolveMethodCached`, NoclipHook
uses `Il2CppHook::ResolveMethod`/`InstallMinHook`) — verify the include is
present, add `#include "Il2CppHook.h"` if not.

Before:
```cpp
if (!EnsureIl2CppThreadAttached())
    return;
```
After:
```cpp
if (!Il2CppHook::EnsureThreadAttached())
    return;
```

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 3 — Add Il2CppC::ReadStringUtf8
Files: `internal/src/core/il2cpp/Il2CppContainers.h`,
       `internal/src/core/il2cpp/Il2CppContainers.cpp`

Add the declaration and definition from Target design, directly below the
existing `ReadString`.

**Verify:** `bash internal/tools/wsl-build.sh Debug` (the new function is
unreferenced — confirm no unused-warning breaks the build; if the toolset
warns, that is acceptable only if the build still reports 0 warnings — in
that case mark it referenced by plans 41/42 and proceed; MSVC does not warn
on unused non-static functions, so this should be a non-issue).

## Verification
```bash
bash internal/tools/wsl-build.sh Debug           # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh           # exit 0

# The duplicate is gone (expect ZERO hits):
grep -rn 'static bool EnsureIl2CppThreadAttached' internal/src/features/

# The new APIs exist:
grep -n 'EnsureThreadAttached' internal/src/platform/hooks/Il2CppHook.h
grep -n 'ReadStringUtf8' internal/src/core/il2cpp/Il2CppContainers.h
```

## Out of scope
- Migrating WorldTAB/PlayerTAB string readers (plans 41/42).
- `bootstrap/main.cpp` `AttachIl2Cpp` — startup attach, different concern.
- SpeedHack's `FindClassAny` triple-fallback class lookup
  (SpeedHack.cpp:217-228) — a thin local convenience over sanctioned
  `Resolver::` calls; not worth a shared home yet.
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/` — dodge program
  territory, even if a dodge file contains the same duplicate.
