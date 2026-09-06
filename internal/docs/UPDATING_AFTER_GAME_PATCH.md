# Updating after a RotMG Exalt game patch

Every RotMG Exalt patch rebuilds the game's IL2CPP assembly. The BeeByte
obfuscation pass re-randomises class and field names, and field offsets
can shift. This document is the runbook for getting `internal/` (and
`client/`) back to green after a game update.

There are three concerns, in escalating order of pain:

1. **Regenerate the IL2CPP headers.** Mechanical, always required.
2. **Refresh `RuntimeOffsets` fallbacks.** Only when the in-game
   OFFSET HEALTH panel shows yellow / red rows.
3. **Sync packet map + shapes if the wire protocol changed.** Rare —
   usually the game keeps wire compatibility across a patch, but not
   always. Sync when new packet IDs appear or an existing packet's fields
   change.

Do the steps in order and stop at the first successful build + smoke
test — you probably don't need step 3.

---

## 1. Regenerate IL2CPP headers (always)

See the repo-root `SETUP.md` for the full commands. Summary:

1. Point [Il2CppInspectorPro](https://github.com/Jadis0x/Il2CppInspectorPro)
   at the new `GameAssembly.dll` + `global-metadata.dat`.
2. Generate the **C++ scaffold / application headers**.
3. Overwrite `internal/src/game/generated/il2cpp-*.h` with the new files:
   - `il2cpp-types.h`
   - `il2cpp-functions.h`
   - `il2cpp-types-ptr.h`
   - `il2cpp-api-functions.h`
   - `il2cpp-api-functions-ptr.h`
   - `il2cpp-metadata-version.h`
4. Rebuild `internal/` (VS 2022, `x64 | Release`).

If it builds and injects, launch RotMG and check the in-game
**Test → OFFSET HEALTH** panel. All rows green? You're done. Any yellow /
red? Continue to step 2.

---

## 2. Refresh `RuntimeOffsets` fallbacks

The table in `internal/src/core/runtime/RuntimeOffsets.cpp` is
**self-healing** — as long as a class + field is resolvable from live
IL2CPP metadata, the fallback is only used for the first frame. So the
fallbacks only bite when BeeByte has:

- **Renamed the field.** The class still exists, but the old obfuscated
  name isn't there anymore. OFFSET HEALTH row is **yellow / STALE**.
- **Renamed the class.** The whole class name is stale. OFFSET HEALTH
  row is **yellow / no-class**.
- **Shifted the offset in a way that breaks the ACTK model.** The
  fallback resolves the wrong value and reads garbage. OFFSET HEALTH row
  is **red / SUSPECT** — sanity checks in `RuntimeOffsets.cpp`
  (`SanityCheckPlayerStats`, `SanityCheckProjDamage`) tripped.

### Fixing a stale row

For each flagged row, work out the new obfuscated name(s) and offset from
the fresh Il2CppInspectorPro dump. The dump gives you both the class
layout and the raw offsets — the tricky part is mapping old
obfuscated-name → new obfuscated-name for the SAME semantic field.

You have three cross-references to help:

1. **`internal/src/game/symbols/BeebyteName.h`** — the persistent
   obfuscated ↔ readable alias map maintained across builds. Search for
   the readable name (e.g. `"speedMultiplier"`) to find both the old and
   new obfuscated candidates.
2. **`internal/refs/` and `Documents/Projects/OSR-RE/refs/prodmafia/`** —
   the Flash client source is unobfuscated and is the ground truth for
   what each field means semantically. Compare the surrounding fields'
   types and offsets to identify the corresponding member.
3. **The Test tab's UnityExplorer** — you can drill into a live
   `LKHPPBEGNOM` instance in-game and read every field.  The one whose
   value matches HP or MP is the one you want.

Once you have the new name + verified offset:

```cpp
// Update the fallback initializer near the top of RuntimeOffsets.cpp:
uint32_t HP = 0x20C;   // ← new offset if it moved

// Update the Entry in s_entries[] (add the new name FIRST — old names
// can stay as extra candidates for robustness across intermediate builds):
{ "LKHPPBEGNOM", { "NEW_HP_NAME", "KJNHLADHEMH" }, 2, kActk, &HP, false },
```

Rebuild, smoke-test in-game, confirm OFFSET HEALTH is now green.

### Critical rows — verify first

If AutoNexus misbehaves after a patch, these are the fields that feed its
damage calculation:

- `HP`, `MaxHP`, `Defense` on `LKHPPBEGNOM` (player)
- `Hbeak_InstanceDamage` on `HBEAKBIHANL` (projectile instance)

Wrong values here don't crash — you'll just die to hits AutoNexus should
have caught. Sanity-check them against the OFFSET HEALTH panel and by
watching HP change in-game.

---

## 3. Sync packet map + wire shapes (only if needed)

Only needed when the game's wire protocol changed. Symptoms:

- MITM proxy logs unknown packet IDs.
- Existing packet decoders throw / read garbage on a known ID.
- `client/data/packet-merge-report.json` shows unresolved entries after
  the sync-tool run.

Both are decoded by `client/src/packets/PacketFactory` (Layer A — the
Electron app's MITM proxy) and the typed `@re-headless/protocol` classes
(Layer B — `muling-headless`). They share the same underlying map.

### One file, one command

`client/data/packet-definitions.json` is the **canonical** description of
the protocol for both stacks. Every derived artifact is generated from
it; none of them is ever hand-edited. See `client/data/README.md`.

1. **Edit `client/data/packet-definitions.json`.**
   - *New packet:* add one entry with `name` (Layer A's
     `SCREAMINGNOSPACE` spelling, which plugins string-compare),
     `protocolName` (Layer B's `SCREAMING_SNAKE` spelling — **required**,
     there is no defaulting rule), `direction` (`client`/`server`) and
     `fields`.
   - *Changed wire shape:* edit that packet's `fields`.
   - *Id only Layer B knows about:* add it to `protocolOnlyPackets`.
   - *Direction that the two stacks disagree on:* set `protocolDirection`
     (see "Known divergences" below) — do not silently change `direction`.

2. **Regenerate:**
   ```bash
   cd client && npm run gen:packets
   ```

3. **Verify:**
   ```bash
   npm run check:packets && npm test && npx tsc --noEmit -p tsconfig.json
   ```

4. **Review the generated diff** in
   `client/packages/protocol/src/generated/packet-map.ts` and
   `client/src/packets/*.generated.ts`. Both should show only the change
   you intended. A clean tree plus `npm run gen:packets` must produce an
   empty `git diff` — that is what makes the canonical file canonical.

`npm run check:packets` also runs from `npm test` and in CI, so a
hand-edit to a generated file, or updating one stack and forgetting the
other, fails the build instead of shipping.

To see what an upstream realmlib checkout knows that the canonical file
does not, run the read-only reporter (it never writes anything):

```bash
node client/scripts/import-realmlib-map.mjs \
  ../../HiveManager/HeadlessClient/realmlib/src
```

### Known divergences (deliberate, unresolved)

The two stacks genuinely disagree in three places. These are recorded as
**data** in the canonical file and change neither stack's behaviour. Each
needs a human decision; do not "fix" one in passing.

- **D1 — six ids disagree about direction.** Layer A's `direction` vs
  Layer B's `PACKET_DIRECTION`: ids **17, 53, 80, 204, 207, 215**. The
  disagreement is encoded as `protocolDirection` on those packets, and
  `npm run check:packets` prints the register on every run. Layer B looks
  better-evidenced for at least 17, 80 and 207, but changing Layer A's
  `direction` changes proxy behaviour.
- **D2 — `SHOOTACK` is two different things.** Layer A defines id **100**
  as `SHOOTACK` (one field, `time: int32`); Layer B has no id 100, and its
  `SHOOT_ACK` is id **121** with two fields (`time: int32`, `ack: int16`),
  which Layer A calls `SHOOTACKCOUNTER`. Layer A's id 100 has no consumer
  and is probably stale — see `protocolNote` on id 100.
- **D3 — `SHOOTACK` is also a `PacketType` orphan.** `PacketAlias.SHOOTACK`
  resolves to `PacketType.SHOOT_ACK` (id **121**), while Layer A's
  `SHOOTACK` is id **100**. Anyone reading both stacks will get this
  wrong. Orphan `PacketType` members carry no id, so the generator
  deliberately keeps id 100 out of `PACKET_MAP`.

---

## Sanity: what has and hasn't changed after your update

Run this quick manual smoke test after any of the above:

- [ ] `internal/` builds with 0 errors, 0 warnings that touch feature code.
- [ ] `version.dll` injects (game launches without crash-on-attach).
- [ ] In-game **Test → OFFSET HEALTH** is all green.
- [ ] AutoNexus fires on a known-lethal hit (safe repro: solo dungeon,
      allow one hit above the threshold).
- [ ] AutoDodge tracks a wavy shot correctly.
- [ ] MITM proxy logs no `unknown packet id` for a normal play session
      (arena, guild hall, one dungeon).
- [ ] `muling-headless` connects and logs in without protocol errors.

If any of these fails, the failing item is the debugging entrypoint — do
not proceed with a release build until all six are green.
