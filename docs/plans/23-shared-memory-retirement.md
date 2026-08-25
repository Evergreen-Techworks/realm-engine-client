# 23 — SharedMemory Retirement

## Goal
Remove the `SharedMemory` namespace, its `Local\RotMGBotShared` file mapping,
and the per-frame `SharedMemory::Tick()` call. This subsystem is dead: no
client-side code reads from the shared mapping, and the three query functions
(`GetClientDefense`, `GetClientClassType`, `SetNeedsNexus`) have zero callers
outside `SharedMemory.cpp` itself. Position telemetry now flows over the
named-pipe IPC bridge. Removing it eliminates a per-frame write to a mapping
nobody reads and simplifies the init/teardown path.

## Dependencies
None -- parallel-safe. No other plan touches these files.

Files touched:
- `internal/src/core/runtime/SharedMemory.h` (DELETE)
- `internal/src/core/runtime/SharedMemory.cpp` (DELETE)
- `internal/src/platform/hooks/InitHooks.cpp` (remove Init/Shutdown calls)
- `internal/src/platform/hooks/DirectX.cpp` (remove Tick call + include)

## Current state

### SharedMemory files
- `internal/src/core/runtime/SharedMemory.h` -- declares namespace with
  `Init()`, `Shutdown()`, `Tick()`, `GetClientDefense()`,
  `GetClientClassType()`, `SetNeedsNexus()`, and the 128-byte
  `RotMGBotSharedLayout` struct.
- `internal/src/core/runtime/SharedMemory.cpp` -- implements the file mapping.
  `Tick()` only writes `posX`/`posY` from `LocalPlayer`. Comment at line 71
  acknowledges the legacy status: "moving them out of shared memory eliminated
  the per-frame IL2CPP stomps".

### Callers (exhaustive)
1. `InitHooks.cpp:75` -- `SharedMemory::Init();`
2. `InitHooks.cpp:85` -- `SharedMemory::Shutdown();`
3. `DirectX.cpp:189` -- `SharedMemory::Tick();` with comment: "shared mapping
   telemetry (pos + legacy bridges still using shared memory)"

### Client-side consumer
Zero. `grep -rn 'RotMGBotShared' client/src/` returns empty. The named-pipe
IPC bridge (`InternalBridge.ts`) is the sole telemetry channel.

### Zero-caller functions
- `SharedMemory::GetClientDefense()` -- no callers outside SharedMemory.cpp
- `SharedMemory::GetClientClassType()` -- no callers outside SharedMemory.cpp
- `SharedMemory::SetNeedsNexus(bool)` -- no callers outside SharedMemory.cpp

## Target design
After this plan: `SharedMemory.h` and `SharedMemory.cpp` are deleted. The
three call sites in `InitHooks.cpp` and `DirectX.cpp` are removed. No
behavior change -- the mapping was a write-only sink.

## Steps

### Step 1 -- Remove SharedMemory::Tick from DirectX.cpp
File: `internal/src/platform/hooks/DirectX.cpp`

1. Remove `#include "SharedMemory.h"` (line 23).
2. Delete line 189: `SharedMemory::Tick();    // shared mapping...`

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Remove Init/Shutdown from InitHooks.cpp
File: `internal/src/platform/hooks/InitHooks.cpp`

1. Remove `#include "SharedMemory.h"` (line 14).
2. Delete line 75: `SharedMemory::Init();`
3. Delete line 85: `SharedMemory::Shutdown();`

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 -- Delete SharedMemory source files
Delete both files:
- `internal/src/core/runtime/SharedMemory.h`
- `internal/src/core/runtime/SharedMemory.cpp`

Also remove `SharedMemory.cpp` from the Visual Studio project file
(`il2cpp-dll-injection.vcxproj`) if it is listed there (search for
`SharedMemory` in the `.vcxproj` and `.vcxproj.filters` files).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Remove stale SharedMemory references from documentation
Search `internal/CLAUDE.md` for any mention of `SharedMemory` and remove or
update accordingly. The source layout table at line 60 mentions
`SharedMemory` -- remove it from the list.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails still pass
bash internal/tools/check-raw-access.sh

# SharedMemory must be completely gone from active source:
grep -rn 'SharedMemory' internal/src/
# Expected: EMPTY (zero results)

# The files must not exist:
ls internal/src/core/runtime/SharedMemory.h internal/src/core/runtime/SharedMemory.cpp 2>&1
# Expected: "No such file or directory" for both
```

## Out of scope
- The `FeatureState::GetClientDefense()` / `GetClientClassType()` functions
  that `SharedMemory::GetClientDefense/ClassType` used to fall back to --
  those remain in FeatureState and are used by other code.
- The named-pipe IPC bridge -- that is the replacement and stays untouched.
- Position telemetry via DiagBridge -- that is a separate, file-based
  diagnostic channel and stays untouched.
