# Plan 21 — Injection System Rework: Proxy Hijack → External Injection

## Summary

Replace the current **version.dll proxy hijacking** (static file drop in the
game folder, 17 forwarded exports, polling loops, BootGate named event) with
a clean **external injection** model: a small native injector tool that the
Electron client spawns to inject our DLL into the already-running game process.

This is a two-part architecture change:
1. **Injector** — a small C++ exe (`tools/injector/`) that takes a PID + DLL
   path and injects via `CreateRemoteThread` + `LoadLibraryW`.
2. **Simplified DLL** — strips all proxy machinery; `DllMain` → `Run()` directly.

## Motivation

| Problem | Current | After |
|---------|---------|-------|
| Game updates wipe DLL | version.dll must be re-deployed after every game update/repair | DLL lives outside game folder, game updates don't touch it |
| Process pollution | Loads into UnityCrashHandler, any process loading version.dll | Injected only into the specific game PID |
| No runtime control | Must restart game to reload DLL | Can inject into running game, supports hot-reload |
| Timing fragility | 2s sleep + 30s BootGate + 60s GameAssembly poll | Injector waits for readiness signals before injecting |
| Detection surface | version.dll proxy is the most-checked hijack DLL | DLL name is arbitrary, not in game folder |
| Dead code | Win32 manual-injector configs, _VERSION branching | Single clean codepath |

## Architecture

```
BEFORE:
  Client startup → copies version.dll to game folder
  Game launches  → Windows loads our version.dll (proxy hijack)
  version.dll    → Load() → poll GameAssembly → sleep → BootGate → Run()

AFTER:
  Client startup → no file deploy needed
  Game launches  → clean, no injected DLLs
  Client detects game process → spawns injector.exe <PID> <DLL path>
  injector.exe   → OpenProcess → VirtualAllocEx → WriteProcessMemory
                 → CreateRemoteThread(LoadLibraryW) → wait → report
  realm-engine.dll DllMain → CreateThread(Run) directly
```

## Files Changed

### New files
- `internal/tools/injector/injector.cpp` — the injector exe
- `internal/tools/injector/CMakeLists.txt` — build for the injector (or .vcxproj)
- `client/src/native/injector.ts` — TS wrapper that spawns the injector

### Modified files
- `internal/src/bootstrap/dllmain.cpp` — remove `_VERSION` branching
- `internal/src/bootstrap/main.cpp` — remove BootGate wait, simplify startup
- `internal/src/bootstrap/main.h` — remove Load/FreeVersionLibrary decls
- `internal/il2cpp-dll-injection.vcxproj` — rename output, remove .def, remove Win32 configs
- `client/src/index.ts` — replace version.dll deploy with injector spawn
- `client/src/dashboard/server/DevServer.ts` — integrate inject-on-launch
- `client/build-tools/dev-build.bat` — update for new DLL name + injector build
- `client/build-tools/build-local.bat` — include injector in build

### Deleted files
- `internal/src/bootstrap/version.cpp` — proxy forwarders (entire file)
- `internal/src/bootstrap/version.h` — proxy header (entire file)
- `internal/defs/version.def` — linker export definitions

---

## Step 1 — Build the external injector

Create `internal/tools/injector/injector.cpp`:

```
Purpose: Standalone Windows exe that injects a DLL into a target process.
Args:    injector.exe <PID> <full-path-to-dll>
Exit:    0 = success, 1 = arg error, 2 = OpenProcess fail, 3 = alloc fail,
         4 = write fail, 5 = thread fail, 6 = LoadLibrary fail in target
Output:  Single-line JSON to stdout: {"ok":true} or {"ok":false,"error":"..."}
```

Implementation:
1. Parse args: `pid` (DWORD), `dllPath` (wide string)
2. Verify DLL file exists on disk
3. `OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid)` — need SeDebugPrivilege for
   protected processes; try `AdjustTokenPrivileges` first
4. `VirtualAllocEx(hProc, NULL, pathLen, MEM_COMMIT|MEM_RESERVE, PAGE_READWRITE)`
5. `WriteProcessMemory(hProc, remoteBuf, dllPath, pathLen, NULL)`
6. Get `LoadLibraryW` address via `GetProcAddress(GetModuleHandleW(L"kernel32"), "LoadLibraryW")`
7. `CreateRemoteThread(hProc, NULL, 0, (LPTHREAD_START_ROUTINE)loadLibAddr, remoteBuf, 0, NULL)`
8. `WaitForSingleObject(hThread, 10000)` — 10s timeout
9. `GetExitCodeThread` — if zero, LoadLibraryW returned NULL (DLL load failed)
10. `VirtualFreeEx` the remote buffer
11. Print JSON result to stdout, exit with appropriate code

Build: Add to the VS solution as a second project (Console Application, x64 only),
or use a simple `cl.exe` one-liner in the build scripts:
```
cl /EHsc /O2 /W4 injector.cpp /Fe:injector.exe /link advapi32.lib
```

**Verification:** Build injector.exe standalone. Test by injecting a no-op DLL
into a dummy process (notepad.exe).

---

## Step 2 — Strip the DLL proxy machinery

### 2a. Simplify dllmain.cpp

Remove the `_VERSION` branching. Both paths now do the same thing:

```cpp
// dllmain.cpp — AFTER
#include "pch-il2cpp.h"
#include <windows.h>
#include "main.h"
#include "InitHooks.h"

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved)
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)Run, hModule, NULL, NULL);
        break;

    case DLL_PROCESS_DETACH:
        if (lpReserved == nullptr) {
            DetourUninitialization();
        }
        break;
    }
    return TRUE;
}
```

### 2b. Simplify main.cpp Run()

The external injector guarantees GameAssembly.dll is loaded before injection,
so `Run()` no longer needs to poll for it. But we still need to resolve the
handle. Replace the polling + BootGate wait with a direct `GetModuleHandleW`:

```cpp
void Run(LPVOID lpParam)
{
    hModule = static_cast<HMODULE>(lpParam);

#ifdef _DEBUG
    il2cppi_new_console();
    SetConsoleTitleA("Debug Console");
#endif
    DBG_FILE_LOG("[Run] Entered.");

    crashprobe::InstallCrashProbe();

#if !defined(_DEBUG)
    if (IsDebuggerDetected() || HasAnalysisModulesLoaded()) return;
#endif

    // The external injector ensures GameAssembly.dll is loaded before
    // injecting us. Resolve the handle directly — no polling needed.
    hGameAssembly = GetModuleHandleW(L"GameAssembly.dll");
    if (!hGameAssembly) {
        DBG_FILE_LOG("[Run] GameAssembly.dll not found — injected too early or wrong process.");
        return;
    }

    init_il2cpp(hGameAssembly);
    if (!AttachIl2Cpp()) return;
    DetourInitilization();

    hUnloadEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!hUnloadEvent) { LogError("Unload Event could not be created!"); return; }

    HANDLE hThread = CreateThread(nullptr, 0, UnloadWatcherThread, hUnloadEvent, 0, nullptr);
    if (hThread) CloseHandle(hThread);

#if !defined(_DEBUG)
    hSecurityThread = CreateThread(nullptr, 0, SecurityWatcherThread, nullptr, 0, nullptr);
    if (hSecurityThread) CloseHandle(hSecurityThread);
#endif

    HANDLE hBridgeThread = CreateThread(nullptr, 0, IpcBridgeThread, nullptr, 0, nullptr);
    if (hBridgeThread) CloseHandle(hBridgeThread);
}
```

### 2c. Clean up main.h

Remove `Load`, `FreeVersionLibrary` declarations. Remove `hGameAssembly` extern
(it becomes a local in Run, or stays as a file-static if other code references it).

### 2d. Delete proxy files

- Delete `internal/src/bootstrap/version.cpp`
- Delete `internal/src/bootstrap/version.h`
- Delete `internal/defs/version.def`
- Remove `#include "version.h"` from dllmain.cpp

**Verification:** `msbuild /p:Configuration=Debug /p:Platform=x64` — must
compile with 0 errors. Run `check-raw-access.sh` — must exit 0.

---

## Step 3 — Update the vcxproj

### 3a. Rename output from `version` to `realm-engine`

In `il2cpp-dll-injection.vcxproj`, for both Debug|x64 and Release|x64:
```xml
<TargetName>realm-engine</TargetName>
```

Output becomes `realm-engine.dll` + `realm-engine.pdb`.

### 3b. Remove the .def file reference

Remove from the `<Link>` sections:
```xml
<!-- DELETE these lines -->
<ModuleDefinitionFile>defs\version.def</ModuleDefinitionFile>
```

Remove from `<ItemGroup>`:
```xml
<!-- DELETE -->
<None Include="defs\version.def" />
```

### 3c. Remove `_VERSION` from preprocessor defines

In Debug|x64 `<PreprocessorDefinitions>`:
```
BEFORE: _DEBUG;...;_VERSION;IL2CPPDLL_EXPORTS;...
AFTER:  _DEBUG;...;IL2CPPDLL_EXPORTS;...
```

In Release|x64:
```
BEFORE: NDEBUG;...;_VERSION;IL2CPPDLL_EXPORTS;...
AFTER:  NDEBUG;...;IL2CPPDLL_EXPORTS;...
```

### 3d. Remove Win32 platform configurations

Delete all `Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'"` and
`Release|Win32` property groups, item definition groups, and the
`<ProjectConfiguration>` entries. This removes the dead manual-injector
code path entirely.

### 3e. Update OutDir

The OutDir currently points to `$(SolutionDir)..\client\assets\` which
was correct for version.dll (the client bundled it from assets/). With
external injection, the DLL doesn't ship in assets. Change to:
```xml
<OutDir>$(SolutionDir)x64\$(Configuration)\</OutDir>
```

Or keep the assets dir if we still want the client to find it for the
injector to reference. Decision: keep `$(SolutionDir)..\client\assets\`
for now — the injector will reference this known location.

**Verification:** Build both Debug and Release x64. Output is
`client/assets/realm-engine.dll`. No linker errors about missing .def.

---

## Step 4 — Client-side injector integration

### 4a. Create `client/src/native/injector.ts`

```typescript
// injector.ts — Spawns the native injector exe to inject the DLL into
// a running RotMG process.

import { execFile } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { Logger } from '../util/Logger.js';

export interface InjectResult {
  ok: boolean;
  error?: string;
}

/**
 * Inject a DLL into a running process.
 * @param pid Target process ID
 * @param dllPath Absolute path to the DLL to inject
 * @param injectorPath Path to injector.exe (defaults to assets/injector.exe)
 */
export function injectDll(
  pid: number,
  dllPath: string,
  injectorPath: string,
): Promise<InjectResult> {
  return new Promise((resolve_p) => {
    if (!existsSync(injectorPath)) {
      resolve_p({ ok: false, error: `Injector not found: ${injectorPath}` });
      return;
    }
    if (!existsSync(dllPath)) {
      resolve_p({ ok: false, error: `DLL not found: ${dllPath}` });
      return;
    }

    execFile(
      injectorPath,
      [String(pid), dllPath],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve_p({ ok: false, error: `Injector failed: ${err.message}` });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim()) as InjectResult;
          resolve_p(result);
        } catch {
          resolve_p({ ok: false, error: `Bad injector output: ${stdout}` });
        }
      },
    );
  });
}
```

### 4b. Update `client/src/index.ts`

Replace the entire version.dll deploy block (lines ~186-269) with:
- Store `dllPath` = `resolve(assetsDir, 'realm-engine.dll')`
- Store `injectorPath` = `resolve(assetsDir, 'injector.exe')`
- Remove all `copyFileSync` / `resolveInternalVersionDllPath` / deploy logic
- Remove `ClientDataConfig.internalVersionDllPath` and `skipVersionDllDeploy`
- The injection happens later, when the game is launched (not at client startup)

### 4c. Update `DevServer.ts` — inject on game launch

In `launchGame()` and `launchGameWithCredentials()`, after spawning the
game process:

1. Get the child PID from `spawn()` return
2. Poll for `GameAssembly.dll` to be loaded in the target process (the
   injector can do this internally, or the client can poll via tasklist)
3. Call `injectDll(pid, dllPath, injectorPath)`
4. Log success/failure
5. On success, the DLL's `Run()` fires, connects via named pipe — the
   existing `InternalBridge` handles the rest

The BootGate named event (`Local\LFGInternalHelloReady`) is no longer
needed on the DLL side. The client can still use it for its own packet
sniffer synchronization if needed, but the DLL doesn't wait on it.

### 4d. Update `client/src/native/hello-event.js`

The BootGate signal is still useful for the connection sniffer to tell
the client "the game reached in-realm." Keep the named event for that
purpose, but remove it from the DLL's startup path (already done in Step 2).

**Verification:** `npx tsc --noEmit` — no type errors. Start the client,
launch the game, confirm injection happens and the DLL connects via pipe.

---

## Step 5 — Build pipeline updates

### 5a. Update `dev-build.bat`

- Change `BUILT_DLL` path from `version.dll` to `realm-engine.dll`
- Add injector build step (compile `tools/injector/injector.cpp`)
- Deploy both `realm-engine.dll` and `injector.exe` to `client/assets/`
- **Remove** the step that copies version.dll to the game folder — the
  injector handles loading at runtime, no file needs to be in the game dir

### 5b. Update `build-local.bat`

- Update references from `version.dll` to `realm-engine.dll`
- Ensure injector.exe is built alongside the DLL

### 5c. Update `wsl-build.sh`

- Update the output DLL name check from `version.dll` to `realm-engine.dll`

### 5d. Remove old deploy references

- `client/data/config.json`: remove `internalVersionDllPath` if present
- `client/src/index.ts`: remove `resolveDefaultDevInternalDll()` and all
  version.dll resolution logic
- `client/src/index.ts`: remove `ClientDataConfig` version-dll fields

**Verification:** Run `build-local.bat` — should produce `realm-engine.dll`
and `injector.exe` in `client/assets/`, no copy to game folder. The client
should inject on launch.

---

## Step 6 — Clean up dead code and update docs

### 6a. Remove all `_VERSION` references

Grep for `_VERSION` across the entire codebase:
```bash
command grep -rn "_VERSION" internal/src/ --include="*.cpp" --include="*.h"
```
Remove any remaining `#ifdef _VERSION` / `#endif` blocks.

### 6b. Update CLAUDE.md

- Update "Preprocessor defines" section: remove `_VERSION` row
- Update "Startup flow" diagram: remove Load() → BootGate path
- Update "Proxy DLL" section: replace with note about external injection
- Update "Deployment" section: describe injector-based deployment
- Update source layout: note version.cpp/h are deleted

### 6c. Update `internal/CLAUDE.md`

Same updates as above for the internal-specific docs.

### 6d. Clean up `defs/` directory

If `version.def` was the only file in `defs/`, remove the directory.

**Verification:** Full build (DLL + client). `check-raw-access.sh` passes.
No references to `version.dll` remain except in git history. Grep:
```bash
command grep -rn "version\.dll" internal/ client/src/ --include="*.cpp" --include="*.h" --include="*.ts" --include="*.bat"
```
Should return zero hits (or only comments/docs explaining the migration).

---

## Step 7 — NewTick packet-driven injection trigger

The client's packet proxy already intercepts all game traffic. Instead of
the injector polling for modules or arbitrary delays, the client triggers
injection when it sees the **first NewTick packet** — that's the definitive
signal that the game is fully loaded, the player is in-realm, and the game
loop is actively ticking. IL2CPP is guaranteed initialized at this point.

The injector becomes dead simple: just PID + DLL path, inject immediately.
No `--wait-module`, no `--wait-delay`, no polling. All timing intelligence
lives in the client where the packet data is.

Flow:
```
Client launches game → gets PID from spawn()
  → Proxy intercepts traffic via winhttp.dll redirect
  → First NewTick packet arrives
  → Client calls injectDll(pid, dllPath, injectorPath)
  → injector.exe injects immediately
  → DLL loads → Run() → hooks + IPC bridge
```

The `Local\LFGInternalHelloReady` named event (BootGate) is deleted entirely.
All `LFG` legacy naming is purged from the codebase.

---

## Execution order

Steps 1-3 are DLL-side (C++), steps 4-5 are client-side (TS), step 6 is cleanup.

**Phase A (DLL-side):** Steps 1 → 2 → 3 — build the injector, strip the
DLL, update vcxproj. After this phase, the DLL builds as `realm-engine.dll`
with no proxy exports, and `injector.exe` can inject it.

**Phase B (Client-side):** Steps 4 → 5 → 7 — integrate injector into client,
update build scripts, add readiness polling. After this phase, the full
pipeline works: client launches game → waits → injects → DLL connects.

**Phase C (Cleanup):** Step 6 — remove dead code, update docs.

Phases A and B can be developed in parallel if working in separate branches.
Phase C depends on both.

## Risk notes

- **Antivirus interference:** `CreateRemoteThread` + `VirtualAllocEx` is a
  well-known injection pattern. Windows Defender may flag `injector.exe`.
  Mitigation: sign the exe, or add an exclusion in the build docs.
- **Elevated privileges:** Injecting into a process may require admin rights
  or SeDebugPrivilege. The game runs as the current user, so same-user
  injection should work without elevation on most configurations.
- **Game process detection:** The client needs the game PID. `spawn()` returns
  it directly for credential launches. For manual launches (user starts game
  themselves), the client needs to poll for `RotMG Exalt.exe` by name.
- **Hot reload:** With external injection, we can support unloading (existing
  `FreeLibraryAndExitThread` path) and re-injecting without restarting the
  game. This is a future enhancement, not part of this plan.
