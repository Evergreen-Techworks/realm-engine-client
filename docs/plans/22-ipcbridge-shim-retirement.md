# 22 — IpcBridge_ Feature-State Shim Retirement

## Goal
Remove the 37 one-liner `IpcBridge_*` getter/setter functions that do nothing
but forward to `FeatureState::*`. After this plan, `FeatureCommandRegistry`
(the sole external consumer of the setters) calls `FeatureState::` directly,
and the 37 dead shims are deleted from `IpcBridge.h` and `IpcBridge.cpp`.
The IpcBridge header shrinks to its real responsibilities: pipe thread, tile
walkability, threat publishing, overlay enable, shutdown, and auth state.

## Dependencies
None -- parallel-safe. No other plan touches `IpcBridge.h`, `IpcBridge.cpp`,
or `FeatureCommandRegistry.cpp`.

Files touched by this plan only:
- `internal/src/core/ipc/IpcBridge.h`
- `internal/src/core/ipc/IpcBridge.cpp`
- `internal/src/features/control/FeatureCommandRegistry.cpp`

## Current state
`IpcBridge.cpp` lines 101-141 declare 37 functions like:

```cpp
// IpcBridge.cpp:101-104
bool    IpcBridge_GetAutoAimEnabled()             { return FeatureState::GetAutoAimEnabled(); }
int     IpcBridge_GetAutoAimMode()                { return FeatureState::GetAutoAimMode(); }
void    IpcBridge_SetAutoAimEnabled(bool enabled) { FeatureState::SetAutoAimEnabled(enabled); }
void    IpcBridge_SetAutoAimMode(int mode)        { FeatureState::SetAutoAimMode(mode); }
```

These are identically patterned through dodge, ability, walk-target, camera,
skin, and client-defense families. Each has a matching declaration in
`IpcBridge.h` (lines 79-114).

The only external consumer of the **setters** is `FeatureCommandRegistry.cpp`
(10 call sites, lines 92-121):

```cpp
// FeatureCommandRegistry.cpp:100-101
FH_BOOL("autoAimEnabled", IpcBridge_SetAutoAimEnabled),
FH_INT("autoAimMode", IpcBridge_SetAutoAimMode),
```

The **getters** have zero external callers outside `IpcBridge.cpp` itself
(confirmed by grep).

### Functions to keep (NOT pure FeatureState forwards)
These `IpcBridge_*` functions own real state or side effects and must NOT be
removed:
- `IpcBridge_RequestShutdown()` -- sets `s_shutdown` flag
- `IpcBridge_SetOverlayEnabled(bool)` -- writes `s_overlayEnabled` + clears
  `settings.bShowMenu` + logs
- `IpcBridge_IsOverlayEnabled()` -- reads `s_overlayEnabled` atomic
- `IpcBridge_IsAuthenticated()` -- reads `s_conn` liveness
- `IpcBridge_GetUserId()` -- returns `""`
- `IpcBridge_EmitPredictedHit(...)` -- queues IPC message
- `IpcBridge_PublishThreats(...)` -- queues IPC message
- `IpcBridge_IsTileWalkable(...)` -- reads tile state
- `IpcBridge_GetTileStats(...)` / `IpcBridge_CopyUniqueTypeEntries(...)` -- tile diagnostics
- `IpcBridge_ApplyFeatureOverrides()` -- not a shim; retained

## Target design
After this plan:

1. `FeatureCommandRegistry.cpp` replaces every `IpcBridge_Set*` call with the
   corresponding `FeatureState::Set*` call. The `#include "IpcBridge.h"` can
   remain (needed for `IpcBridge_RequestShutdown` and
   `IpcBridge_SetOverlayEnabled`).

2. The 37 pure-forward functions are deleted from `IpcBridge.cpp` (lines
   101-141) and their declarations removed from `IpcBridge.h` (lines 78-114).

3. No behavior change. Thread safety is identical -- `FeatureState` uses
   `std::atomic` for every field, and the shims added no synchronization.

## Steps

### Step 1 -- Migrate FeatureCommandRegistry setters
File: `internal/src/features/control/FeatureCommandRegistry.cpp`

Add `#include "FeatureState.h"` if not already present (it is, at line 34).

Replace each `IpcBridge_Set*` call with the matching `FeatureState::Set*`:

| Line | Before | After |
|------|--------|-------|
| 100 | `IpcBridge_SetAutoAimEnabled` | `FeatureState::SetAutoAimEnabled` |
| 101 | `IpcBridge_SetAutoAimMode` | `FeatureState::SetAutoAimMode` |
| 115 | `IpcBridge_SetAutoDodgeMode` | `FeatureState::SetAutoDodgeMode` |
| 116 | `IpcBridge_SetAutoDodgeHorizonMs` | `FeatureState::SetAutoDodgeHorizonMs` |
| 117 | `IpcBridge_SetAutoDodgeHitboxPadding` | `FeatureState::SetAutoDodgeHitboxPadding` |
| 118 | `IpcBridge_SetAutoDodgeWallAvoid` | `FeatureState::SetAutoDodgeWallAvoid` |
| 120 | `IpcBridge_SetAutoAbilityEnabled` | `FeatureState::SetAutoAbilityEnabled` |
| 121 | `IpcBridge_SetAutoAbilityMpPct` | `FeatureState::SetAutoAbilityMpPct` |
| 122 | `IpcBridge_SetAutoAbilityWizardMode` | `FeatureState::SetAutoAbilityWizardMode` |

Note: line 92 (`IpcBridge_SetOverlayEnabled`) must **stay** because that
function is NOT a pure forward (it has side effects).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Delete pure-forward function bodies from IpcBridge.cpp
File: `internal/src/core/ipc/IpcBridge.cpp`

Delete the block of 37 one-liner functions (lines 101-141, from
`IpcBridge_GetAutoAimEnabled` through `IpcBridge_GetClientClassType`).
Keep all functions listed in "Functions to keep" above.

**Verify:** `bash internal/tools/wsl-build.sh Debug` -- will fail until step 3
removes the declarations. Combine with step 3 if preferred.

### Step 3 -- Delete declarations from IpcBridge.h
File: `internal/src/core/ipc/IpcBridge.h`

Delete lines 78-114 (the "Unified feature state accessors" block), which
declares the 37 functions removed in step 2. Keep:
- `IpcBridge_RequestShutdown` (line 21)
- `IpcBridge_EmitPredictedHit` (line 24)
- `IpcBridge_PublishThreats` (line 55)
- `IpcBridge_IsTileWalkable` (line 58)
- `IpcBridge_GetTileStats` (line 61)
- `IpcBridge_CopyUniqueTypeEntries` (line 68)
- `IpcBridge_GetUserId` / `IpcBridge_IsAuthenticated` (lines 71-72)
- `IpcBridge_IsOverlayEnabled` / `IpcBridge_SetOverlayEnabled` (lines 75-76)
- `IpcBridge_ApplyFeatureOverrides` (line 117)

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Clean up IpcBridge.h/cpp header comment
Update the file-level comments in `IpcBridge.h` (lines 6-9) and
`IpcBridge.cpp` (lines 2-11) to remove references to "compatibility shims"
and "legacy callers" since the shim layer no longer exists.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails must still pass
bash internal/tools/check-raw-access.sh

# No remaining pure-forward shims -- these greps must return EMPTY:
grep -n 'IpcBridge_GetAutoAim\|IpcBridge_SetAutoAim\b' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetAutoDodge\|IpcBridge_SetAutoDodge' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetAutoAbility\|IpcBridge_SetAutoAbility' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetWalkTarget\|IpcBridge_SetWalkTarget' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetCamera\|IpcBridge_SetCamera' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetSkinOverride\|IpcBridge_SetSkinOverride' internal/src/core/ipc/IpcBridge.h
grep -n 'IpcBridge_GetClientDefense\|IpcBridge_GetClientClassType' internal/src/core/ipc/IpcBridge.h

# FeatureCommandRegistry still uses IpcBridge_ only for overlay + shutdown:
grep -c 'IpcBridge_' internal/src/features/control/FeatureCommandRegistry.cpp
# Expected: 2 (IpcBridge_SetOverlayEnabled, IpcBridge_RequestShutdown)
```

## Out of scope
- `IpcBridge_SetOverlayEnabled` / `IpcBridge_IsOverlayEnabled` -- these own
  the `s_overlayEnabled` atomic and have side effects; do not collapse.
- `IpcBridge_RequestShutdown` -- owns the `s_shutdown` flag.
- Moving tile walkability or threat publishing out of IpcBridge -- those are
  genuine IPC concerns and belong here.
- The `IpcBridge_ApplyFeatureOverrides` function -- it may be a candidate for
  removal in a future plan but is called from `FeatureRuntime` and is not a
  trivial forward.
