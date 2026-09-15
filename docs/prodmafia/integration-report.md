# ProdMafia integration validation and owner handoff

## Scope and provenance

2026-09-15. Isolated `feat/prodmafia-integration` starts at `9d316adbbd0c4e2250907e85987595477de32bd7`. Local reviewed source branches are merged, not copied wholesale. No main/dirty-client edits, push, deployment, PR, Windows source mirror, owner-process termination or portable build.

- Startup reviewed tip `1d51ae7`: Tasks 0–3 code implemented. Merge `2453bdc`.
- Shooting reviewed tip `6c69711`: Task 8 evidence schema, Task 9 safe readiness isolation, Task 10 synthetic validator prerequisites only. Merge `592ac62`.
- Connection reviewed tip `e66f0ca`: Tasks 4–7, including authoritative RECONNECT after unknown rejection. Merge `5bdd185`. AutoNexus started from its parent `319008f`; merge ancestry preserves this follow-up separately.
- AutoNexus reviewed tip `20bacc06db60346a0fad301b6049fa4056db2549`: Tasks 11–13 code and Task 14 observation handoff. Merge `1906b0b7d581db7ddb811e7c3587c37161335f11`. No conflicts on any merge; all four source tips are ancestors.

Task 10's captured-current-game acceptance remains incomplete. This report does not equate synthetic tests with measured weapon cadence or server acceptance. Predictive AutoNexus activation and Windows/gameplay evidence remain separate gates.

## Existing behavior improved, not a second product

| Existing path | Integrated change | Runtime ownership |
| --- | --- | --- |
| `index.ts` parallel metadata/plugins awaited together before listeners | Mandatory `startServices` awaits plugin registration/profile/watcher only; metadata acquisition runs separately and is cancelled on shutdown | Same entrypoint, PluginManager, proxy and DLL pipe; exactly one optional metadata job |
| PluginManager swallowed registration failure and returned void | Loaded/failed report, awaited asynchronous registration, degraded dashboard status | Same discovered plugins/configuration/profile; no replacement plugin set |
| Damage Sniffer parsed-object handoff | Preserved single `takeParsedObjects` / `loadFromParsedObjects` initialization while optional metadata completes later | Same scaling instance and history; no invented enchantments parser |
| ClientConnection upstream retries and raw HELLO | Reviewed bounded silent-close retry, admission classification and lifecycle fencing | ClientConnection remains sole upstream socket/retry owner; game-side cipher continuity preserved |
| SDK Portal.enter() sent immediately | Existing method checks current session/queue/attempt state; additive status projection | Same portal and SDK surface, no independent route/reconnect loop |
| Native script firing through AppEngine update and SWA | SWA readiness independent of unverified manual-angle routine; caches reset correctly | Existing native cadence/bursts/patterns remain game-owned; no second timer or speed formula |
| Existing AutoNexus plugin with local escaped latch/resend interval | Same plugin now requests ESCAPE through shared client recovery; internal bounded evidence compares confirmed HP and pending hits | Old plugin ESCAPE timer/latch/direct sender removed; one forecast-observation interval remains, confirmed-health authority unchanged; predictions observe only |

## Validation

Selected-base baseline after locked offline dependencies and SDK declaration generation: **42 files / 375 client tests passed**, both TypeScript checks passed, bridge contract **173 DLL / 154 client-sendable / 21 DLL-only / 2 known-unhandled**, packet drift passed. Native baseline passed; see `baseline.md`.

Initial startup-plus-shooting merge: **48 files / 408 client tests passed**, both typechecks passed. Integrated native runner passed: AoE 52, temporal 24, admission 30, speed/expiry 90, commitment 12, timed escape 35, pruning 80000, pathing 29, enemy tracker 60, autofire 79, input focus 29; navigation regressions passed; scenarios 29 asserted / 3 known limitations. Standalone shooting readiness: 30 checks, zero failures.

Final complete integration at `1906b0b`: **58 files / 523 tests passed** (baseline 42 / 375, no failures); SDK generation, both typechecks, bridge 173/154/21/2 and packet drift pass. All new tests are discovered by the existing Vitest patterns; no skipped captured-acceptance suite is used to claim coverage. `git diff --check` and tracked/untracked worktree status are clean before adding this report. Source and fixture review finds no new real credentials or raw capture traces; HELLO loopback data uses explicit synthetic ACCESS-TOKEN/USER-TOKEN placeholders. No marketplace/API/bot/navigation/script-package file is changed.

Final integrated native rerun also exits 0 with the same counts listed above, including separate readiness30 and autofire79. Commands: `npm run build:sdk`, `npm test`, `npm run typecheck`, `npm run typecheck:tests` from client; `python3 internal/tests/run_udodge_zone_tests.py` and `c++ -std=c++17 -Wall -Wextra -I internal/src internal/tests/shoot_binding_readiness_tests.cpp -o /tmp/prodmafia-integration-readiness && /tmp/prodmafia-integration-readiness` from repo root. Logs: `/tmp/prodmafia-validation/integration/final-{sdk,client,types,test-types,native}.txt`.

### Reversible mutations

Each exact patch is applied only in this integration worktree, run against the corresponding regression, then reversed by shell EXIT trap. No mutation is committed. Logs under `/tmp/prodmafia-validation/integration/mutation-*.txt`.

| Mutation | Coverage | Result |
| --- | --- | --- |
| Treat queue position zero as loaded | Production admission reducer and real loopback connection suite | Expected failure, exit 1 |
| Accept stale-generation escape request | Production RecoveryCoordinator | Expected failure, exit 1 |
| Reset game-side RC4 during upstream reconnect | Production ClientConnection, real loopback sockets | Expected failure, exit 1 |
| Await optional metadata again | Production entrypoint wiring assertion plus separately tested deferred readiness seam | Expected failure, exit 1; not an Electron launch |
| Discard all pending damage on explicit HP | Production HealthEvidence plus plugin adapter regressions | Expected failure, 5 assertions fail, exit 1 |
| Permit predictive sends in the default observation mode | Production existing AutoNexus plugin default/migration tests | Expected failure, 4 assertions fail, exit 1 |
| Couple SWA readiness back to manual CSA | Production C++ readiness helper | Expected failure, exit 1 |
| Change unknownShort during PLAYERSHOOT serialization | Real PacketFactory with explicitly synthesized input | Expected failure, exit 1; not captured cadence evidence |

## Shipping gates and limitations

- **Manual diagnostic autofire now fails closed** because the existing manual-angle binding has not been semantically verified. Ordinary game input is not disabled. Do not promise manual diagnostic autofire restoration before verifying its callable identity/calling convention or a separately proven replacement path.
- Six current-pin native/script shooting capture pairs remain missing (ordinary, mixed-rate, burst, pattern cycling, enchanted rate, switching during burst), along with reviewed grouping/counts/tolerance/field semantics and server outcomes. The synthetic trace validator does not satisfy those gates.
- Shooting source passed three translation-unit MSVC `/Zs` checks on its source branch. This is syntax-only, not a linked DLL or in-game binding/cadence proof. Integration requires a real native build before delivery.
- Startup has no measured saving. Collect five cold-cache, warm-cache and offline-mirror before/after samples using an isolated test cache and the correlated process-local readiness logs; see `startup-measurements.md`. Do not subtract clocks from different processes.
- Current-game full/refusal/error mapping and real queue/admission/rejoin acceptance remain unverified. No ActionScript error numbers are treated as current Exalt authority. Unknown FAILURE is forwarded unchanged; a subsequent real RECONNECT remains authoritative and is redirected through the proxy.
- Prediction must remain observation-only pending current-game evidence and explicit activation authorization. Do not claim guaranteed survival.
- Observation state is bounded (4096 evidence entries, latest snapshot per client and at most 32 recovery transitions). No automatic raw-packet capture or file exporter is added; use reviewed sanitized evidence collection, not existing key-logging debug channels.
- Prior navigation `fd3c301`, Oryx/script liveness/item-use `b61e113` ancestry, marketplace/API/bot/site changes and legacy-DLL launch work are **not** part of this ProdMafia integration. They require a separately reviewed next-portable integration step.

## Future build handoff, not executed

1. Select the final combined portable branch and resolve shared native/SDK files against their actual bases; preserve local-only Windows build-source files. Review every prospective changed file using `git diff --name-only 9d316adbbd0c4e2250907e85987595477de32bd7 <reviewed-integration-tip>` plus its per-file diff, not directory mirroring.
2. Verify live game/pinned collection hashes and current build pipeline provenance. Compile integrated SDK/TypeScript and linked native DLL, respecting all release gates.
3. Run isolated gameplay checks for startup/profile order, both queue-positive and queue-zero admission, cancellation/server replacement/stale keys, native shooting/manual-fail-closed behavior and observation-only AutoNexus diagnostics.
4. Build one private portable only after owner-authorized selective Windows copying. Verify built-source inclusions, artifact SHA-256 and update-run evidence. Do not upload, notify or deploy.

## Exact implementation file set

Relative to fixed base9d316ad, before adding this report; this is an audit inventory, not permission to overwrite Windows files:

```text
client/electron/main.cjs
client/packages/sdk/src/index.ts
client/packages/sdk/src/types/connection.ts
client/packages/sdk/src/types/world/Portal.ts
client/packages/sdk/src/world/World.ts
client/plugins/api.ts
client/plugins/auto-nexus.ts
client/plugins/auto-nexus/healthEvidence.ts
client/plugins/auto-nexus/hitLedger.ts
client/src/bridge/InternalBridge.ts
client/src/dashboard/public/app.js
client/src/dashboard/public/index.html
client/src/dashboard/public/ws-message-types.js
client/src/dashboard/server/DevServer.ts
client/src/dashboard/wsMessageTypes.ts
client/src/index.ts
client/src/packets/__tests__/fixtures/shooting/README.md
client/src/packets/__tests__/helpers/shootingTrace.ts
client/src/packets/__tests__/shootingCadenceReplay.test.ts
client/src/plugins/PluginManager.ts
client/src/plugins/__tests__/pluginLoadReadiness.test.ts
client/src/proxy/ClientConnection.ts
client/src/proxy/ConnectionAdmission.ts
client/src/proxy/Proxy.ts
client/src/proxy/ReconnectHandler.ts
client/src/proxy/RecoveryCoordinator.ts
client/src/proxy/__tests__/admissionRecovery.loopback.test.ts
client/src/proxy/__tests__/connectionAdmission.test.ts
client/src/proxy/__tests__/fixtures/admission/README.md
client/src/proxy/__tests__/fullServerRetry.test.ts
client/src/proxy/__tests__/recoveryCoordinator.test.ts
client/src/scripts/bridge/world/World.ts
client/src/scripts/bridge/world/WorldObjectService.ts
client/src/scripts/bridge/world/__tests__/portalAdmission.test.ts
client/src/startup/__tests__/metadataEnrichment.test.ts
client/src/startup/__tests__/startServices.test.ts
client/src/startup/__tests__/startupAvailability.test.ts
client/src/startup/metadataEnrichment.ts
client/src/startup/startServices.ts
client/src/util/__tests__/autoNexusForecast.test.ts
client/src/util/__tests__/autoNexusForecastReplay.test.ts
client/src/util/__tests__/autoNexusHealthEvidence.test.ts
client/src/util/__tests__/autoNexusObservation.test.ts
client/src/util/__tests__/autoNexusPredictive.test.ts
client/src/util/__tests__/autoNexusRecovery.test.ts
client/src/util/__tests__/ensureRotmgMetadataXml.test.ts
client/src/util/__tests__/helpers/autoNexusFixture.ts
client/src/util/ensureRotmgMetadataXml.ts
docs/prodmafia/autonexus-observation.md
docs/prodmafia/baseline.md
docs/prodmafia/shooting-evidence.md
docs/prodmafia/startup-measurements.md
internal/src/features/combat/autoaim/modes/AutoFire.cpp
internal/src/features/combat/autoaim/modes/AutoFireDecision.h
internal/src/features/combat/autoaim/shoot/AimHooks.cpp
internal/src/features/combat/autoaim/shoot/AimHooks.h
internal/src/features/combat/autoaim/shoot/ShootBindingReadiness.h
internal/src/features/combat/autoaim/shoot/ShootRuntime.cpp
internal/src/features/combat/autoaim/shoot/ShootRuntime.h
internal/tests/autofire_decision_tests.cpp
internal/tests/shoot_binding_readiness_tests.cpp
```
