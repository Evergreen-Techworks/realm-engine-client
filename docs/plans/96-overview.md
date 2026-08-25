# 96 — Overview: whole-system streamlining (internal/ + client/)

## What this is

A second architecture pass over **both halves** of realm-engine-client, run after
Phases 1–3 (plans 80–95: offset reliability, killaura/autofire/auto-break-walls,
udodge tuning) landed. The first program (plans 00–29) gave the C++ primitives a
home (`Mem::`, `Il2CppC::`, `Il2CppHook::`, `RuntimeOffsets`, `Game::` views) and
centralized the TS side of the bridge contract (`src/bridge/contract.ts`). This
pass finds what those programs **left unfinished or newly broke**, plus the
cross-language seams nobody owns.

Every plan below is behavior-preserving unless its title says otherwise. Exactly
one plan (105) intentionally changes behavior, and it exists specifically so that
change is a decision rather than a side effect of a refactor.

## How the system works (the model these plans assume)

Two processes, one named pipe, plus a file-drop dev channel.

### `internal/` — the injected C++ DLL (`realm-engine.dll`, 223 source files)

- **Injection**: the client's packet proxy sees the first NEWTICK, then runs
  `client/assets/injector.exe` (CreateRemoteThread + LoadLibraryW). IL2CPP is
  guaranteed initialized at that point.
- **Bootstrap**: `DllMain` → `Run()` thread (`src/bootstrap/main.cpp`) →
  `init_il2cpp` → `AttachIl2Cpp` → `DetourInitilization()` (MS Detours on
  `IDXGISwapChain::Present`) → `IpcBridgeThread` + `UnloadWatcherThread`.
- **Per-frame spine** = `dPresent` (`src/platform/hooks/DirectX.cpp`):
  `RuntimeOffsets::EnsureAll()` → `BootGate::Tick()` → `GameState::Tick()` →
  `LocalPlayer::Tick()` → feature `::Tick(menuOpen)` → ImGui.
- **State ownership**: `RuntimeOffsets` owns field offsets (fallback + live
  self-heal + per-offset health state); `GameState` owns AppMgr/WorldMgr/local
  pointers; `LocalPlayer` caches local stats; `EnemyTracker` owns the per-frame
  enemy snapshot; `FeatureState` owns IPC-delivered feature values;
  `FeatureRuntime::ApplyOverrides()` applies them once per frame.
- **Hooks**: MS Detours for Present only. Everything else is MinHook, installed
  lazily per feature. `Il2CppHook::` owns method resolution + `MH_CreateHook`,
  but **each feature still hand-rolls `MH_Initialize` and its own
  `MH_DisableHook`/`MH_RemoveHook` teardown** (plan 100).
- **Egress**: `core/ipc/` (named pipe, length-prefixed JSON) and
  `core/runtime/DiagBridge` (`%LOCALAPPDATA%\RealmEngine\diag.json`, read by
  `internal/tools/re-mcp/server.mjs`).

### `client/` — the Electron/TypeScript app

- **Proxy stack**: `src/proxy/` (MITM on 2050) + `src/packets/` (data-driven
  reader/writer from `data/packet-definitions.json` →
  `src/packets/packetDefinitions.generated.ts`), driving ~29 plugins in
  `client/plugins/` through `PluginContext`.
- **Realmlib stack (separate, disjoint)**: `packages/protocol` +
  `packages/core` → `muling-headless/`. Class-based packets, own packet map from
  `scripts/sync-packet-map.mjs`. Nothing in `src/` imports it.
- **DLL bridge**: `src/bridge/InternalBridge.ts` is the pipe **server** (the DLL
  is the client). `contract.ts` holds the pipe name, protocol version, message
  types, and the `DLL_FEATURE_KEYS` union. `DllFeatureBus` sends
  (`sendDllFeature`), `DllThreatBus` / `DllAimBus` receive and decode.
- **Dashboard**: `src/dashboard/server/DevServer.ts` (WebSocket to
  `dashboard/public/app.js`) also calls `internalBridge.setFeature(...)`
  **untyped**, bypassing the `DllFeatureKey` union
  (`DevServer.ts:2897`).

### The contract between them

Four hand-maintained, hand-mirrored surfaces:

| Surface | C++ home | TS home |
|---|---|---|
| Pipe name / protocol version | `IpcBridge.cpp:19`, `IpcMessages.cpp:19` | `contract.ts:23-27` |
| Message `type` strings | `IpcMessages.cpp` builders | `contract.ts:37-49` |
| Threat wire payload | `IpcMessages.cpp:64-118` (`EncodeThreats`) | `DllThreatBus.ts:91-153` (`decodeThreatPayload`) |
| Aim wire payload | `IpcMessages.cpp:125-137` (`EncodeAim`) | `DllAimBus.ts:77-120` (`decodeAimPayload`) |
| Feature keys | `FeatureCommandRegistry.cpp` FH_* tables | `contract.ts:58-94` `DLL_FEATURE_KEYS` |

Round-trip tests for the threat and aim payloads **exist** at
`client/src/bridge/__tests__/` — but `vitest` is not installed anywhere in the
repo, `client/package.json` has no `test` script, `client/tsconfig.json:16`
excludes `src/**/__tests__/**`, and `.github/workflows/ci.yml` runs neither
tests nor typecheck. **The guardrail written for the most drift-prone surface in
the system has never executed.** That is plan 97, and it is the single highest
payoff item here.

## Target architecture (the seams this program adds)

| Seam | Where | What it owns |
|---|---|---|
| Runnable bridge test suite | `client/vitest.config.ts`, `client/package.json` | Executing the existing wire-format round-trips on every change + in CI |
| Feature-key drift checker | `client/scripts/check-bridge-contract.mjs` | Failing when `FeatureCommandRegistry.cpp` and `contract.ts` disagree |
| `Il2CppHook::EnsureRuntime` / `UninstallMinHook` | `internal/src/platform/hooks/Il2CppHook.h` | The MinHook init + teardown half of the hook lifecycle (install already lives there) |
| `GameClasses::Resolve` | `internal/src/game/symbols/GameClasses.h/.cpp` | ONE cached, BeeByte-alias-aware class-resolution policy |
| `Movement::TileSensor` | `internal/src/features/movement/sensors/TileSensor.h/.cpp` | Tile key packing, finiteness, hazard memo, `IsHazardAt`, `CanOccupy` shared by 4 dodge modes |
| `Game::Entity::TryPos` etc. | `internal/src/game/objects/GameObjects.h` | Completing plan 26's abandoned wrapper adoption for the hottest offsets |

## Full plan list

| # | Plan | Side | Kind | Behavior |
|---|------|------|------|----------|
| 97 | bridge-contract-tests-runnable | **TS** | foundation | preserving |
| 98 | feature-key-contract-guard | **TS** | guardrail | preserving |
| 99 | retire-dead-tile-ipc | **BOTH** | deletion | preserving (dead code) |
| 100 | hook-lifecycle-consolidation | **C++** | foundation + sweep | preserving |
| 101 | game-class-resolution-registry | **C++** | foundation + sweep | preserving (one fix flagged) |
| 102 | movement-tile-sensor-shared | **C++** | dedup | preserving |
| 103 | game-object-view-adoption | **C++** | OO layer sweep | preserving |
| 104 | build-tooling-and-dead-code-hygiene | **C++ + tooling** | cleanup | preserving |
| 105 | failclosed-gate-coverage | **C++** | **BEHAVIOR CHANGE** | changes behavior — decisions required |

## BUILD HAZARD — read before dispatching

`internal/tools/wsl-build.sh` writes to a **shared** `C:\rebuild\<Config>`
directory. **Two C++ implementers cannot build at the same time.** Plans marked
**C++** or **BOTH** must be dispatched **one at a time**. Plans marked **TS** are
parallel-safe against everything, including each other and against a running C++
build.

## Dependency graph

```
TS TRACK (fully parallel with the C++ track and with each other)
  97  bridge-contract-tests-runnable      ── no deps
  98  feature-key-contract-guard          ── SHOULD follow 97 (reuses the test runner
                                             it installs); can stand alone if 97 slips

C++ TRACK (serialized by the shared C:\rebuild build directory, in this order)
  99  retire-dead-tile-ipc                ── no content deps; also edits contract.ts
                                             (coordinate with 97/98 — see below)
  100 hook-lifecycle-consolidation        ── no content deps
  101 game-class-resolution-registry      ── AFTER 100 (both edit ProjectileTracking.cpp,
                                             AoeTracking.cpp)
  103 game-object-view-adoption           ── AFTER 101 (both edit ProjectileTracking.cpp,
                                             WorldTAB.cpp)
  102 movement-tile-sensor-shared         ── no content deps; slot anywhere in the C++ queue
  104 build-tooling-and-dead-code-hygiene ── AFTER 100 and 101 (removes includes those
                                             plans may still need)
  105 failclosed-gate-coverage            ── LAST. Requires a human decision per site;
                                             do not merge with any other plan.
```

Recommended dispatch waves:

- **Wave A (now, in parallel):** 97 (TS agent) ‖ 99 (C++ agent).
  99 touches `client/src/bridge/contract.ts` lines 45–47 only; 97 touches
  `package.json`, a new `vitest.config.ts`, and test files. No overlap.
- **Wave B:** 98 (TS agent) ‖ 100 (C++ agent).
- **Wave C:** 101 (C++), then 102 (C++), then 103 (C++) — strictly serial.
- **Wave D:** 104 (C++).
- **Wave E:** 105 (C++, after a decision on each divergence).

## Global verification commands

C++ side (run from repo root; **only one agent at a time**):

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Client side (run from `client/`; parallel-safe):

```bash
npx tsc --noEmit -p tsconfig.json          # expect: exit 0, no output
npm test                                   # after plan 97 installs it
node scripts/check-bridge-contract.mjs     # after plan 98
```

## Divergence bugs found (each has an owning plan)

1. **`followEntityActive` / `followEntityName` are dead.**
   `client/plugins/auto-follow.ts:23-24,45,49` sends them; the DLL's
   `FeatureCommandRegistry.cpp` has **no handler**, and unknown keys are
   deliberately swallowed (`FeatureCommandRegistry.cpp:9-10`). The plugin's
   docblock claims the DLL feeds `DangerPlanner::SetExternalGoal`; nothing does
   (`grep -rn SetExternalGoal internal/src` shows only TestTAB callers). Owner:
   plan 98 (detects + documents). The fix (delete the plugin or implement the
   handler) is deliberately **not** in scope of any plan here — it needs a
   product decision.

2. **`WorldTAB` resolves the projectile class with a weaker policy than
   `ProjectileTracking`.** `WorldTAB.cpp:277` does a bare
   `Resolver::FindClassLoose("HBEAKBIHANL")`; `ProjectileTracking.cpp:47-77` and
   `ProjectileTrajectory.cpp:41-51` first scan the BeeByte alias map for the
   readable name `"Projectile"` and only then fall back to the obfuscated
   literal. After the next rename, dodging keeps working and the projectile ESP
   silently goes blank. Owner: plan 101 (unifies onto the stronger policy).

3. **`RuntimeOffsets::IsFieldWriteTrusted` is applied at 2 of 8 float-write
   sites.** Plan 80/81 added the fail-closed write gate precisely because a
   wrong float offset writes *successfully* onto another valid float.
   `ProjectileTracking.cpp:610` and `PlayerCollider.cpp:93` use it;
   `AimHooks.cpp:126-127` (`Shot_Angle`, `Player_FacingAngle`) and
   `TestTAB.cpp:802-805` (`PosX`, `PosY`, `KJ_Float3Pos`) do not. Owner: plan 105.

4. **`BootGate::FeatureAllowed` is called by 3 of ~15 features, and its table
   has 2 rows nobody reads.** `BootGate.cpp:40-46` registers `AutoNexus` and
   `SafeWalk`; `grep -rn 'FeatureAllowed(' internal/src` finds callers only in
   `ProjectileTracking.cpp:367`, `AoeTracking.cpp:859`, `AutoFire.cpp:101`.
   Owner: plan 105.

5. **`Il2CppHook.h:14` documents `Resolver::FindClassLoose` as
   "BeeByte-rename proof".** It is not — `Il2CppResolver.cpp:340-352` is a plain
   `strcmp` over the class table with no alias pass. This comment is the likely
   cause of divergence #2. Owner: plan 101 (corrects the comment).

## What was considered and deliberately NOT unified

See the "Out of scope" section of each plan, plus this list:

- **A "feature module" base class / mixin for `KillAura` / `AutoFire` /
  `AutoBreakWalls` / `PlayerCollider`.** The shared shape is real but shallow:
  an enable atomic, a `Tick()`, a `RenderSettings()`, a 30-second liveness log,
  and transition-only edge logging. Everything with actual logic in it differs.
  A base class would remove ~15 lines per module and add a virtual/CRTP
  indirection into the render-thread hot path, plus a new place for lifecycle
  bugs to hide. `CombatTAB::Tick` is already a 5-line dispatch
  (`CombatTAB.cpp:23-42`) — there is no dispatch boilerplate to remove either.
  **Verdict: leave alone.**
- **A shared throttled-log helper.** The `if (now - s_lastXLogMs >= 30000ULL)`
  pattern appears 6 times (`AutoFire.cpp:77,105,118`, `KillAura.cpp:122`,
  `AutoBreakWalls.cpp:154`, `BagLooter.cpp:187` — the last with a 5000 ms
  window). ~4 lines each; a helper saves ~20 lines net of a new header.
  **Verdict: not worth a plan.**
- **Merging `client/data/packet-definitions.json` with
  `client/packages/protocol/src/generated/packet-map.ts`.** Both cover the same
  live Exalt build and their **packet IDs agree everywhere they overlap** (170
  vs 183 IDs; verified: zero ID conflicts). Only 22 human-readable *names*
  differ (`VAULTCONTENT` vs `VAULT_UPDATE`, `UNKNOWN164` vs
  `CLAIM_MISSION_RESULT`, …) and the two stacks are consumed by disjoint code
  (`src/proxy/**` vs `muling-headless/**`). Unifying means rewriting one of two
  working protocol implementations for zero runtime benefit.
  **Verdict: leave alone; the risk is naming confusion, not drift.**
- **Consolidating the five dodge implementations (`xdodge`, `zdodge`, `repp`,
  `pjdodge`, `udodge`).** All five are user-selectable modes with different
  tuning; the solver math is explicitly out of scope for this pass. Only their
  *sensor* layer is unified (plan 102).
- **Codegen for the IPC wire schemas.** A generator that emits both the C++
  encoder and the TS decoder from one description would eliminate drift by
  construction, but it is a large build-system change against two payloads that
  each have one encoder and one decoder. Running the existing round-trip tests
  (plan 97) gets ~90% of the protection for ~5% of the work. Revisit if a third
  payload type appears.
- **JSON string escaping in `IpcMessages` / `IpcJson`.**
  `BuildHotkeyEvent`/`BuildUnresolvedClasses` interpolate `%s` into JSON without
  escaping, and `IpcJson::GetString` (`IpcJson.cpp:18-32`) stops at the first
  raw `"` without unescaping. Every value that actually crosses today is an
  IL2CPP identifier or a validated plugin id
  (`FeatureRuntime.cpp:265` `IsPluginHotkeyIdSafe`), so nothing can currently
  trigger it. **Verdict: defer; note it here so the next person adding a
  free-text field knows.**
