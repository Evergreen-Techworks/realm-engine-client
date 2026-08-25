# 12 — Client: shared DLL-bridge contract module (`packages/protocol` or `src/bridge/contract`)

## Goal
After this plan there is ONE TypeScript source of truth for the DLL↔client
bridge contract — the pipe name, handshake key, protocol version, message-`type`
strings, and the 107 `sendDllFeature` feature-key names — instead of raw string
literals scattered across `InternalBridge.ts`, `DllFeatureBus.ts`, and ~170
plugin call sites. Feature keys become a typed union so a typo is a compile
error, not a silent no-op. This is a client-only refactor; the C++ side
(`FeatureCommandRegistry`) is unchanged, and the emitted wire strings are
byte-identical, so the DLL keeps working.

## Dependencies
None on the internal plans (different language/tree). Parallel-safe against all
internal plans (01–11). Touches `client/src/bridge/**` and every
`client/plugins/*.ts` that calls `sendDllFeature` — coordinate with plan 14
(plugin boundary) which also edits plugins: **merge 12 before 14**.

## Current state
Three uncentralized, string-matched surfaces (client side):
- **Pipe / handshake / version:** `src/bridge/InternalBridge.ts:34`
  (`'\\\\.\\pipe\\lfg-dev-bridge'` — comment `:26-27` says it must byte-match
  `BuildSecrets.h` in the DLL), handshake key literal `:48`, protocol version
  `'bridge-v3'`/`3` at `:511`.
- **Message `type` strings:** inline in the `handleMessage` switch
  `InternalBridge.ts:471-504` (`hello`, `authResult`, `heartbeat`,
  `heartbeatResp`, `player`, `hotkeyEvent`, `unresolvedClasses`) and
  `getSignedFields` `:304-345` (`clearTiles`, `noWalkInit`, `tileUpdate`,
  `setFeature`). Each must match a hand-written builder in the DLL
  (`internal/src/core/ipc/IpcMessages.cpp` — e.g. `hotkeyEvent` at
  `IpcMessages.cpp:61`).
- **Feature keys:** `sendDllFeature('<key>', value)` — 107 distinct keys, ~170
  call sites, all raw literals in plugins. Enumerate:
  ```
  grep -rhoE "sendDllFeature\('[a-zA-Z0-9]+'" client/plugins client/src | sort -u
  ```
  These must match the 152 `FeatureCommand::Is("...")` keys in
  `internal/src/features/control/FeatureCommandRegistry.cpp` (the DLL consumer).

## Target design
Create `client/src/bridge/contract.ts` (or `packages/protocol/src/bridge-contract.ts`
if you want it importable by muling-headless — but InternalBridge lives in
`src/`, so `src/bridge/contract.ts` is the lower-friction home):

```ts
// Single source of truth for the DLL bridge wire contract. MUST byte-match the
// C++ side: pipe/version in DebugInternal BuildSecrets.h; message types in
// internal/src/core/ipc/IpcMessages.cpp; feature keys in
// internal/src/features/control/FeatureCommandRegistry.cpp.
export const BRIDGE = {
  DEV_PIPE_NAME: '\\\\.\\pipe\\lfg-dev-bridge',
  PROTOCOL_VERSION: 3,
  PROTOCOL_TAG: 'bridge-v3',
} as const;

export const DllMessageType = {
  Hello: 'hello', AuthResult: 'authResult', Heartbeat: 'heartbeat',
  HeartbeatResp: 'heartbeatResp', Player: 'player', HotkeyEvent: 'hotkeyEvent',
  UnresolvedClasses: 'unresolvedClasses', SetFeature: 'setFeature',
  ClearTiles: 'clearTiles', NoWalkInit: 'noWalkInit', TileUpdate: 'tileUpdate',
} as const;
export type DllMessageType = typeof DllMessageType[keyof typeof DllMessageType];

// The 107 feature keys, grouped by family for readability. Exhaustive — the
// union below drives sendDllFeature's type.
export const DLL_FEATURE_KEYS = [
  'autoAimEnabled','autoAimMode','autoAimIgnoreWalls','autoAimPrioritizeBosses',
  'autoAbilityEnabled','autoAbilityMpPct','autoAbilityWizardMode',
  /* … all 107, copied verbatim from the grep above … */
] as const;
export type DllFeatureKey = typeof DLL_FEATURE_KEYS[number];
```

Then:
- `DllFeatureBus.ts`: change `sendDllFeature(key: string, …)` →
  `sendDllFeature(key: DllFeatureKey, …)`. The union makes every plugin
  call-site typecheck against the canonical list.
- `InternalBridge.ts`: import `BRIDGE`/`DllMessageType`; replace the literals at
  `:34`, `:48`, `:304-345`, `:471-504`, `:511` with the constants.

**Ownership:** `contract.ts` is the client's mirror of the C++ contract. Add a
header comment naming the two C++ files so the next game-patch editor updates
both. **This plan does NOT unify across the language boundary** (no codegen from
a shared schema) — that is a larger effort; here we centralize the TS side and
document the C++ counterpart, which removes the 170-site duplication and gives
compile-time key checking.
**Divergence to verify:** diff the client's 107 keys against the DLL's
`FeatureCommand::Is(...)` set. The DLL has ~152 `Is()` calls (some keys handled
in groups). List any key the client sends that the DLL does NOT handle (dead
send) or vice-versa (unreachable feature) in the PR description — do NOT delete
either side; report for a human decision (behavior-preserving).

## Steps
1. Create `src/bridge/contract.ts` with `BRIDGE`, `DllMessageType`, and the full
   `DLL_FEATURE_KEYS` array (paste the grep output; keep every key). Typecheck:
   `cd client && npm run build`.
2. `src/bridge/DllFeatureBus.ts`: import `DllFeatureKey`, narrow `sendDllFeature`
   / `DllFeatureSender` signatures to it. Build — this will surface any plugin
   passing a key not in the list (fix by adding the real key to the array, since
   the DLL must already handle it; note it).
3. `src/bridge/InternalBridge.ts`: replace the pipe/version/handshake/message-type
   literals with `BRIDGE.*` / `DllMessageType.*`. Build.
4. Optional mechanical polish: replace `sendDllFeature('camera…'` literals in
   plugins with `sendDllFeature(DllFeatureKey…)` — NOT required (the union already
   type-checks string literals), so skip unless trivial. Build.
5. `cd client && npm run build` (full) + `cd packages/protocol && npm test`.

## Verification
- `cd client && npm run build` succeeds (root `tsc` + `build:sdk`).
- `cd packages/protocol && npm test` passes (hello/shootack roundtrips).
- `grep -rn "'\\\\\\\\\\.\\\\pipe\\\\lfg-dev-bridge'" client/src | grep -v contract.ts`
  → empty (pipe name only in contract.ts).
- `grep -rn "sendDllFeature(key: string" client/src` → empty (signature narrowed).
- Feature-key drift report attached to the PR (client-vs-DLL key diff).

## Out of scope
- The C++ `FeatureCommandRegistry` / `IpcMessages` — untouched (a future
  cross-language codegen plan may unify them; not here).
- Electron main↔renderer channels and dashboard WS message types — plan 13.
- Changing any emitted wire value (must stay byte-identical).
