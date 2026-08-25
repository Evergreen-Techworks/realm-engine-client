# 14 — Client: unify duplicated game constants (StatType, ClassId, ConditionEffect, port 2050)

## Goal
Each game-data constant family has ONE authoritative TypeScript definition that
all consumers import: `StatType`, `ClassId`, `ConditionEffect`, and the game
port `2050`. The 3–4 divergent hand-copies of each — including a **live-bug
divergence in ClassId (missing class 784)** — are collapsed onto the canonical
source. Because two of these copies currently DISAGREE, this plan states which
value is correct and treats the correction as an explicit, reviewed change, not
a silent refactor.

## Dependencies
None on internal plans. Parallel-safe against 12/13. Touches
`client/src/constants/**`, `client/packages/core/src/core/**`, and consumer
sites across `src/` and `plugins/` — coordinate with plan 15 (plugin boundary)
if both edit the same plugin; **either order works, but avoid concurrent edits to
`plugins/anti-debuffs.ts` and `plugins/auto-nexus.ts`** (both touched here).

## Current state
### StatType — 3 copies + 1 partial
- `src/constants/StatType.ts` — full enum (canonical for the proxy app;
  `HasBackpack:75`, `BackpackTier:130`).
- `src/packets/statTypes.generated.ts` — generated from `data/stat-types.json`
  (this is the string-stat metadata table, NOT the id enum — keep; it is
  generated, not hand-copied).
- `packages/core/src/core/rotmg-stat-types.ts` — partial HAND copy; its header
  `:1-4` warns of a past `HasBackpack 75 vs 79` drift. **This is the risky
  duplicate.**
- `plugins/anti-debuffs.ts:44-45` re-declares `STAT_EFFECTS=29`,
  `STAT_EFFECTS2=95` locally.

### ClassId — 2 copies, DIVERGENT (live bug)
- `src/constants/ClassId.ts` — 17 classes, **OMITS 784**.
- `packages/core/src/core/rotmg-class-ids.ts:5` `PLAYER_CLASS_TYPE_IDS` — 18 ids,
  **includes 784**.
Any "is this object a player?" check using `src/constants/ClassId.ts` misses
class 784. **Canonical: include 784** (the `packages/core` list is correct — 784
is a real player class). See `00-overview.md` Divergence bugs.

### ConditionEffect — 4 representations
- `src/constants/ConditionEffect.ts` — bit indices (`Effects[1]` = index−31).
- `packages/sdk/src/types/entities/StatusEffect.ts` — string enum, a DIFFERENT
  set (adds `CURSED`/`PETRIFIED`/`EXPOSED`, lacks the immune variants).
- `plugins/anti-debuffs.ts:49-69` — raw hex bitmasks hand-mapped to indices.
- `plugins/auto-nexus.ts:240-284` — string names via
  `PlayerData.hasConditionEffect` (`src/state/PlayerData.ts:178`).

### Port 2050 — ~15 hardcodes
`src/index.ts:479`, `src/proxy/Proxy.ts:49`, `ReconnectHandler.ts:219`,
`CoreCommands.ts:71,77`, `DevServer.ts:1946`, `scripts/bridge/events/index.ts:512,522`
(+ `winhttp-proxy/src/connect_hook.cpp` `kGamePort` — C++, leave it).

## Target design
- **StatType:** make `src/constants/StatType.ts` the single id enum. Replace the
  hand copy `packages/core/src/core/rotmg-stat-types.ts` with a re-export of the
  canonical enum IF the packages build graph allows importing `src/` (it likely
  does NOT — `packages/core` is a standalone package). If it cannot import `src/`,
  the correct fix is: move the canonical enum INTO `packages/core` (or a shared
  `packages/`), and have `src/constants/StatType.ts` re-export it. Decide by
  checking `packages/core/package.json` deps and `tsconfig` paths. Whichever
  becomes canonical, the OTHER becomes a one-line re-export. Replace
  `anti-debuffs.ts:44-45` locals with `StatType.Effects` / `StatType.Effects2`.
- **ClassId:** add 784 to `src/constants/ClassId.ts` (the correction), then make
  `packages/core/rotmg-class-ids.ts` and `src/constants/ClassId.ts` share one
  list (same re-export decision as StatType). **Call out the 784 addition in the
  PR — it changes player-detection behavior (intended fix).**
- **ConditionEffect:** the index map `src/constants/ConditionEffect.ts` is
  canonical for the proxy/plugin runtime. `anti-debuffs.ts`'s hex bitmasks must
  be derived from it (`1 << ConditionEffect.Quiet`, etc.) rather than
  hand-written. The SDK `StatusEffect` string enum is a SEPARATE
  community-facing surface — do NOT merge it into the index map, but add a
  comment cross-referencing the canonical indices and reconcile the missing
  entries in a follow-up (note divergence; do not silently change the SDK enum's
  public members).
- **Port:** add `export const GAME_PORT = 2050;` to `src/constants/GameId.ts`
  (already the well-centralized constants home) and replace the TS hardcodes.

## Steps
1. `src/constants/ClassId.ts`: add class 784; reconcile with
   `packages/core/rotmg-class-ids.ts` (one canonical list, other re-exports).
   Build. **Flag the 784 behavior change.**
2. StatType: pick canonical location, make the other a re-export; replace
   `anti-debuffs.ts:44-45` locals. Build.
3. `ConditionEffect`: derive `anti-debuffs.ts:49-69` hex masks from
   `ConditionEffect` indices; leave SDK `StatusEffect` as-is with a cross-ref
   comment. Build.
4. Add `GAME_PORT` to `GameId.ts`; replace the ~8 TS `2050` literals (leave the
   C++ `kGamePort`). Build.
5. `cd client && npm run build` + `cd packages/core && npm test` +
   `cd packages/protocol && npm test`.

## Verification
- `cd client && npm run build` succeeds; `packages/core` and `packages/protocol`
  tests pass.
- `grep -rn '\b784\b' client/src/constants/ClassId.ts` → present (bug fixed).
- `grep -rn 'STAT_EFFECTS\s*=\s*29\|STAT_EFFECTS2\s*=\s*95' client/plugins` → empty.
- `grep -rn '\b2050\b' client/src | grep -v GameId.ts` → empty (or only comments).
- PR notes the 784 player-detection change explicitly.

## Out of scope
- The `.generated.ts` files (regenerated from `data/*.json`) — do not hand-edit;
  they are outputs.
- Merging the SDK `StatusEffect` string enum into the index map (separate public
  surface; note the divergence, defer the reconciliation).
- The C++ `kGamePort` in winhttp-proxy.
- The two RC4 / packet stacks — plan 15.
