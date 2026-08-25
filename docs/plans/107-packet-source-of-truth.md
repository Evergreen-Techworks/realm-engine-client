# 107 — One source of truth for packet definitions (both protocol stacks derive from one file)

## Goal

After this plan, updating the wire protocol after a RotMG game patch is a
**one-file edit plus one command**. `client/data/packet-definitions.json` becomes
the canonical description of the protocol for *both* stacks. A new
`client/scripts/gen-packet-artifacts.mjs` regenerates every derived artifact from
it — including `client/packages/protocol/src/generated/packet-map.ts`, which
until now could only be regenerated from an **out-of-repo** realmlib checkout. A
new `client/scripts/check-packet-drift.mjs`, wired into `npm test` and CI, fails
the build when any derived artifact stops matching the canonical file, or when
the canonical file itself becomes internally inconsistent.

Both stacks keep their own runtime implementation. `src/packets/` stays
data-driven; `packages/protocol/` stays class-based. **Nothing about how either
stack reads or writes bytes changes.** What is unified is the *data* they derive
from, which is where the actual double-maintenance pain lives
(`internal/docs/UPDATING_AFTER_GAME_PATCH.md:122-154` documents having to update
both by hand, and admits at `:150-151` that Layer A's "generated" file is
"kept in-sync manually").

**This is a TypeScript / tooling plan.** It never compiles the C++ DLL and is
parallel-safe against every C++ plan (99–106), including while one of them is
building.

## Dependencies

- **Plan 97 (bridge-contract-tests-runnable) SHOULD be merged first.** This plan
  wires its checker into `npm test`, which 97 creates. Verify before starting:
  `cd client && node -e "console.log(require('./package.json').scripts.test)"`.
  If there is no `test` script, add `"check:packets"` as a standalone script and
  note in the PR that it needs re-wiring once 97 lands. If `client/vitest.config.ts`
  exists and `client/node_modules/.bin/vitest` is present, 97 has landed.
- **Plan 98 (feature-key-contract-guard)** also edits `client/package.json`
  (`scripts`) and `.github/workflows/ci.yml`. These are additive one-line edits
  in the same regions. Land 98 first if it is in flight, or expect a trivial
  merge; do **not** reorder or remove 98's `check-bridge-contract` wiring.

Files this plan touches that other plans also touch:

- `client/package.json` — plans 97, 98. Add script lines only.
- `.github/workflows/ci.yml` — plan 98. Add one step only.
- `internal/docs/UPDATING_AFTER_GAME_PATCH.md` — no other plan touches it.
- `client/data/packet-definitions.json`,
  `client/src/packets/*.generated.ts`,
  `client/packages/protocol/src/generated/packet-map.ts`,
  `client/scripts/sync-packet-map.mjs` — no other plan touches these.

**Do not touch `client/scripts/build-prod.mjs`** — it is modified in the working
tree right now (uncommitted). It reads `data/packet-definitions.json` as a raw
string at `:50` and bakes it; this plan's schema additions flow through it
untouched (see "Target design → Why the extra keys are inert").

## Current state

### Two protocol stacks, disjoint consumers, one shared reality

**Layer A — `client/src/packets/`** (data-driven).
`PacketFactory` (`client/src/packets/PacketFactory.ts:47-73`) is constructed from
either `data/packet-definitions.json` (dev path — `client/src/index.ts:184-189`)
or the baked copy (prod — `client/src/config/BakedData.ts:31-45`). It builds
`definitions: Map<number, PacketDef>` and `nameToId: Map<string, number>` and
decodes by `rawBytes[4]` (`PacketFactory.ts:78`). Consumers: `src/proxy/Proxy.ts`,
`src/dashboard/server/DevServer.ts`, and ~29 plugins that compare packet names as
string literals (`'NEWTICK'` ×19, `'MAPINFO'` ×16, `'UPDATE'` ×14, `'TEXT'` ×10,
`'PLAYERSHOOT'` ×4, `'VAULTCONTENT'`, `'ENEMYSHOOT'`, `'AOE'`).
**170 packet ids.**

**Layer B — `client/packages/protocol/`** (class-based, realmlib-derived).
`PacketIO` (`client/packages/protocol/src/packetio.ts:39`) resolves ids through
`BIDIR_PACKET_MAP` from `src/generated/packet-map.ts`, then instantiates a class
from `DEFAULT_PACKET_REGISTRY` (`packages/protocol/src/packets/registry.ts:41-79`,
38 hand-written packet classes). Consumers: `packages/core/`, `muling-headless/`.
Nothing under `client/src/` imports it. **183 packet ids.**

### The generated files have no generator

`client/src/packets/packetDefinitions.generated.ts:1-2` says:

```ts
// Auto-generated from data/packet-definitions.json.
// Do not edit by hand.
```

There is no generator:

```bash
$ grep -rn 'packetDefinitions.generated' client --exclude-dir=node_modules --exclude-dir=dist
client/src/dashboard/server/DevServer.ts:61:import packetDefinitions from '../../packets/packetDefinitions.generated.js';
```

— one consumer, zero producers. The same is true of
`src/packets/packetStatus.generated.ts` (from `data/packet-status.json`),
`src/packets/packetLabNameOnly.generated.ts` (from
`data/packet-lab-name-only.json`) and `src/packets/statTypes.generated.ts` (from
`data/stat-types.json`). All four are hand-mirrored.

**CORRECTED 2026-08-24 — the original claim here ("they currently agree with
their sources (verified)") was WRONG, and executing this plan on that premise
would have silently overwritten three live files.** Only
`packetDefinitions.generated.ts` reproduces byte-identically from its JSON.
The other three have ALREADY DRIFTED, and in each case the file with a real
consumer is the one that disagrees with the JSON this plan makes canonical:

| pair | who reads which | drift |
|---|---|---|
| `stat-types.json` ↔ `statTypes.generated.ts` | **JSON is read by the live proxy** (`src/index.ts`, baked by `build-prod.mjs`); the `.ts` has ZERO importers | ids 130 and 143–155 disagree; backpack/quick-slot offset by 5 |
| `packet-status.json` ↔ `packetStatus.generated.ts` | **`.ts` is read by the dashboard** (`DevServer.ts`); JSON has no runtime reader | `.ts` 113 ids vs JSON 82; values uniformly `"needsWork"` |
| `packet-lab-name-only.json` ↔ `packetLabNameOnly.generated.ts` | `.ts` read by `DevServer.ts` (sniffer chips) | `.ts` 65 vs JSON 104; **zero contradictions** — JSON is a superset plus 3 the `.ts` has |

**RECONCILIATION DECISIONS (user-approved: "combine them all together … since
there is only one, it will be right"). Step 2b below applies these BEFORE any
generation. Do not pick a different winner.**

1. **`packet-lab-name-only`** → **UNION** of both (104 JSON entries + the 3 only
   in the `.ts` = 107). No entry contradicts another, so nothing is lost.
2. **`packet-status`** → **the `.ts` content wins** (all 113 ids). It is what the
   dashboard renders today; the JSON's 82 have no reader. Purely which ids are
   listed, so this is a no-visible-change reconciliation.
3. **`stat-types`** → **the `.ts` content wins**, because it agrees with
   `client/src/constants/StatType.ts`, which is annotated *"live capture observed
   on this client"* — empirical evidence beats an unread file.
   ⚠ **This one IS a runtime behavior change**: the live proxy currently decodes
   stats with the JSON table, so after this it decodes with the live-verified ids
   (`BackpackTier` 130, `QuickSlot0-2` 116–118, `Backpack0-15` 131–146). This is
   the intended FIX for a pre-existing bug in which backpack/quick-slot stats are
   mislabeled — it is the whole point of collapsing to one table. Call it out
   explicitly in the completion report.

After step 2b, all four `.ts` artifacts regenerate byte-identically from the
canonical JSON, and the drift checker's "regeneration is a no-op" assertion
covers all five artifacts rather than two.

### Layer B can only be regenerated from a checkout that isn't in this repo

`client/scripts/sync-packet-map.mjs:28-33`:

```js
const upstream = process.argv[2];
if (!upstream) {
  console.error('Usage: node scripts/sync-packet-map.mjs <path-to-realmlib/src>');
  console.error('Example: node scripts/sync-packet-map.mjs ../../HiveManager/HeadlessClient/realmlib/src');
```

`internal/docs/UPDATING_AFTER_GAME_PATCH.md:122-140` makes that the documented
Layer B procedure, and `:142-154` documents the separate Layer A procedure,
ending with:

> 2. Regenerate the `.ts` (whatever build step you use — currently they
>    are kept in-sync manually; if a proper generator lands, document it here).

That is the double maintenance this plan removes.

### Measured relationship between the two id→name tables

- 169 ids shared, **zero id conflicts** (no id means two different packets).
- 1 id only in Layer A: **100 = `SHOOTACK`** (`{"time": "int32"}`).
- 14 ids only in Layer B: 192, 195, 196, 197, 219, 220, 224, 232, 233, 234, 235,
  237, 239, 1000.
- **94 of 169 shared ids have different names.** 72 of those are pure spelling
  convention (Layer A `SCREAMINGNOSPACE`, Layer B `SCREAMING_SNAKE`:
  `ENTERARENA` / `ENTER_ARENA`, `FORGEREQUEST` / `FORGE_REQUEST`, …).
  **22 differ beyond underscores** — these are the real ones:

| id | Layer A | Layer B |
|---|---|---|
| 3 | `CLAIMDAILYLOGINREWARD` | `CLAIM_LOGIN_REWARD_MSG` |
| 4 | `DELETEPETMESSAGE` | `DELETE_PET` |
| 24 | `ACTIVEPETPDATEREQ` | `ACTIVE_PET_UPDATE_REQUEST` |
| 33 | `CHANGEPETSKIN` | `PET_CHANGE_SKIN_MSG` |
| 41 | `NEWABILITYMESSAGE` | `NEW_ABILITY` |
| 48 | `GOTOQUESTROOM` | `QUEST_ROOM_MSG` |
| 55 | `INVENTORYSWAP` | `INVSWAP` |
| 76 | `ACTIVEPET` | `ACTIVEPETUPDATE` |
| 82 | `QUESTOBJECTID` | `QUESTOBJID` |
| 84 | `REALMHEROESRESPONSE` | `REALM_HERO_LEFT_MSG` |
| 93 | `CLAIMDAILYLOGINRESPONSE` | `LOGIN_REWARD_MSG` |
| 108 | `NEWCHARACTERINFO` | `NEW_CHARACTER_INFORMATION` |
| 112 | `QUEUEMESSAGE` | `QUEUE_INFORMATION` |
| 117 | `VAULTCONTENT` | `VAULT_UPDATE` |
| 121 | `SHOOTACKCOUNTER` | `SHOOT_ACK` |
| 122 | `SHOWALLYSHOOT` | `CHANGE_ALLYSHOOT` |
| 145 | `FAVORPET` | `FAVOUR_PET` |
| 150 | `CLAIMBATTLEPASSRESPONSE` | `CLAIM_BP_MILESTONE_RESULT` |
| 164 | `UNKNOWN164` | `CLAIM_MISSION_RESULT` |
| 165 | `UNKNOWN165` | `PROGRESS_UPDATE` |
| 190 | `UNKNOWN190` | `ENCHANT` |
| 217 | `PARTYJOINREQUESTRESPONSE` | `PARTY_REQUEST_RESPONSE` |

- **6 ids where the two stacks disagree about direction** (see "Divergences" —
  these are preserved, not fixed).

### Shape of `packet-map.ts` today (what the generator must reproduce)

`packages/protocol/src/generated/packet-map.ts` (605 lines) exports:

- `PACKET_MAP: PacketMap` — 183 `"id": "NAME"` entries, ordered by numeric id.
  7 carry trailing comments: 3 × `// realmlib: <name>` (ids 117, 121, 122) and
  4 × `// admin only` (ids 123, 124, 129, 131).
- `BIDIR_PACKET_MAP = invertPacketMap(PACKET_MAP)`.
- `enum PacketType` — **191** members, sorted by name: the 183 mapped names plus
  8 with no id: `CHANGE_ALLY_SHOOT`, `CHATHELLO`, `CHATTOKEN`, `SHOOTACK`,
  `UNKNOWN164`, `UNKNOWN165`, `UNKNOWN190`, `VAULT_CONTENT`.
- `PacketAlias` — exactly 3 pairs:
  `VAULT_CONTENT → VAULT_UPDATE`, `SHOOTACK → SHOOT_ACK`,
  `CHANGE_ALLY_SHOOT → CHANGE_ALLYSHOOT`.
- `PACKET_DIRECTION: Record<PacketType, "Incoming" | "Outgoing">` — 191 entries,
  sorted by name; 25 carry a trailing
  `// verified against realmlib incoming/outgoing dir` comment (some with a
  `(was X heuristic)` suffix).

Live consumers: only `PACKET_MAP` (via `BIDIR_PACKET_MAP` in
`packetio.ts:10,39`). `PacketType`, `PacketAlias` and `PACKET_DIRECTION` are
exported through `packages/protocol/src/index.ts:16` but have **no in-repo
reader** — they are public API surface for `packages/core/` consumers. They must
be preserved exactly; they must not be treated as dead.

## Target design

### What becomes canonical

`client/data/packet-definitions.json`. It is already the richest, human-edited
artifact (id, name, direction, full field shapes, `dataObjects`), it is already
what the proxy loads at runtime, and it is already what the game-patch runbook
tells you to edit first. It gains the Layer B facts it is missing.

**Extended schema** (additions marked NEW; every existing key keeps its exact
position and meaning):

```jsonc
{
  "packets": {
    "3": {
      "name": "CLAIMDAILYLOGINREWARD",           // Layer A name — plugins string-compare this
      "direction": "client",                     // Layer A direction
      "fields": [ /* unchanged */ ],
      "note": "…",                               // existing, optional
      "protocolName": "CLAIM_LOGIN_REWARD_MSG",  // NEW — REQUIRED on every packet
      "protocolDirection": "Outgoing",           // NEW — optional; ONLY where Layer B disagrees
      "protocolMapComment": "admin only"         // NEW — optional; trailing comment in PACKET_MAP
    }
  },
  "dataObjects": { /* unchanged */ },

  "protocolOnlyPackets": {                       // NEW — 14 ids Layer B knows, Layer A does not decode
    "192": { "name": "RESET_ENCHANTMENT_REROLL_COUNT_RESULT", "direction": "Incoming" }
  },
  "protocolOrphanNames": {                       // NEW — 8 PacketType members with no id
    "CHATHELLO": "Outgoing"
  },
  "protocolAliases": {                           // NEW — 3 PacketAlias pairs
    "VAULT_CONTENT": "VAULT_UPDATE"
  },
  "protocolDirectionNotes": {                    // NEW — 25 verbatim trailing comments, by name
    "ACCEPT_ARENA_DEATH": "verified against realmlib incoming/outgoing dir"
  }
}
```

`protocolName` is **required on every packet, with no defaulting rule.** No
"strip the underscores" heuristic: 22 pairs would break it, and a silent
derivation is exactly the kind of implicit contract that produced this problem.
Adding a packet after a game patch means writing both spellings on one line, in
one file.

#### Why the extra keys are inert

- `PacketFactory` (`src/packets/PacketFactory.ts:57-68`) iterates
  `Object.entries(defs.packets)` and reads only `def.name`, `def.direction`,
  `def.fields`, plus `defs.dataObjects`. It never enumerates top-level keys.
- `BakedData.getBakedPacketDefinitions()` (`src/config/BakedData.ts:31-45`)
  does `JSON.parse(raw) as BakedPacketDefinitions` — a cast, not a validated
  parse. Extra runtime keys are ignored.
- `scripts/build-prod.mjs:50` bakes the file as an opaque string. The additions
  grow the baked payload by roughly 8 KB.
- `packetDefinitions.generated.ts` is typed `DefsFile`
  (`PacketFactory.ts:27-30`), which has exactly `packets` + `dataObjects` — an
  object literal with extra properties **would fail** the excess-property check.
  So the generator **must strip** `protocolName` / `protocolDirection` /
  `protocolMapComment` and the four new top-level sections when emitting it.

### What generates what

New file `client/scripts/gen-packet-artifacts.mjs` — Node, zero dependencies,
run as `npm run gen:packets`. Reads `client/data/*.json`, writes:

| output | derived from |
|---|---|
| `client/src/packets/packetDefinitions.generated.ts` | `data/packet-definitions.json` (stripped) |
| `client/src/packets/statTypes.generated.ts` | `data/stat-types.json` |
| `client/src/packets/packetStatus.generated.ts` | `data/packet-status.json` |
| `client/src/packets/packetLabNameOnly.generated.ts` | `data/packet-lab-name-only.json` |
| `client/packages/protocol/src/generated/packet-map.ts` | `data/packet-definitions.json` (protocol sections) |

**Exact emit formula for the four `src/packets/*.generated.ts` files** — this
reproduces the current files byte-for-byte (verified):

```js
header + JSON.stringify(value, null, 2) + ';\n\nexport default ' + varName + ';\n'
```

with, for `packetDefinitions.generated.ts`:

```
// Auto-generated from data/packet-definitions.json.
// Do not edit by hand.
import type { DefsFile } from './PacketFactory.js';

const packetDefinitions: DefsFile = ⟨json⟩;

export default packetDefinitions;
```

and the analogous headers already at the top of the other three
(`statTypes.generated.ts` imports `StatTypesFile`; `packetStatus.generated.ts`
declares `Record<string, string>`; `packetLabNameOnly.generated.ts` declares
`{ packets: Array<{ name: string; direction: string; id?: number }> }`).
Key insertion order must be preserved — strip the new keys with `delete` on a
deep clone rather than rebuilding objects.

**Emit rules for `packet-map.ts`:**

- `PACKET_MAP`: `packets[*].protocolName` ∪ `protocolOnlyPackets`, ordered by
  numeric id ascending. Trailing comment: `  // realmlib: <alias>` if some
  `protocolAliases` key maps to this name, else `  // <protocolMapComment>` if
  present, else none.
- `BIDIR_PACKET_MAP`: unchanged one-liner.
- `PacketType`: (all `PACKET_MAP` values ∪ `protocolOrphanNames` keys), sorted
  with `Array.prototype.sort()` (lexicographic, matching
  `sync-packet-map.mjs:117`).
- `PacketAlias`: `protocolAliases`, insertion order.
- `PACKET_DIRECTION`: every `PacketType` member, same sort order. Value =
  `protocolDirection` if present, else `protocolOnlyPackets[id].direction` /
  `protocolOrphanNames[name]`, else `direction === 'server' ? 'Incoming'
  : 'Outgoing'`. Trailing comment: `  // <protocolDirectionNotes[name]>` when
  present.

**Acceptance for `packet-map.ts` is byte-identity from the line
`export const PACKET_MAP: PacketMap = {` to end of file.** The header comment
block above that line legitimately changes (it must now name the canonical
source); everything semantic below it must be unchanged.

### The drift check

New file `client/scripts/check-packet-drift.mjs` — Node, zero dependencies, run
as `npm run check:packets` and from `npm test` and CI. Exits nonzero and prints
a diff when any of these fail:

1. **Regeneration is a no-op.** Generate all five artifacts in memory; compare
   to disk (full byte-compare for the four `src/packets/*.generated.ts`;
   byte-compare from `export const PACKET_MAP` onward for `packet-map.ts`).
   *This is the check that matters* — it catches a hand-edit to any derived file
   and it catches "someone updated one stack and forgot the other".
2. Every entry in `packets` has a non-empty string `protocolName`.
3. No id appears in both `packets` and `protocolOnlyPackets`.
4. `protocolName` values are unique, and none collides with a
   `protocolOnlyPackets` name or a `protocolOrphanNames` key.
5. Layer A `name` values are unique (a duplicate would make
   `PacketFactory.nameToId` silently drop one — `PacketFactory.ts:60`).
6. Every `protocolAliases` key is in `protocolOrphanNames`; every value is a
   name present in `PACKET_MAP`.

It also **prints, without failing**, the current `protocolDirection` divergence
list, so the register stays visible on every run.

### Divergence warnings — preserved, not fixed

These are real disagreements between the two stacks. This plan **records them as
data and changes neither stack's behavior.** Each needs a human decision later.

**D1 — six ids disagree about direction.** Layer A `direction`
(`client`/`server`) vs Layer B `PACKET_DIRECTION`:

| id | Layer A name / direction | Layer B name / direction |
|---|---|---|
| 17 | `ENTERARENA` / `server` | `ENTER_ARENA` / `Outgoing` |
| 53 | `PETCHANGEFORMMSG` / `server` | `PET_CHANGE_FORM_MSG` / `Outgoing` |
| 80 | `ACCEPTARENADEATH` / `server` | `ACCEPT_ARENA_DEATH` / `Outgoing` |
| 204 | `PARTYACTIONRESULT` / `client` | `PARTY_ACTION_RESULT` / `Incoming` |
| 207 | `PARTYACTION` / `server` | `PARTY_ACTION` / `Outgoing` |
| 215 | `PARTYJOINREQUEST` / `client` | `PARTY_JOIN_REQUEST` / `Incoming` |

Layer B is the better-evidenced side for at least three of them: ids 17 and 80
carry `// verified against realmlib incoming/outgoing dir`, and the names
(`ENTER_ARENA`, `ACCEPT_ARENA_DEATH`, `PARTY_ACTION`) are plainly requests. But
**changing Layer A's `direction` changes proxy behavior** (it is what
`PacketFactory` records on each decoded packet), so this plan encodes the
disagreement as `protocolDirection` and stops. Do not "fix" it here.

**D2 — `SHOOTACK` is two different things.** Layer A defines id **100** as
`SHOOTACK` with one field (`time: int32`); Layer B has no id 100 at all, defines
id **121** as `SHOOT_ACK`, and `ShootAckPacket`
(`packages/protocol/src/packets/outgoing/shootack-packet.ts:5-19`) reads/writes
**two** fields (`time: int32`, `ack: int16`). Layer A separately calls id 121
`SHOOTACKCOUNTER`. Layer B is exercised in production by `muling-headless` and
has a round-trip test (`packages/protocol/src/__tests__/shootack-roundtrip.test.ts`);
Layer A's id 100 has **no consumer** (`grep -rn SHOOTACK client/src client/plugins`
finds only the two generated-file entries). Best evidence says Layer A's id 100
is stale. **Do not delete it in this plan** — encode it (`protocolName` for
id 100 has no Layer B counterpart, so it needs a decision: see step 2) and file
it as a follow-up.

**D3 — `SHOOTACK` is also a `PacketType` orphan.** `PacketAlias.SHOOTACK`
resolves to `PacketType.SHOOT_ACK` (id 121) while Layer A's `SHOOTACK` is id 100.
Anyone reading both stacks will get this wrong. The generator preserves the
current behavior verbatim; the README note added in step 6 must call it out.

## Steps

Run after **every** step (all from `client/`):

```bash
npx tsc --noEmit -p tsconfig.json      # exit 0, no output
(cd packages/protocol && npm run typecheck)
npm test                                # green (after plan 97)
```

---

### Step 1 — Snapshot the current derived artifacts

Before touching anything, capture the exact current bytes so every later step can
prove it changed nothing:

```bash
cd /home/jesse/realm-engine-client/client
mkdir -p /tmp/pkt-baseline
cp src/packets/packetDefinitions.generated.ts \
   src/packets/statTypes.generated.ts \
   src/packets/packetStatus.generated.ts \
   src/packets/packetLabNameOnly.generated.ts \
   packages/protocol/src/generated/packet-map.ts /tmp/pkt-baseline/
```

Verify: `ls /tmp/pkt-baseline` shows 5 files. Do not commit them.

---

### Step 2 — Import the Layer B facts into `data/packet-definitions.json`

Write a **throwaway** script (do not commit it) that reads the current
`packages/protocol/src/generated/packet-map.ts` and injects the new keys into
`data/packet-definitions.json`:

- For each id in `packets`: set `protocolName` from `PACKET_MAP[id]`. For **id
  100** there is no `PACKET_MAP` entry — set `"protocolName": "SHOOTACK"` (the
  orphan `PacketType` member of the same spelling) and add
  `"note"`-style documentation of divergence D2 next to it. This keeps
  `protocolName` total without inventing a new id mapping.
- Set `protocolDirection` **only** on the 6 ids listed in D1.
- Set `protocolMapComment: "admin only"` on ids 123, 124, 129, 131.
- Build `protocolOnlyPackets` from the 14 Layer-B-only ids, each
  `{ name, direction }` taken from `PACKET_MAP` + `PACKET_DIRECTION`.
- Build `protocolOrphanNames` from the 8 `PacketType` members absent from
  `PACKET_MAP`, each with its `PACKET_DIRECTION` value.
- Build `protocolAliases` from the current `PacketAlias` block (3 pairs).
- Build `protocolDirectionNotes` from the 25 trailing comments in
  `PACKET_DIRECTION` (verbatim text after `// `).

Write the JSON back with `JSON.stringify(obj, null, 2)`. **The file's current
hand formatting (compact single-line field entries around
`data/packet-definitions.json:1522-1592`) will be normalized — that is expected
and fine**, because from this step on the file is edited through this schema and
compared structurally, never byte-wise.

Verify — the parsed content of `packets` and `dataObjects` must be unchanged
apart from the new keys:

```bash
cd /home/jesse/realm-engine-client/client
node -e "
const fs=require('fs');
const now=JSON.parse(fs.readFileSync('data/packet-definitions.json','utf8'));
const gen=fs.readFileSync('/tmp/pkt-baseline/packetDefinitions.generated.ts','utf8');
const old=JSON.parse(gen.slice(gen.indexOf('{'), gen.lastIndexOf('}')+1));
const strip=o=>{const c=JSON.parse(JSON.stringify(o));
  for(const p of Object.values(c.packets)){delete p.protocolName;delete p.protocolDirection;delete p.protocolMapComment;}
  return {packets:c.packets,dataObjects:c.dataObjects};};
console.log('packets+dataObjects unchanged:', JSON.stringify(strip(now))===JSON.stringify(strip(old)));
console.log('protocolName coverage:', Object.values(now.packets).filter(p=>p.protocolName).length, '/', Object.keys(now.packets).length);
console.log('protocolOnlyPackets:', Object.keys(now.protocolOnlyPackets).length,
            'orphans:', Object.keys(now.protocolOrphanNames).length,
            'aliases:', Object.keys(now.protocolAliases).length,
            'dirNotes:', Object.keys(now.protocolDirectionNotes).length);
"
```

Expect: `true`, `170 / 170`, `14 / 8 / 3 / 25`. Then `npm start` is **not**
required — but the typecheck must still pass, and `npm test` must still be green.

---

### Step 2b — Reconcile the three drifted JSON sources (DO THIS BEFORE STEP 3)

Apply the three RECONCILIATION DECISIONS from the corrected section above, so
that every derived `.ts` regenerates byte-identically afterwards. This edits the
canonical JSON files ONLY — never the `.generated.ts` files (those are outputs
from step 3 onward).

1. `data/packet-lab-name-only.json` → union with `packetLabNameOnly.generated.ts`
   (add the 3 names present only in the `.ts`; keep all 104 already in the JSON).
2. `data/packet-status.json` → replace its id set with the `.ts`'s 113 ids,
   preserving each id's existing value (all `"needsWork"`).
3. `data/stat-types.json` → replace `statNames` with the `.ts` content, which
   must equal `client/src/constants/StatType.ts`. **Verify that equality
   explicitly before writing** — read `StatType.ts` and confirm it agrees with
   `statTypes.generated.ts` on every id in the disputed range (116–118, 130,
   131–146, 143–155). If they do NOT agree, STOP and report: the premise of
   decision 3 is that the `.ts` matches the live-capture-verified constants, and
   if that is false the winner must be re-decided by the user.

Verify: `node -e` byte-compare each of the three `.ts` files against the emit
formula applied to its newly-reconciled JSON — all three must now match, joining
`packetDefinitions.generated.ts` which already did. Then `npx tsc --noEmit -p
tsconfig.json` (exit 0) and `npm test`.

Record in the completion report, per file, exactly which ids were added, removed
or changed — this is a data change to a live decode table and must be auditable.

### Step 3 — Write `client/scripts/gen-packet-artifacts.mjs`

Implement the "What generates what" section exactly. Requirements:

- Zero npm dependencies; `node:fs` / `node:path` only.
- Deterministic: running it twice produces identical bytes.
- `--check` flag: generate in memory and diff against disk instead of writing;
  exit 1 with a unified-diff-style report on mismatch. (`check-packet-drift.mjs`
  will call this mode.)
- A header comment naming `client/data/packet-definitions.json` as canonical and
  this plan number.

Run it and prove the four `src/packets/*.generated.ts` files are **byte-identical**
to the baseline:

```bash
cd /home/jesse/realm-engine-client/client
node scripts/gen-packet-artifacts.mjs
for f in packetDefinitions statTypes packetStatus packetLabNameOnly; do
  diff -q "src/packets/$f.generated.ts" "/tmp/pkt-baseline/$f.generated.ts" && echo "OK $f"
done
```

All four must print `OK`. If `packetDefinitions` differs, the strip step is
dropping or reordering a key — fix the generator, never the expected output.

And that `packet-map.ts` is byte-identical **below the header**:

```bash
node -e "
const fs=require('fs');
const cut=s=>s.slice(s.indexOf('export const PACKET_MAP: PacketMap = {'));
const a=cut(fs.readFileSync('/tmp/pkt-baseline/packet-map.ts','utf8'));
const b=cut(fs.readFileSync('packages/protocol/src/generated/packet-map.ts','utf8'));
if(a===b){console.log('OK packet-map body identical');process.exit(0);}
const A=a.split('\n'),B=b.split('\n');
for(let i=0;i<Math.max(A.length,B.length);i++) if(A[i]!==B[i]){console.log('first diff line',i,'\n  old:',A[i],'\n  new:',B[i]);break;}
process.exit(1);"
```

Verify: `npm test` still green (the protocol round-trip tests exercise
`SHOOT_ACK` and `HELLO` through `BIDIR_PACKET_MAP`).

---

### Step 4 — Write `client/scripts/check-packet-drift.mjs`

Implement invariants 1–6 from "The drift check". Invariant 1 delegates to
`gen-packet-artifacts.mjs --check`. Output format on success: one summary line,
e.g.

```
[check-packet-drift] OK — 170 shared packets, 14 protocol-only, 8 orphan names, 3 aliases, 6 direction divergences (see D1)
```

On failure: name the invariant, the ids/names involved, and the exact command to
fix it (`npm run gen:packets`).

Verify:

```bash
cd /home/jesse/realm-engine-client/client
node scripts/check-packet-drift.mjs; echo "exit=$?"        # exit=0
# negative test — must FAIL, then restore:
node -e "const fs=require('fs');const p='src/packets/packetDefinitions.generated.ts';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('\"NEWTICK\"','\"NEWTICKX\"'))"
node scripts/check-packet-drift.mjs; echo "exit=$? (expect 1)"
node scripts/gen-packet-artifacts.mjs && node scripts/check-packet-drift.mjs; echo "exit=$? (expect 0)"
```

Also negative-test invariant 2 by deleting one `protocolName` and restoring it.

---

### Step 5 — Wire into `npm` and CI

In `client/package.json` `scripts`, add:

```json
"gen:packets": "node scripts/gen-packet-artifacts.mjs",
"check:packets": "node scripts/check-packet-drift.mjs"
```

and prepend the checker to `test`. **Read the current value first** — plans 97
and 98 also edit it. If it is `"vitest run"`, make it
`"node scripts/check-packet-drift.mjs && vitest run"`. If plan 98 already made it
`"node scripts/check-bridge-contract.mjs && vitest run"`, make it
`"node scripts/check-bridge-contract.mjs && node scripts/check-packet-drift.mjs && vitest run"`.
Do not remove or reorder 98's checker.

In `.github/workflows/ci.yml`, add a step to the same job that runs the client
typecheck/tests:

```yaml
      - name: Packet definition drift check
        working-directory: client
        run: node scripts/check-packet-drift.mjs
```

Verify:

```bash
cd /home/jesse/realm-engine-client/client && npm test        # green, checker line printed first
python3 -c "import yaml;yaml.safe_load(open('/home/jesse/realm-engine-client/.github/workflows/ci.yml'))"
```

---

### Step 6 — Rewrite the game-patch runbook

Replace section 3 of `internal/docs/UPDATING_AFTER_GAME_PATCH.md` (lines
109–163, "Sync packet map + wire shapes") with the one-file flow:

1. Edit `client/data/packet-definitions.json` — for a new packet, add one entry
   with `name`, `protocolName`, `direction`, `fields`. For a changed shape, edit
   `fields`. For a Layer-B-only id, add to `protocolOnlyPackets`.
2. `cd client && npm run gen:packets`
3. `npm run check:packets && npm test && npx tsc --noEmit -p tsconfig.json`
4. Review the generated diff in `packages/protocol/src/generated/packet-map.ts`
   and `src/packets/*.generated.ts` — both should show only the intended change.

Keep the "symptoms" list at `:111-116`. Replace the "Update Layer B" / "Update
Layer A" subsections entirely. Add a short subsection recording D1 (the 6
direction divergences), D2 and D3 as known, deliberate, unresolved, with a
pointer to `protocolDirection` in the canonical file.

Also add a `client/data/README.md` (new, short) stating that
`packet-definitions.json` is canonical, listing the five derived artifacts, and
saying that all five are regenerated — never hand-edited — with
`npm run gen:packets`.

Verify: `grep -n 'sync-packet-map' internal/docs/UPDATING_AFTER_GAME_PATCH.md`
returns only the step-7 reference (below), if any.

---

### Step 7 — Retire the upstream-only generator path

`client/scripts/sync-packet-map.mjs` currently **writes**
`packages/protocol/src/generated/packet-map.ts`. Two generators writing one file
is the exact failure mode this plan removes.

Convert it to a read-only importer: rename to
`client/scripts/import-realmlib-map.mjs`, and change it so that instead of
writing `packet-map.ts` it reads the upstream realmlib pair, compares to
`data/packet-definitions.json`, and **prints a report** of

- ids present upstream but missing from canonical (with suggested
  `protocolOnlyPackets` / `packets` entries, ready to paste),
- ids whose upstream name differs from canonical `protocolName`,
- `PacketType` members upstream that are not in canonical.

It must exit 0 when there is nothing to report, 1 otherwise, and it must never
write any file. Add a header comment: canonical is
`client/data/packet-definitions.json`; this script only tells you what to put in
it.

Verify:

```bash
ls /home/jesse/realm-engine-client/client/scripts/sync-packet-map.mjs 2>/dev/null   # must be gone
grep -rn 'sync-packet-map' /home/jesse/realm-engine-client --include='*.mjs' \
  --include='*.md' --include='*.json' --include='*.yml' | grep -v '/docs/plans/'
# → only the new name, or empty
cd /home/jesse/realm-engine-client/client && node scripts/check-packet-drift.mjs; echo "exit=$?"
```

(The script cannot be smoke-tested without an upstream checkout; that is
acceptable — it is now a reporting tool, not part of the build.)

## Verification

```bash
cd /home/jesse/realm-engine-client/client
npx tsc --noEmit -p tsconfig.json          # exit 0, no output
(cd packages/protocol && npm run typecheck) # exit 0
npm run gen:packets                        # writes 5 files
git diff --stat                            # after a clean run: NO changes to the 5 generated files
node scripts/check-packet-drift.mjs        # exit 0 + summary line
npm test                                   # green
```

The strongest single assertion: **`npm run gen:packets` on a clean tree must
produce zero `git diff`.** That is what makes the canonical file canonical.

Greps that must return **zero** results when this plan is complete:

```bash
# 1. No second writer of packet-map.ts.
grep -rn "generated/packet-map.ts" /home/jesse/realm-engine-client/client/scripts

# 2. The old two-layer runbook wording is gone.
grep -n 'Update Layer A\|Update Layer B\|kept in-sync manually' \
  /home/jesse/realm-engine-client/internal/docs/UPDATING_AFTER_GAME_PATCH.md

# 3. Every packet carries both spellings.
cd /home/jesse/realm-engine-client/client && node -e "
const d=require('fs').readFileSync('data/packet-definitions.json','utf8');
const j=JSON.parse(d);
const bad=Object.entries(j.packets).filter(([k,v])=>!v.protocolName);
console.log(bad.length?bad:'');process.exit(bad.length?1:0)"
```

Manual smoke test (the proxy is the only runtime consumer that changed file
formatting): `npm start`, connect once, confirm the log line
`PacketFactory | Loaded 170 packet definitions, 12 data objects`
(`PacketFactory.ts:72`) is unchanged, and that no `unknown packet id` warnings
appear that did not appear before.

## What remains duplicated after this plan, and why that is acceptable

- **The two runtime implementations.** `src/packets/PacketReader/PacketWriter`
  (data-driven, field-list interpreter) and `packages/protocol`'s 38 hand-written
  packet classes both know how to serialize e.g. `MAPINFO`. Merging them means
  rewriting one of two working, independently-tested protocol implementations
  serving disjoint consumers (`src/proxy/**` vs `muling-headless/**`), for zero
  runtime benefit. **Out of scope by design.**
- **Field shapes for the 38 classed packets.** `data/packet-definitions.json`
  describes fields for 92 of 170 packets; `packages/protocol` hand-codes 38
  classes. Where they overlap, the shapes are stated twice. Generating the
  classes from the JSON is an implementation rewrite (see above). The drift check
  therefore covers **ids, names, directions and aliases** — the surfaces that
  actually change on a game patch — and not field bodies.
- **The two naming conventions.** Layer A keeps `SCREAMINGNOSPACE`, Layer B keeps
  `SCREAMING_SNAKE`. Renaming either breaks string comparisons in shipped
  plugins (`'NEWTICK'`, `'MAPINFO'`, `'VAULTCONTENT'`, …) or in
  `packages/core`. Both spellings now live on one line of one file, which is the
  point.
- **The 3-entry `PacketAlias` map.** It is preserved exactly as-is rather than
  expanded to all 94 differing spellings, because expanding it changes
  `packages/protocol`'s public API surface. Expanding it is a reasonable
  follow-up; it is not this plan.

## Out of scope

- **Do NOT change any packet's `direction`, including the 6 in divergence D1.**
  Encode them as `protocolDirection` and leave both stacks behaving exactly as
  they do today.
- **Do NOT delete Layer A's id 100 `SHOOTACK` (D2)** or renumber anything.
- **Do NOT rename any packet in either stack.**
- **Do NOT touch `client/scripts/build-prod.mjs`** — modified in the working tree.
- **Do NOT touch `client/packages/protocol/src/packets/**`,
  `registry.ts`, `packetio.ts`, `reader.ts`, `writer.ts`, or anything in
  `client/src/packets/` other than the four `*.generated.ts` files.** No runtime
  code changes in this plan.
- **Do NOT touch `client/src/bridge/contract.ts`** or the DLL feature-key
  contract — that is plan 98's surface.
- **Do NOT add a JSON-schema validation dependency** (ajv or similar).
  `check-packet-drift.mjs` stays dependency-free.
- **Do NOT expand `PacketAlias`** to cover all 94 name differences.
- **Do NOT delete `client/data/packet-merge-report.json`,
  `packet-status.json` or `packet-lab-name-only.json`** — the latter two feed
  generated artifacts this plan now owns; the merge report is history.
