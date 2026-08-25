# 15 — Client: consolidate the plugin boundary (`PluginContext` facade + de-dup `UserPluginContext`)

## Goal
The built-in plugin API surface is a defined facade, not a grab-bag of direct
`src/` imports, and the duplicated `UserPluginContext` (runtime impl vs
hand-maintained SDK type) is reduced to one authored definition. After this plan:
(1) the SDK-facing `UserPluginContext` type is derived from the runtime class
instead of hand-copied, so they cannot drift; (2) the internal modules built-in
plugins reach into (proxy, state, bridge, packets) are re-exported through a
single `plugins/api.ts` barrel, so the boundary is visible and greppable even
though it stays permissive. Behavior is unchanged — this is an import-surface
refactor, not a capability change.

## Dependencies
Depends on **12** (feature keys) — plugins import `sendDllFeature` which plan 12
retypes; do 12 first so the barrel re-exports the typed version. Coordinate with
**14** (also edits some plugins). Touches `client/src/plugins/**`,
`client/packages/sdk/src/UserPluginContext.ts`, and the import lines of
`client/plugins/*.ts`.

## Current state
### `UserPluginContext` duplicated and divergent
- `src/plugins/UserPluginContext.ts` — 177-line runtime implementation.
- `packages/sdk/src/UserPluginContext.ts` — 98-line, type-only, hand-maintained
  SUBSET. They drift silently (the SDK copy is smaller and updated by hand).

### Built-in plugins bypass any facade — direct `src/` internals
~30 built-in `client/plugins/*.ts` import deep internals. Enumerate:
```
grep -rn "^import .*from '\.\./src/" client/plugins
```
Known reach-throughs: `spoof-push-tiles.ts:2` → `game-data/GameDataLoader`;
`rollback.ts:2`, `socket.ts:2`, `glow.ts:2`, `ip-connect.ts:2`, `safe-walk.ts` →
`proxy/ClientConnection`; `auto-loot/loot-rules.ts:7`, `bags.ts:8` →
`state/GameWorldState`; `bags.ts:9` → `constants/StatType`; `socket.ts:3` →
`util/RuntimeScheduler`; 12 plugins → `bridge/DllFeatureBus`; plus
`src/packets/Packet`, `src/native/rotmg-shared`, `src/damage-sniffer/*`.
`ctx.hookPacket` is called at 98 sites with raw packet-name strings.

## Target design
This is a **visibility + de-duplication** plan, NOT a lockdown. The built-in
plugins are first-party and legitimately need proxy/state access; the goal is to
route that access through one named surface so it is greppable and stable.

1. **De-dupe `UserPluginContext`:** make `packages/sdk/src/UserPluginContext.ts`
   a type derived from the runtime class rather than a hand copy. If the SDK
   package can import the runtime type (check tsconfig paths), use
   `export type UserPluginContext = import('...').UserPluginContext` or move the
   interface into the SDK and have the runtime class `implements` it. If it
   cannot import across the package boundary, define the interface ONCE in the
   SDK and have `src/plugins/UserPluginContext.ts` `implements` it — the compiler
   then enforces they match. Pick based on the package graph; the invariant is
   "one authored declaration, the other checked against it."

2. **Barrel for built-in plugin internals:** create `client/plugins/api.ts`
   re-exporting exactly what built-in plugins are allowed to use:
   ```ts
   export type { PluginContext } from '../src/plugins/PluginContext.js';
   export type { ClientConnection } from '../src/proxy/ClientConnection.js';
   export type { GameWorldState, TrackedEntity } from '../src/state/GameWorldState.js';
   export { sendDllFeature } from '../src/bridge/DllFeatureBus.js';    // typed via plan 12
   export type { DllFeatureKey } from '../src/bridge/contract.js';
   export { StatType } from '../src/constants/StatType.js';
   export { RuntimeScheduler } from '../src/util/RuntimeScheduler.js';
   export type { Packet } from '../src/packets/Packet.js';
   // … the full allowed set, gathered from the grep above …
   ```
   Then rewrite each `plugins/*.ts` import to come from `./api.js` (or
   `./api/…`). This does not remove any capability; it makes the boundary one
   file, so future tightening (or a lint rule) has a single seam.

**Ownership:** `plugins/api.ts` is the built-in-plugin contract; `PluginContext`
stays the runtime object. No new runtime indirection — barrels are erased at
build.
**Non-goal:** do NOT try to force built-in plugins onto the restricted
`@realmengine/sdk` (community) surface — they intentionally have more access.

## Steps
1. De-dupe `UserPluginContext` (one authored declaration + `implements` check).
   `cd client && npm run build`.
2. Create `client/plugins/api.ts` re-exporting the full allowed internal set
   (derive the list from `grep -rn "from '\.\./src/" client/plugins`). Build.
3. Mechanically rewrite plugin imports: `from '../src/<x>.js'` → `from './api.js'`
   for every symbol the barrel re-exports. Do it in batches by plugin, building
   after each batch. Leave any import the barrel does NOT cover as-is and ADD it
   to the barrel (report the additions — they widen the known surface).
4. `cd client && npm run build` (full) + `cd packages/protocol && npm test`.

## Verification
- `cd client && npm run build` succeeds; protocol tests pass.
- `grep -rn "from '\.\./src/" client/plugins | grep -v '/api'` → empty (every
  internal import goes through the barrel) OR a short reported list of
  deliberately-excluded deep imports.
- `packages/sdk/src/UserPluginContext.ts` no longer hand-duplicates members:
  it either re-exports or the runtime class `implements` it (a member added to
  one now fails the build if missing from the other — verify by temporarily
  adding a method to the runtime class and confirming a type error).

## Out of scope
- Converting built-in plugins to the community SDK surface.
- The 98 `hookPacket` raw packet-name call sites (packet-name typing is the dual
  packet-stack concern — deferred; see `00-overview.md`).
- Adding an ESLint `no-restricted-imports` rule (no ESLint config exists in-repo;
  a future guardrail can add one — noted in overview, not built here).
