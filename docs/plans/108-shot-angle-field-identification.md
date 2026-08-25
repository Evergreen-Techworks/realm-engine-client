# 108 — `RuntimeOffsets::Shot_Angle` (0x1C): field identification

**Status:** investigation complete (read-only). **No code changed.**
**Date:** 2026-08-24
**Question asked:** what IL2CPP class + field name is behind
`inline constexpr uint32_t Shot_Angle = 0x1C` (`RuntimeOffsets.h:445`), so it can be
promoted from a manual constant into a self-healing `s_entries[]` row and become
`IsFieldWriteTrusted()`-gateable.

**Short answer:** the *number* 0x1C is a real, resolvable, cross-build-stable field —
`LEHICKLGHKC::FFFFKPDHEFP` = `ServerPlayerShoot.angle`. But it is **not** the field the
one consumer writes to. The consumer (`AimHooks.cpp` `SendShotPacketDetour`) receives a
different object entirely, and `+0x1C` on that object is **past the end of the allocation**.

> **Do not promote `Shot_Angle` into `s_entries[]` in its current form.** Doing so would
> make `IsFieldWriteTrusted()` return `true` for a write that is an out-of-bounds heap
> write — the exact failure mode this plan series exists to prevent. Fix the hook first
> (§6), then the constant disappears rather than being promoted.

---

## 1. Evidence base (and why it is trustworthy)

Three artifacts, all cross-checked against each other:

| Artifact | Build | Notes |
|---|---|---|
| `internal/src/game/generated/il2cpp-types.h` / `il2cpp-functions.h` | **6.13.0.0.0-aeceb1f212da9dcaba9e6c41a34c9d69** | our build; authoritative for the DLL we ship |
| `<scratch>/field_accesses.json`, `member_observations.json`, `labels.json` | **same build hash** | rotmg-extractor output: RVA → (owner, field, *deobfuscated* field name, byte offset) |
| `<scratch>/dump.cs` | 6.13.0.1.0 (newer published build) | independent cross-build shape check |

**Proof the extractor JSONs are the same build as our headers** (this is what makes the
deobfuscated names usable):

- `field_accesses.json` records accesses at RVA `21788044`/`21788195` in
  `Player::PLIPJFPAAGD`; our header declares `FKALGHJIADI_PLIPJFPAAGD` at `0x014C7450`
  (= 21787728). Inside. ✅
- RVA `21788400` in `Player::PMEHAFOPLBB`; our header: `FKALGHJIADI_PMEHAFOPLBB` at
  `0x014C76F0` = **exactly 21788400**. ✅
- RVA `21788564` in `Player::PNFPMIPDGPP`; our header: `FKALGHJIADI_PNFPMIPDGPP` at
  `0x014C7790` = 21788560. Inside. ✅
- `member_observations.json` contains
  `{ owner: "DecaGames.RotMG.Objects.Map.Player", obfuscated_owner: "FKALGHJIADI",
     obfuscated: "PMIANFBMMNN", evidence: "native method body at RVA 0x14C7700" }` —
  the exact method and RVA our header declares.

**Correction to a prior assumption:** the note that "every BeeByte token differs in
`dump.cs`" is **wrong**. `FKALGHJIADI` (63 hits), `HJNFJAHAOOE` (2), `NKMHEINLOCD` (13),
`LEHICKLGHKC` (2) all appear in `dump.cs`. BeeByte name assignment is *stable* between
6.13.0.0.0 and 6.13.0.1.0 for these types, so cross-build checks by name are valid.
(`dump.cs` lists fields/properties only — no methods — which is why the method tokens
`PMIANFBMMNN` / `ELCBJAFBLJG` / `EHGHCACPAGH` appear to be "missing" there.)

**Class-name resolution** (from `labels.json`, each with independent survived-string /
survived-field evidence):

| Obfuscated | Real name | Evidence |
|---|---|---|
| `FKALGHJIADI` | `DecaGames.RotMG.Objects.Map.Player` | survived strings `"Player"`, `"Teleport target too close."` |
| `LKHPPBEGNOM` | `MapObject` | engineRefs Color/Color32/SortingGroup/SpriteMask/SpriteRenderer |
| `HJNFJAHAOOE` | `PlayerShoot` (outgoing PLAYERSHOOT) | field names below match `client/data/packet-definitions.json` exactly |
| `LEHICKLGHKC` | `ServerPlayerShoot` (incoming) | field names below |
| `NKMHEINLOCD` | `…Messages.Data.UniqueDataContainer` | single field is `Dictionary<UniqueDataType, …>`; see §3 |
| `FFLIAABAAFP` | `WorldPosData` | survivedMethods `ToString` |
| `JGNMPKCFLGL` | `PlayerShootSource` (enum) | survivedFields `value__`, `Primary`, `Ability` |
| `HEHDPIFDJGI` / `KFCDBMDEMMC` | `AllyShoot` / `EnemyShoot` | — |

---

## 2. What field actually lives at +0x1C

`LEHICKLGHKC` = **ServerPlayerShoot**. Our `il2cpp-types.h:267933`:

```
struct __declspec(align(8)) LEHICKLGHKC__Fields {   // object header = 0x10
    int16_t              KLHOFENGJNM;   // 0x10  bulletId
    int32_t              HHCCBONIIOM;   // 0x14  ownerId
    int32_t              ECKKOIDBHCD;   // 0x18  containerType
    float                FFFFKPDHEFP;   // 0x1C  angle          <<<<<<
    int16_t              DBNNDLKNECM;   // 0x20  damage
    struct FFLIAABAAFP  *BMKMLEPFEJK;   // 0x28  startingPos
    int32_t              FFLOHHNPLDG;   // 0x30  unknownInt
    uint8_t              FJKBAFEPEAE;   // 0x34  unknownByte
    uint8_t              LGOPKDDJJFA;   // 0x35  bulletCount
    float                HNMNJGAHCJC;   // 0x38  bulletAngle
};
```

Every one of those computed offsets is confirmed byte-for-byte by
`field_accesses.json` (`owner: "ServerPlayerShoot"` — `bulletId` 16, `ownerId` 20,
`containerType` 24, **`angle` 28**, `damage` 32, `startingPos` 40, `unknownInt` 48,
`unknownByte` 52, `bulletCount` 53, `bulletAngle` 56), and reproduced identically in the
newer build (`dump.cs:15505`, `public class LEHICKLGHKC : OODFCLBKDJJ` →
`float32 FFFFKPDHEFP; // 0x1C`).

A scan of every `float32` field at offset 28 in `field_accesses.json` shows exactly one
shot-related owner: `ServerPlayerShoot`. Nothing else in the shot family has a float at
0x1C.

> **Identification of the number:** `Shot_Angle = 0x1C` **is** `ServerPlayerShoot.angle`
> (`LEHICKLGHKC::FFFFKPDHEFP`). Confidence: **high** — name-resolved, offset-confirmed by
> two independent artifacts, stable across two game builds.

For completeness, the *outgoing* packet is laid out differently
(`il2cpp-types.h:345216`, base `DCBCCBKEIHN__Fields` is 0x10 wide):

```
HJNFJAHAOOE (PlayerShoot):
  0x20 int32   GMFCEKNEBGI  _time
  0x24 uint32  CLKDFFOGKJB  bulletId
  0x28 uint16  PDEGBHOHKMO  containerType
  0x30 WorldPosData* FLADLOHHCCP  startingPos
  0x38 float   AIIGAFCMICI  angle          <<<< PLAYERSHOOT angle is 0x38, NOT 0x1C
  0x3C byte    HMCOENBIGPD  isBurst
  0x3D sbyte   KJCGHMLKPPA  unknownByte
  0x3E sbyte   PPOOCBGPIPK  unknownShort
  0x3F sbyte   CJNGDOACDGF  shootSource
  0x40 WorldPosData* BHDJAKILBKJ  playerPos
```
Again every offset is confirmed by `field_accesses.json` (`owner: "PlayerShoot"`) and by
`dump.cs:32776`. Note the field names line up 1:1 with
`client/data/packet-definitions.json` PLAYERSHOOT — so this identification is solid too.
(The earlier hand-estimate of "roughly 0x28" for `AIIGAFCMICI` was off because
`DCBCCBKEIHN__Fields` is 0x10 bytes, pushing the whole block to 0x20+.)

---

## 3. What `shotData` actually is at runtime — and why 0x1C is wrong there

`AimHooks.cpp:144` (now `internal/src/features/combat/autoaim/shoot/AimHooks.cpp`) resolves `FKALGHJIADI::PMIANFBMMNN` with `paramCount = 2`. There is
exactly one such method in the build:

```
il2cpp-functions.h:117087
DO_APP_FUNC(0x014C7700, void, FKALGHJIADI_PMIANFBMMNN,
            (FKALGHJIADI *__this, NKMHEINLOCD *NOCJFPIEJEO, int32_t FPGHODFCFKC, MethodInfo *method));
```

So `shotData` is an `NKMHEINLOCD`. Its complete layout (`il2cpp-types.h:45458`, and
identically `dump.cs:5064`):

```
struct NKMHEINLOCD {           //  0x00 klass
    ... monitor                //  0x08 monitor
    Dictionary<NNIELMLOOPJ, IKIJJJKKIIB> *NOCJFPIEJEO;  // 0x10
};                             //  total object size = 0x18
```

- `NNIELMLOOPJ` is an enum whose survived members are `DungeonMods`, `Enchantments`, …
  → `UniqueDataType`. So `NKMHEINLOCD` is the item **UniqueDataContainer**.
- Corroboration from usage: `NKMHEINLOCD*` is passed next to `ObjectProperties*` into
  `EquipmentManager_ShowItemTooltip`, `ItemTooltip_ShowTooltip`, `FeedSlot_Init`, … —
  item/equipment UI, not combat.
- Nothing in the build derives from it (`NKMHEINLOCD__Fields` appears nowhere as an
  embedded base `_;`), and it is not an interface (it has an instance field and only the
  four `System.Object` vtable slots). There is no derived runtime type that could make
  0x1C legal.
- `PMIANFBMMNN` is not a BeeByte decoy alias: its body RVA `0x14C7700` is unique in the
  build, with a unique `member_observations.json` fingerprint (`b367d76dac16…`,
  1 occurrence). Its signature is genuinely `(UniqueDataContainer, int32)`.

### Consequences for the current code

```cpp
// AimHooks.cpp:110-111
Mem::AddrOk(shotData) && Mem::AddrOk((const uint8_t*)shotData + 0x24)   // 0x24 is +12 past the object
// AimHooks.cpp:125
Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle /*0x1C*/, newAngle);
```

`shotData` is 0x18 bytes. `+0x1C` writes 4 bytes **past the end of a managed object**.
On the IL2CPP GC heap the next 8-aligned allocation starts at `+0x18`, so `+0x1C` is the
upper half of the *next object's `klass` pointer*. `Mem::AddrOk` is only a pointer-range
sanity check, so the `+0x24` probe always passes and provides no protection;
`Mem::TryWrite` is SEH-guarded so it will not fault at the write — it will silently
corrupt and fault later somewhere unrelated.

This path is reachable whenever AutoAim is enabled and the local player triggers whatever
`Player.PMIANFBMMNN(uniqueData, int)` really is (equipment/unique-data plumbing), with
the int argument `> 0`.

**Confidence that `shotData` is not shot data: high.** Caveat: I did not disassemble
`0x014C7700`; the conclusion rests on IL2CPP metadata (which the game itself uses for
reflection/marshalling and cannot be "wrong" about parameter types) plus three
independent corroborations of what `NKMHEINLOCD` is.

### Where the constant probably came from

The names in `AimHooks.cpp` (`kCSAMethod`/`kSWAMethod`/`kSSPMethod`) arrived wholesale in
`e0d5de9 "feat: Grealty improved autoaim"` (imported third-party autoaim), and the
comment then read `// shotData+0x1C is the angle field in the SHOOT packet struct`.
0x1C is exactly `ServerPlayerShoot.angle`, so the constant is almost certainly a correct
RE of `ServerPlayerShoot` from some other build/hook site that got paired with the wrong
method token. In build 6.13.0.0.0 no method anywhere takes `LEHICKLGHKC*` as a parameter
(it is pooled through a `ConcurrentQueue<LEHICKLGHKC>` and read via
`LEHICKLGHKC::JEFJDICFNBA(BHFDLBOGHIB* reader)`), so this hook cannot be receiving one.

### Collateral: the other two AimHooks tokens

Not the assignment, but found while verifying, and relevant if anyone acts on this:

- `LKHPPBEGNOM::ELCBJAFBLJG(uint8, float*, bool*, bool)` — 4 params, out-float +
  out-bool. Consistent with `ComputeShootAngle`. Looks sound.
- `FKALGHJIADI::EHGHCACPAGH(float)` — **shares its body RVA `0x014B11C0` with
  `FKALGHJIADI::HPFPAEDPGPN` and `FKALGHJIADI::BPLPAEJIOHC`**, all three `void M(float)`,
  and `field_accesses.json` records **no field access at all** in `[0x014B11C0,0x014B11D0)`
  (16 bytes). That is the signature of BeeByte decoy proliferation around a trivial/empty
  body, not of a real `ShootWithAngle`. Worth re-verifying separately.
- `RuntimeOffsets::Player_FacingAngle` (written on the very next line, `AimHooks.cpp:126`)
  **is** correct: `MapObject::ECHAFMAAKMD` is a `float32` at dump offset 476 = 0x1DC
  (`field_accesses.json`, `dump.cs:38705`), + `kActk` 0x50 = 0x22C runtime, matching the
  existing table row at `RuntimeOffsets.cpp:486`.

---

## 4. Can `Shot_Angle` become a table row?

**Mechanically yes; semantically no — not for its current consumer.**

The row that would make `Shot_Angle` self-heal to 0x1C is:

```cpp
// ── LEHICKLGHKC ServerPlayerShoot (OODFCLBKDJJ message base, no ACTK shift) ──
{ "LEHICKLGHKC", { "FFFFKPDHEFP" },   1, 0, &Shot_Angle,   false },
```
- class string: `"LEHICKLGHKC"` (BeeByte token; there is no unobfuscated alias)
- field string: `"FFFFKPDHEFP"` (no alias — same token in 6.13.0.0.0 and 6.13.0.1.0)
- `actkShift`: **0**. `LEHICKLGHKC` derives from the message base `OODFCLBKDJJ`, the same
  base as `COEFCBBIBMC` (ShowEffect), whose rows already use shift 0 with first field at
  0x10. Confirmed: `il2cpp_field_get_offset` values in `field_accesses.json` are already
  header-inclusive (16/20/24/28/…).
- fallback: `0x1C`
- `Shot_Angle` would have to change from `inline constexpr uint32_t` in the `MANUAL
  OFFSETS` block of `RuntimeOffsets.h:445` to `extern uint32_t` next to the other
  packet rows, with `uint32_t Shot_Angle = 0x1C;` storage in `RuntimeOffsets.cpp`.

**But adding that row while `AimHooks.cpp:125` still writes it into
`FKALGHJIADI::PMIANFBMMNN`'s 2nd argument would be actively harmful**: the gate would
report `ResolvedMatch` and `IsFieldWriteTrusted()` would return `true` for an
out-of-bounds write to an unrelated object. A trusted-but-wrong offset is strictly worse
than the untrusted constant we have now.

If the outgoing PLAYERSHOOT angle is what is wanted instead, the row is:

```cpp
{ "HJNFJAHAOOE", { "AIIGAFCMICI" },   1, 0, &Shot_Angle,   false },   // fallback 0x38
```
(`PlayerShoot.angle`, base `DCBCCBKEIHN`, no ACTK shift, verified in both builds.)
That row is correct *as a row* — but again only if some consumer actually holds a
`HJNFJAHAOOE*`, which today none does.

---

## 5. Recommendation

Ordered, least-risk first:

1. **Now (safe, no RE needed): delete the write, not the constant's honesty.**
   `AimHooks.cpp`'s `SendShotPacketDetour` already achieves nothing useful with the
   `shotData` write, and the same detour's `Player_FacingAngle` write is table-resolved
   and correct. Removing the `Mem::TryWrite<float>(shotData, Shot_Angle, …)` line removes
   an OOB heap write and lets `Shot_Angle` be deleted outright — which closes row 2 of the
   `105-failclosed-gate-coverage.md` table by elimination rather than by promotion.

2. **Preferred proper fix: hook the PLAYERSHOOT builder and take the angle by value —
   no offset at all.** `HJNFJAHAOOE` (PlayerShoot) has one real 10-arg setter body at
   RVA `0x01000C50`, exposed under ~18 BeeByte decoy names (`GNHCIIBBMJB`, `EKMHNIIBIKA`,
   `PGHAGLDAKMH`, `FHKEGJHBPCM`, …), all with:

   ```
   (HJNFJAHAOOE *__this, int32 time, uint32 bulletId, uint16 containerType,
    int32 attackIndex, WorldPosData *startingPos, float angle, uint8 isBurst,
    int32 ?, JGNMPKCFLGL/*PlayerShootSource*/ shootSource, WorldPosData *playerPos)
   ```

   Resolving any one of those names with `paramCount = 10` yields the same address.
   Hooking it gives the angle as **argument 6 by value** — no field offset, nothing to
   self-heal, nothing for `IsFieldWriteTrusted` to gate. (Verify the resolved name still
   exists per build; the decoy set is the least stable part of this.)

3. **Only if a `ServerPlayerShoot.angle` consumer is ever written** (e.g. rewriting other
   players'/enemies' inbound shots), add the §4 `LEHICKLGHKC` row at that time, together
   with the consumer.

---

## 6. What would settle the remaining uncertainty

I am confident about the field identification and about `NKMHEINLOCD`. The one thing I
could not do read-only is prove what `Player::PMIANFBMMNN` *does*:

- **Disassembly of RVA `0x014C7700`** (144 bytes, `[0x014C7700, 0x014C7790)`, zero
  recorded field accesses) would name the method's behaviour outright. This is the single
  highest-value follow-up and it is cheap.
- **Runtime probe with the game attached** — `mcp__realm-engine-diag__re_field_offset`
  on class `LEHICKLGHKC` field `FFFFKPDHEFP` (expect 28) and on `HJNFJAHAOOE` field
  `AIIGAFCMICI` (expect 56) would confirm live metadata agrees with the dump; and
  `re_resolve_class`/`re_class_methods` on `FKALGHJIADI` would confirm `PMIANFBMMNN`'s
  live signature. Nothing here contradicts the dump, so I expect confirmation, but the
  probe is the only thing that closes the "dump is stale for this region" escape hatch
  (there is precedent — see the `OP_IsEnemy` note at `RuntimeOffsets.cpp:128-142`).
- **A log-only build** that prints `il2cpp_object_get_class(shotData)->name` at the top of
  `SendShotPacketDetour` would end the argument in one frame. This is the definitive test
  and it requires no offset guessing at all.

---

## Appendix — files referenced

- `internal/src/core/runtime/RuntimeOffsets.h:436-453` — MANUAL OFFSETS block, `Shot_Angle` at :445
- `internal/src/core/runtime/RuntimeOffsets.cpp:285-296` — `kActk`, `struct Entry`, `s_entries[]` format
- `internal/src/core/runtime/RuntimeOffsets.cpp:612-616` — `IsFieldWriteTrusted`
- `internal/src/core/runtime/RuntimeOffsets.cpp:486` — existing `Player_FacingAngle` row (correct)
- `internal/src/features/combat/autoaim/shoot/AimHooks.cpp:19-23, 108-130, 142-144` — the hook and the write
  (moved from `features/combat/autoaim/AimHooks.cpp` by the concurrent autoaim consolidation; line numbers unchanged)
- `internal/src/game/generated/il2cpp-functions.h:117087` — `FKALGHJIADI_PMIANFBMMNN`
- `internal/src/game/generated/il2cpp-functions.h:97279-97297` — `HJNFJAHAOOE` setter + decoys at `0x01000C50`
- `internal/src/game/generated/il2cpp-types.h:45458` — `NKMHEINLOCD__Fields`
- `internal/src/game/generated/il2cpp-types.h:267933` — `LEHICKLGHKC__Fields` (ServerPlayerShoot)
- `internal/src/game/generated/il2cpp-types.h:345216` — `HJNFJAHAOOE__Fields` (PlayerShoot)
- `docs/plans/105-failclosed-gate-coverage.md:103` — the ungated `Shot_Angle` write, row 2
- `client/data/packet-definitions.json` — PLAYERSHOOT wire definition (matches `HJNFJAHAOOE`)
