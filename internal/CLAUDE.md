# CLAUDE.md — realm-engine-client / internal

Guidance for Claude Code (claude.ai/code) when working in the C++ IL2CPP
injection layer (`internal/`).

## Project overview

`internal/` is a Visual Studio 2022 C++ project that produces `realm-engine.dll` —
a DLL externally injected into RotMG Exalt by a standalone `injector.exe`
(CreateRemoteThread + LoadLibraryW). The client's packet proxy triggers
injection on the first NEWTICK packet, guaranteeing IL2CPP is fully initialized.
Once loaded the DLL hooks IL2CPP methods and `IDXGISwapChain::Present` to run
the in-game hack overlay and autonomy features.

External reverse-engineering material — Il2CppInspectorPro dumps, notes
from Flash/bot-client research, decompiled headers — lives under
`internal/refs/` and is `.gitignore`d. It is read-only reference context;
active development is entirely in `src/`.

## Build

Open `il2cpp-dll-injection.sln` in Visual Studio 2022 (toolset `v145`).
The two active configurations are x64:

| Configuration | Defines | Output | Use for |
|---|---|---|---|
| `x64 \| Debug` | `_DEBUG` | `x64/Debug/realm-engine.dll` | Local dev — spawns a Win32 console for `std::cout`, `SecurityWatcherThread` is a no-op. |
| `x64 \| Release` | (+ LTCG) | `x64/Release/realm-engine.dll` | Ship builds — anti-debug active, no console. |

MSBuild CLI equivalent:

```
msbuild il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64
```

`build-and-test.bat` (repo root of `internal/`) is the fast local wrapper.

## Preprocessor defines

| Define | Effect |
|---|---|
| `_DEBUG` | Opens a Win32 console for log output and disables `SecurityWatcherThread` (which otherwise unloads the DLL if a debugger / x64dbg / Scylla-hide is detected). |

## Source layout

The project is organised by concern under `src/`:

```
src/
├── bootstrap/           DllMain and main entry
│   ├── dllmain.cpp      DLL entrypoint — spawns Run() thread on DLL_PROCESS_ATTACH
│   ├── main.cpp/.h      Run() — init_il2cpp → AttachIl2Cpp → DetourInitilization
│
├── core/                Cross-cutting infrastructure — no game-feature logic here
│   ├── config/          Persistent settings (settings.h/.cpp) and keybinds (keybinds.h/.cpp)
│   ├── il2cpp/          PCH (pch-il2cpp.h) + IL2CPP API resolver (il2cpp-init.cpp)
│   ├── ipc/             Bridge to the Electron client (handshake, framing, JSON, tile state)
│   ├── logging/         DBG_FILE_LOG macro + Debug console helpers
│   ├── runtime/         BootGate, DiagBridge, GameState, LocalPlayer,
│   │                    RuntimeOffsets, Il2CppResolver
│   └── security/        xorstr for compile-time string hiding
│
├── features/            Feature families — one folder per family
│   ├── account/         Char select + credential/HWID capture surface
│   ├── combat/          autoability, autoaim, autonexus, enemytracker, ghostHit
│   ├── control/         Input-side control logic
│   ├── loot/            Autoloot rules and inventory automation
│   ├── misc/            One-offs that don't warrant their own family
│   ├── movement/        collider, dodge, noclip, pjdodge, repp, speedhack, zdodge
│   ├── projectiles/     ProjectileStore, ProjectileRuntimeReader, ProjectileTrajectory
│   ├── runtime/         Feature-runtime plumbing shared by combat/movement tabs
│   └── visuals/         Cosmetic overlays and tile visualisation
│
├── game/                Game-specific data — regenerated per Exalt build
│   ├── generated/       IL2CPP headers from Il2CppInspectorPro (NOT COMMITTED — see SETUP.md)
│   ├── math/            Game-math helpers (projectile parity, positional math)
│   └── symbols/         BeebyteName.h — obfuscated ↔ readable class/field alias map
│
├── gui/                 ImGui rendering
│   └── tabs/            One folder or pair per tab (WorldTAB, CameraTAB, PlayerTAB, CombatTab, VisualsTAB, TestTAB)
│
└── platform/            OS / renderer glue
    ├── dx11/            Dx11 helpers (Dx11.cpp/.h)
    └── hooks/           InitHooks (Detours+MinHook lifecycle) and DirectX.cpp (dPresent)
```

Include paths (x64 configs): `src` is the include root — headers are referred
to by their subpath (e.g. `#include "core/runtime/RuntimeOffsets.h"`,
`#include "gui/tabs/PlayerTAB.h"`). PCH is `src/core/il2cpp/pch-il2cpp.h`
(built by `pch-il2cpp.cpp`).

**Raw access is forbidden in `features/` and `gui/`.** Read game memory through
`Mem::` (`core/runtime/MemRead.h` — the one SEH-safe pointer-check + typed
offset read), walk .NET containers through `Il2CppC::`
(`core/il2cpp/Il2CppContainers.h`), install method hooks through `Il2CppHook::`
(`platform/hooks/Il2CppHook.h`), and prefer the typed `Game::` object views
(`game/objects/`) over pairing a raw pointer with a raw offset. Do **not**
re-introduce a local `AddrOk`/`AddrValid` copy, an open-coded
`reinterpret_cast<…>(ptr + RuntimeOffsets::…)` read, a private dict/array
layout constant, or a bare `MH_CreateHook` in feature/GUI code — those belong
only to the sanctioned homes above. `internal/tools/check-raw-access.sh`
(and its `.ps1` mirror, run by `build-and-test.bat`) is the ratchet that
enforces this; a genuinely necessary hot-loop raw read may stay only with a
same-line `raw-access-ok` comment explaining why.

## Startup flow

```
DllMain (DLL_PROCESS_ATTACH)
  └─ CreateThread → Run()                          bootstrap/main.cpp
       ├─ GetModuleHandleW("GameAssembly.dll")     guaranteed loaded (injected after NewTick)
       ├─ (Release) SecurityWatcherThread           unloads if debugger/scylla-hide is present
       ├─ init_il2cpp(hGameAssembly)               resolves IL2CPP API from GameAssembly.dll
       ├─ AttachIl2Cpp()                           attaches to IL2CPP domain/thread
       ├─ DetourInitilization()                    installs IDXGISwapChain::Present detour
       ├─ IpcBridgeThread                          named-pipe bridge to Electron client
       └─ UnloadWatcherThread                      waits on hUnloadEvent, then tears down cleanly
```

## Hook architecture

All hooks are installed / uninstalled through
`platform/hooks/InitHooks.cpp`:

- **MS Detours** (`vendor/detours/`) — used for `IDXGISwapChain::Present`.
  This is the render-thread entry point.
- **MinHook** (`vendor/minhook/`) — used for the IL2CPP method hooks
  (`ProjectileTracking`, `AutoAim`, `AoeTracking`). These install lazily
  from `dPresent` / `AutoAim::Tick()` once the game has initialised.

Teardown order in `DetourUninitialization()` is deliberate:

1. `DirectX::Shutdown()` — stops ImGui, waits for the render semaphore.
2. IL2CPP MinHook uninstalls in reverse install order
   (AoeTracking → AutoAim → ProjectileTracking).
3. `MH_DisableHook` / `MH_Uninitialize()`.
4. Detach the DXGI Present detour last.

## Render loop (`platform/hooks/DirectX.cpp`)

`dPresent` (the hooked `IDXGISwapChain::Present`) drives everything per
frame:

- **First call:** initialises ImGui (DX11 + Win32 backends), stores the
  device/context/window, applies the theme.
- **Every call:** runs feature `::Tick(bool menuOpen)` methods, then renders
  the menu if open.
- A `HANDLE` semaphore (`hRenderSemaphore`) serialises render calls against
  shutdown so we never render after teardown starts.

Menu layout (two ImGui windows plus a persistent overlay):

- `##MenuBar` — horizontal tab strip.
- `##MenuContent` — floating content panel underneath.
- Persistent bottom-right "Unload DLL" overlay.

Tab order (single source of truth is the `tabs[]` array in
`DirectX.cpp::dPresent`):

| Index | Tab | Source |
|---|---|---|
| 0 | World | `gui/tabs/WorldTAB.{h,cpp}` |
| 1 | Camera | `gui/tabs/CameraTAB.{h,cpp}` |
| 2 | Player | `gui/tabs/PlayerTAB.{h,cpp}` |
| 3 | Combat | `gui/tabs/CombatTab/CombatTAB.{h,cpp}` |
| 4 | Visuals | `gui/tabs/VisualsTAB.{h,cpp}` |
| 5 | Test | `gui/tabs/TestTAB.{h,cpp}` — diagnostics, IL2CPP explorer, offset health |

Tabs that need per-frame work (auto-aim, dodge, projectile tracking, …)
implement `::Tick(bool menuOpen)` and are called from `dPresent` regardless
of whether the menu is visible.

Menu toggle: `VK_TAB` by default. All keybinds live in
`core/config/keybinds.h` (`KeyBinds::Config` struct).

## IL2CPP interop

- `core/il2cpp/il2cpp-init.cpp` resolves every IL2CPP API function from
  `GameAssembly.dll` at startup using `DO_API` macros expanding over
  `game/generated/il2cpp-api-functions.h`.
- `game/generated/` — Il2CppInspectorPro output specific to the current
  RotMG Exalt build. **Not committed** — regenerate with the steps in the
  repo-level `SETUP.md`.
- `core/runtime/Il2CppResolver.{h,cpp}` — runtime helpers:
  `Resolver::FindClass`, `GetProperty<T>` / `SetProperty<T>`,
  `Resolver::Protection::safe_call` (SEH wrapper),
  `Resolver::FindObjectsByType`, field-value formatting for the inspector UI.

## Runtime offsets — the piece that breaks on game patches

`core/runtime/RuntimeOffsets.{h,cpp}` is a **table-driven, self-healing
IL2CPP field-offset registry**. Read that file's top comment for the full
contract; the summary is:

- Every offset variable is pre-initialised to its last known-good fallback.
- `EnsureAll()` is called once per frame from `dPresent`. For each entry it
  looks up the class by BeeByte-obfuscated name, then the field by name,
  and overwrites the fallback with the live value.
- If the class or field can't be resolved before a 5-second give-up
  timeout, the fallback stays in place and the entry is marked stale in
  the in-game **Test → OFFSET HEALTH** panel (yellow = STALE renamed,
  red = SUSPECT = read garbage).
- The BeeByte alias directory that maps obfuscated names to readable ones
  is `game/symbols/BeebyteName.h` (`Beebyte::GetMap()`).

**When the game patches, this table is the first thing to update.** See
`docs/UPDATING_AFTER_GAME_PATCH.md` for the workflow.

## Projectile system

`features/projectiles/` implements the Flash `Projectile.positionAt` model
for enemy shot prediction. Key points:

- Wavy, parametric, boomerang, amplitude, turning and laser shot types
  are all implemented.
- `ComputePosAt(proj, tMs, x, y)` is the canonical position-at-time API.
- Speed multiplier comes from `GetFlashSpeedMultiplier()` (IL2CPP field
  `KDAJOMOFMJB` on `HBEAKBIHANL` projectile instances — see
  `RuntimeOffsets.h`).
- Reference implementation for Flash-parity behaviour lives in the
  Flash client source under `refs/prodmafia/` (specifically
  `com/company/assembleegameclient/objects/Projectile.as`).

## Injection

A standalone `injector.exe` (`internal/tools/injector/injector.cpp`) injects
`realm-engine.dll` into the running RotMG Exalt process via
CreateRemoteThread + LoadLibraryW. The client's packet proxy triggers
injection on the first NEWTICK packet — at that point IL2CPP is fully
initialized and the player is in-realm.

## Deployment

Both `realm-engine.dll` and `injector.exe` are output to `client/assets/`.
The Electron client resolves them from there and handles injection
automatically — no manual file placement needed.
