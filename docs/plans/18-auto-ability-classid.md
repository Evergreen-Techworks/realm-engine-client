# 18 — auto-ability class-ID sets reference canonical ClassId

## Goal
PR #53's `auto-ability.ts` selects abilities by raw numeric class IDs
(`TARGET_CLASSES`/`SELF_CLASSES` = `new Set<number>([775, 782, ...])`). After this plan
those sets are built from the canonical `ClassId` constants (the single home from
plan 14), so they track class-ID changes instead of silently drifting. Behavior is
identical — the numeric membership of both sets is unchanged.

## Dependencies
none — parallel-safe. Touches `client/plugins/api.ts` and `client/plugins/auto-ability.ts`.
No other in-flight plan touches these (plan 16 is internal; plan 17 is bridge/).

## Current state
- `client/plugins/auto-ability.ts:19-24` —
  `const TARGET_CLASSES = new Set<number>([775, 782, 785, 798, 800, 801, 802, 803, 805, 806, 817]);`
- `client/plugins/auto-ability.ts:28` —
  `const SELF_CLASSES = new Set<number>([784, 796, 797, 799]);`
- Used at `auto-ability.ts:102-103` (`TARGET_CLASSES.has(cls)` / `SELF_CLASSES.has(cls)`).
- `client/plugins/auto-ability.ts:1` imports only `{ PluginContext, ClientConnection }`
  from `./api.js` — it does NOT import `ClassId`.
- The canonical home `client/src/constants/ClassId.ts` defines all these IDs by name
  (verified matching): Archer 775, Wizard 782, Samurai 785, Knight 798, Assassin 800,
  Necromancer 801, Huntress 802, Mystic 803, Sorcerer 805, Ninja 806, Summoner 817,
  Priest 784, Bard 796, Warrior 797, Paladin 799.
- The plugin facade `client/plugins/api.ts` currently does NOT re-export `ClassId`
  (it exports StatType, ConditionEffect, sendDllFeature, etc.).

## Target design
1. Facade: add `ClassId` to `client/plugins/api.ts` value exports:
   `export { ClassId } from '../src/constants/ClassId.js';`
2. `auto-ability.ts`: import `ClassId` from `./api.js` and rebuild the two sets by name.
   The numeric result MUST be identical — verify each ID maps to the right name:
```ts
const TARGET_CLASSES = new Set<number>([
  ClassId.Archer, ClassId.Wizard, ClassId.Samurai, ClassId.Knight, ClassId.Assassin,
  ClassId.Necromancer, ClassId.Huntress, ClassId.Mystic, ClassId.Sorcerer, ClassId.Ninja,
  ClassId.Summoner,
]);
const SELF_CLASSES = new Set<number>([
  ClassId.Priest, ClassId.Bard, ClassId.Warrior, ClassId.Paladin,
]);
```
Keep the existing explanatory comments (Rogue excluded, Trickster/Kensei omitted).

## Steps
1. `client/plugins/api.ts`: add the `ClassId` value re-export next to the other
   `../src/constants/` exports (StatType / ConditionEffect).
2. `client/plugins/auto-ability.ts`: add `ClassId` to the value import from `./api.js`
   (line 2), then replace the two numeric `Set` literals with the `ClassId.*` forms
   above. Do NOT change the comments or any other logic.
3. Verify (below).

## Verification
```
cd client && npm run build:native && npm run build
```
Success = tsc exits 0 EXCEPT the two KNOWN pre-existing `sharp` errors (see plan 17) —
no NEW errors. `ClassId` resolves and both sets typecheck.
Completion grep (must be empty — no raw class-ID Set literals remain in the file):
```
command grep -nE 'new Set<number>\(\[[0-9]' client/plugins/auto-ability.ts
```
Behavior check: the resulting sets must contain exactly {775,782,785,798,800,801,802,803,805,806,817}
and {784,796,797,799} — same as before. If any ClassId name resolves to a different
number, STOP and report (that is a ClassId divergence bug, not this plan's job to fix).

## Out of scope
Do NOT touch auto-nexus.ts (its `pd.hasConditionEffect('...')` string API is the
sanctioned PlayerData surface, not a raw-constant gap). Do NOT change ClassId.ts
values. Do NOT fix the pre-existing `sharp` tsc errors.
