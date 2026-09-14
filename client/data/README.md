# `client/data/` — canonical protocol data

**`packet-definitions.json` is the single source of truth for the wire protocol,
for both protocol stacks.** Layer A (`src/packets/`, data-driven, used by the
MITM proxy and plugins) and Layer B (`packages/protocol/`, class-based, used by
`packages/core/` and `muling-headless`) both derive from it.

Each packet carries **both spellings on one line**: `name` is Layer A's
`SCREAMINGNOSPACE` spelling (plugins string-compare it) and `protocolName` is
Layer B's `SCREAMING_SNAKE` spelling. `protocolName` is required on every packet
and has no defaulting rule — 22 pairs differ by more than underscores, so a
"strip the underscores" heuristic would be wrong.

## Derived artifacts — never hand-edit these

| generated file | derived from |
|---|---|
| `src/packets/packetDefinitions.generated.ts` | `packet-definitions.json` (with `protocol*` keys stripped) |
| `src/packets/statTypes.generated.ts` | `stat-types.json` |
| `src/packets/packetStatus.generated.ts` | `packet-status.json` |
| `src/packets/packetLabNameOnly.generated.ts` | `packet-lab-name-only.json` |
| `packages/protocol/src/generated/packet-map.ts` | `packet-definitions.json` (the `protocol*` sections) |

Regenerate all five with:

```bash
cd client && npm run gen:packets
```

Check that none of them has drifted:

```bash
cd client && npm run check:packets
```

`check:packets` runs from `npm test` and in CI. It fails when a generated file
was hand-edited, when the canonical file changed without a regeneration, or when
the canonical file becomes internally inconsistent (a missing `protocolName`, a
duplicate name, an id in two sections, an alias that resolves nowhere, a
non-canonical packet key, or a file that is not `JSON.stringify(_, null, 2)` of
itself).

**A clean tree plus `npm run gen:packets` must produce an empty `git diff`.**
That is what makes the canonical file canonical.

## Packet keys: a packet is (direction, id)

RotMG reuses some ids with a different packet in each direction (215 and 217 on
game 86ad651b), so `PacketFactory` looks definitions up by (direction, id) and the
proxy decodes every frame in the direction it travelled. The keys of `packets`:

| key | meaning |
|---|---|
| `"12"` | the only packet at id 12; its `direction` says which way it travels |
| `"client:215"` | the client→server packet at id 215 |
| `"server:215"` | the server→client packet at id 215 |

- An id with one packet uses the plain key. An id with a packet each way uses
  both qualified keys and never the plain one.
- A qualifier must equal the packet's `direction`.
- Qualified keys come after every plain key, by id, `client` before `server`.
  (`JSON.parse` always enumerates integer-like keys first, so no other placement
  survives the packet-ID sync's rewrite of this file.)
- `direction` is load-bearing: a frame travelling the other way than its
  packet's label passes through undecoded as `UNKNOWN_<id>`.
- Layer A names stay unique, so `createByName` and hooks (keyed by name) are
  unchanged. `PacketFactory` refuses to load a file that breaks any of this.

`scripts/lib/packet-keys.mjs` holds the grammar for the build scripts, plus
`keyPackets()`, which turns (id, packet) pairs into canonical keys for any tool
that moves ids. `PacketFactory.parsePacketKey` is its TypeScript twin; a vitest
suite proves they agree.

Layer B's `PACKET_MAP` is id→name, so at a shared id it holds the **incoming**
packet (numeric lookups name frames a game client receives), the outgoing one is
in `OUTGOING_AT_SHARED_IDS`, and `BIDIR_PACKET_MAP` maps both names to the id —
upstream realmlib's rule.

## Schema additions beyond the Layer A fields

Per packet, all optional except `protocolName`:

- `protocolName` — **required.** Layer B's name for this id.
- `protocolDirection` — set *only* where Layer B disagrees with `direction`
  (divergence D1; 5 ids today). Recorded, not resolved.
- `protocolMapComment` — trailing comment emitted into `PACKET_MAP`
  (`admin only` on ids 123, 124, 129, 131).
- `protocolNote` — prose documenting a divergence; stripped from all output.

Top level:

- `protocolOnlyPackets` — the 14 ids Layer B knows and Layer A does not decode.
- `protocolOrphanNames` — the 8 `PacketType` members with no id. An orphan name
  carries no id, so it never enters `PACKET_MAP`.
- `protocolAliases` — the 3 `PacketAlias` pairs. Deliberately not expanded to
  all 94 differing spellings; that would change `packages/protocol`'s public API.
- `protocolDirectionNotes` — the 25 verbatim `PACKET_DIRECTION` trailing comments.

Known divergences D1/D2/D3 are documented in
`internal/docs/UPDATING_AFTER_GAME_PATCH.md` §3.

## Other files here

- `packet-merge-report.json` — history from an earlier merge; not an input.
- `stat-types.json` — id→name for `StatData`, read by the live proxy. Cross-check
  changes against `src/constants/StatType.ts`, which is annotated with
  live-capture observations.
- `packet-status.json`, `packet-lab-name-only.json` — feed the dashboard's packet
  lab (status chips and name-only sniffer chips).
