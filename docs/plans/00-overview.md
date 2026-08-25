# 00 — Overview: Encapsulating the Realm Engine client

## What this is
An architecture-refactor program that gives the realm-engine-client's
cross-cutting concerns a **home**. The codebase grew feature-by-feature: game
memory is read with raw pointer arithmetic at ~90 sites, the same pointer-check
is copy-pasted 14 times, IL2CPP container layouts are re-declared in four files,
hook installs are hand-rolled per feature, and the client-DLL contract lives as
raw strings duplicated across ~170 call sites in two languages. Each plan below
introduces (or extends) one small, well-owned layer and migrates consumers onto
it **without changing behavior**. Every step compiles and runs; behavior changes
(the two real divergence bugs) are called out explicitly and never smuggled into
a refactor.

## How the system works (the model these plans assume)
Two processes, one shared contract.

**`internal/` -- the C++ IL2CPP-injection DLL (`realm-engine.dll`, ~37k LOC).**
- **bootstrap/**: `DllMain` -> `Run()` thread on `DLL_PROCESS_ATTACH`.
  External `injector.exe` (CreateRemoteThread + LoadLibraryW) injects the DLL
  on the first NEWTICK packet seen by the client's packet proxy, guaranteeing
  IL2CPP is fully initialized. `Run()` calls `init_il2cpp` (resolves the IL2CPP
  API from `GameAssembly.dll` via `DO_API` macros) -> `AttachIl2Cpp` ->
  `DetourInitilization` (installs the `IDXGISwapChain::Present` detour via
  MS Detours).
- **Per-frame spine** = `dPresent` (`platform/hooks/DirectX.cpp`), the hooked
  Present. Each frame, in order: `RuntimeOffsets::EnsureAll()` (self-healing
  field-offset table) -> `BootGate::Tick()` (gates feature installs until offsets
  are healthy) -> `GameState::Tick()` (resolves AppMgr->WorldMgr->localPlayer) ->
  `LocalPlayer::Tick()` (caches local HP/MP/pos) -> feature `::Tick(menuOpen)` ->
  ImGui render. IL2CPP method hooks (AutoAim, ProjectileTracking, AoeTracking,
  ...) install lazily via **MinHook** once metadata is up.
- **State ownership:** `RuntimeOffsets` owns field offsets (fallback + live
  self-heal, the thing that breaks on game patches); `GameState` owns the
  AppMgr/WorldMgr/local pointers; `LocalPlayer` is the cached local-player
  distributor; `EnemyTracker` owns the per-frame enemy snapshot. These are the
  **partial abstractions that already exist and work** -- the internal plans grow
  the layer *beneath* them (raw reads, container walks, hooks) rather than
  reinventing them.
- **Egress:** `core/ipc/` (named pipe `\\.\pipe\lfg-dev-bridge`, length-prefixed
  JSON), and `core/runtime/DiagBridge` (file-drop diagnostics under
  `%LOCALAPPDATA%\RealmEngine\`, readable from WSL / the diag MCP server).

**`client/` -- the Electron/TypeScript app (~46k LOC).**
- **Proxy stack:** `src/proxy/` (a MITM on game port 2050) + `src/packets/`
  (KRelayBetter-derived reader/writer, packet defs generated from `data/*.json`)
  drives ~30 built-in plugins in `client/plugins/` via `PluginContext`
  (`hookPacket`, world state, `sendDllFeature`).
- **Realmlib stack (separate):** `packages/core` + `muling-headless` use
  `packages/protocol` (its OWN reader/writer/RC4/packet-map) -- a second,
  independent protocol implementation for headless muling.
- **Bridges:** `src/bridge/InternalBridge.ts` (client end of the DLL pipe),
  `src/bridge/DllFeatureBus.ts` (`sendDllFeature(key,value)` -> 88 keys the DLL's
  `FeatureCommandRegistry` consumes), Electron `main.cjs`<->`preload.cjs` IPC, and
  the dashboard WebSocket (`DevServer.ts`<->`public/app.js`).
- **The cross-language contract** (pipe name, message `type`s, 88 feature keys,
  ConditionEffect/StatType/ClassId tables) is duplicated by hand on both sides --
  the biggest client-side gap.

## Target architecture (the seams)
Facades and registries over primitives -- no deep inheritance. Objects encapsulate
"how do I read/talk to concept X" so features stop naming primitives.

Internal (C++):
- `Mem::` (`core/runtime/MemRead.h`) -- the one SEH-safe pointer-check +
  typed-offset-read primitive. Replaces 14 `AddrOk` copies and ~90 raw reads.
- `Il2CppC::` (`core/il2cpp/Il2CppContainers.h`) -- the one home for .NET
  container layouts + `WalkDict`/`ListItems`/`ReadString`. Replaces 4 copies.
- `Il2CppHook::` (`platform/hooks/Il2CppHook.h`) -- method-resolve + MinHook-install
  helper + cached method resolution. Replaces 8 hand-rolled installers + 41
  scattered method lookups.
- `Game::Entity/Character/Projectile/...` (`game/objects/`) -- flat, zero-cost typed
  views on game objects, built on `Mem::` + `RuntimeOffsets::`. The
  object-oriented encapsulation layer feature code talks to instead of pairing a
  raw pointer with a raw offset key.
- `CamState` + `GameMath` -- the deduplicated per-frame camera/W2S snapshot and
  the move-speed formula.

Client (TS):
- `src/bridge/contract.ts` -- the single TS source of truth for the DLL bridge
  (pipe/version/message-types/88 typed feature keys).
- `electron/ipc-channels.cjs` + `src/dashboard/wsMessageTypes.ts` -- shared
  channel-name constants for the two intra-client boundaries.
- Canonical `StatType`/`ClassId`/`ConditionEffect`/`GAME_PORT` -- one definition
  each; the 3-4 divergent copies collapse onto them.
- `plugins/api.ts` barrel + de-duplicated `UserPluginContext` -- one visible
  plugin boundary.
- Decomposed `DevServer.ts` -- focused service modules for account management,
  game launching, fame tracking, trade sessions, and plugin config persistence.

## Full plan list
| # | Plan | Layer | Kind | Status |
|---|------|-------|------|--------|
| 01 | mem-read-primitives | `Mem::` | internal foundation | DONE |
| 02 | il2cpp-containers | `Il2CppC::` | internal foundation | DONE |
| 03 | hook-helpers | `Il2CppHook::` | internal foundation | DONE |
| 04 | migrate-combat | features/combat/** | internal consumer sweep | DONE |
| 05 | migrate-movement | features/movement/** | internal consumer sweep | DONE |
| 06 | migrate-projectiles | features/projectiles/** | internal consumer sweep | DONE |
| 07 | migrate-gui-tabs | gui/tabs/** | internal consumer sweep | DONE |
| 08 | migrate-tail | account/visuals/misc/loot + GameState | internal consumer sweep | DONE |
| 09 | camera-state-and-formulas | `CamState`/`GameMath` | internal dedup | DONE |
| 10 | game-object-wrappers | `Game::` objects | internal OO layer | DONE |
| 11 | internal-guardrails | grep gate | internal guardrail | DONE |
| 12 | client-dll-contract | `src/bridge/contract.ts` | client foundation | DONE |
| 13 | client-ipc-and-ws-channels | IPC/WS constants | client dedup | DONE |
| 14 | client-game-constants | StatType/ClassId/ConditionEffect/port | client dedup | DONE |
| 15 | client-plugin-boundary | `plugins/api.ts` + UserPluginContext | client boundary | DONE |
| 16 | guardrail-hardening | hot-loop honesty + Mem::TryWrite | internal guardrail | DONE |
| 17 | threats-message-type | centralize `threats` bridge type | internal/client | DONE |
| 18 | auto-ability-classid | auto-ability ClassId refs | internal | DONE |
| 19 | threat-channel-compact | versioned threat payload + truncation | internal/client | DONE |
| 20a | bridge-signing-removal-internal | remove DLL IPC signing | internal | DONE |
| 20b | bridge-signing-removal-client | remove client IPC signing | client | DONE |
| 21 | injection-rework | external injector.exe | internal/client | DONE |
| 22 | ipcbridge-shim-retirement | retire FeatureState forwards | internal cleanup | TODO |
| 23 | shared-memory-retirement | remove dead SharedMemory | internal cleanup | TODO |
| 24 | camera-offset-centralization | CameraTAB -> RuntimeOffsets | internal migration | TODO |
| 25 | playertab-offset-centralization | PlayerTAB -> RuntimeOffsets | internal migration | TODO |
| 26 | game-wrapper-adoption | Game:: wrapper sweep | internal OO layer | TODO |
| 27 | il2cpp-method-cache | centralized method resolution | internal foundation | TODO |
| 28 | devserver-decomposition | extract DevServer services | client refactor | TODO |
| 29 | internal-guardrail-update | new ratchet checks | internal guardrail | TODO |

## Dependency graph (what runs in parallel)
```
INTERNAL (plans 22-27, 29)
  22  IpcBridge shim retirement         (parallel-safe)
  23  SharedMemory retirement           (parallel-safe)
  24  CameraTAB offset centralization   (parallel-safe)
  25  PlayerTAB offset centralization   (parallel-safe, minor merge on RuntimeOffsets with 24)
  26  Game:: wrapper adoption           (after 25 ideally; parallel-safe otherwise)
  27  IL2CPP method cache               (after 24 ideally; parallel-safe otherwise)
  29  Guardrail update                  (after 24, 25, 26, 27)

CLIENT (plan 28)
  28  DevServer decomposition           (parallel-safe, independent of all internal plans)
```

Parallel-safe dispatch waves:
- **Wave E (parallel):** 22, 23, 24, 25, 28
  All touch disjoint file sets (22=IpcBridge/FeatureCommandRegistry,
  23=SharedMemory/InitHooks/DirectX, 24=CameraTAB/RuntimeOffsets,
  25=PlayerTAB/RuntimeOffsets, 28=DevServer).
  Plans 24 and 25 both extend RuntimeOffsets -- if dispatched together,
  the later merge resolves trivial append conflicts.
- **Wave F (behind E):** 26 (behind 25), 27 (behind 24)
  Plan 26 migrates features to Game:: wrappers after PlayerTAB offsets
  are centralized. Plan 27 migrates features to cached method resolution
  after CameraTAB methods are cached.
- **Wave G (behind F):** 29
  Adds guardrail checks that codify the encapsulation from plans 24-27.

CLIENT plans (28) can dispatch fully independently of INTERNAL plans
(different language/tree).

## Global verification commands
Internal (C++ / VS2022 toolset v145):
```
bash internal/tools/wsl-build.sh Debug   # WSL compile -> Debug build
bash internal/tools/wsl-build.sh Release # Release (requires BuildSecrets.h)
internal/build-and-test.bat              # native Windows
bash internal/tools/check-raw-access.sh  # grep ratchet, must exit 0
```
PREREQ: the ~94 MB generated IL2CPP headers must be present in
`internal/src/game/generated/` (gitignored; regenerate per SETUP.md).

Client (runs in WSL/Linux):
```
cd client && npm run build                    # build:sdk (tsc) + root tsc, strict
cd client/packages/protocol && npm test       # vitest: roundtrips
cd client/packages/core && npm test           # vitest --passWithNoTests
node --check client/electron/main.cjs && node --check client/electron/preload.cjs
```

## Divergence bugs (behavior changes -- decide, don't smuggle)
1. **`AddrOk` bounds (internal) -- RESOLVED in plan 01/16.**
   Canonical: `> 0x10000 && < 0x7FFFFFFFFFFFULL`.
2. **`ClassId` missing 784 (client) -- RESOLVED in plan 14/18.**
   Canonical: include 784 (Priest).
3. **PlayerTAB Defense field (plan 25 -- NEW).**
   RuntimeOffsets uses `HODJPKFINKF` (MapObject base, fallback 0x210).
   PlayerTAB uses `NNECFGPDBEE` (Player subclass, fallback 0x508 = dump
   0x4B8 + 0x50 ACTK). These may resolve to the same runtime value if the
   self-healing lookup succeeds, but the field names differ. When unifying,
   verify that `RuntimeOffsets::Defense` reads the same value as
   PlayerTAB's `g_fields.def`. If they diverge, the Player-level field
   (`NNECFGPDBEE`) should be added as a separate `PlayerDefense` entry in
   RuntimeOffsets.

## Deferred (explicitly out of scope of this program)
- **Unifying the two client packet + RC4 stacks** (`src/packets` vs
  `packages/protocol`). They are two independent implementations for two runtimes
  (Electron proxy vs headless muling), with independently generated ID maps that
  can drift after a game patch. Merging them is a large, behavior-sensitive
  effort deserving its own design spike -- not a mechanical sweep.
- **Cross-language codegen** of the DLL contract (generating the C++
  `FeatureCommandRegistry` keys and the TS `contract.ts` from one schema). Plan
  12 centralizes the TS side and documents the C++ counterpart; true single-source
  codegen is future work.
- **The two Logger implementations** (`src/util/Logger.ts` vs
  `packages/core/.../logger.ts`) and 56 empty `catch{}` blocks -- real cleanup,
  but orthogonal to the encapsulation goal; defer.
- **SDK `StatusEffect` string enum** reconciliation with the `ConditionEffect`
  index map -- a public community-facing surface; plan 14 cross-references but does
  not merge it.
- **Resolver::FindClass centralization** -- while 48 direct `Resolver::` calls
  remain in features/gui, these are class lookups (not method lookups) that are
  legitimately needed at their call sites. Unlike method resolution which benefits
  from caching, class resolution is already cached by the IL2CPP runtime itself.
- **WorldTAB raw reads** -- WorldTAB is a diagnostic inspector that inherently
  needs to walk arbitrary memory. Its 28 reinterpret_casts include 6 that are
  marked `raw-access-ok` (hot-loop tile sweeps) and the rest are diagnostic
  pointer arithmetic. Wrapping these in Game:: would not add safety.
- **SpeedHack PE parsing** -- SpeedHack's 23 reinterpret_casts are PE header
  parsing (IMAGE_DOS_HEADER, IMAGE_NT_HEADERS, IAT thunks). These are Windows
  binary interop, not game-data reads, and cannot use Game:: wrappers.
