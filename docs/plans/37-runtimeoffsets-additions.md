# 37 — RuntimeOffsets Registry Additions

## Goal
Every game-specific field offset that feature/GUI code currently defines as a
private `constexpr uint32_t … = 0x…` gains a home in
`core/runtime/RuntimeOffsets.{h,cpp}` — either as a **table-resolved entry**
(self-healing, visible in the Test → OFFSET HEALTH panel) when the BeeByte
field name is known, or as a **documented manual constant** (single
update-on-patch location) when only the numeric offset is known. This plan
ONLY adds the registry entries; consumer migration happens in plans 39-42.
After this plan the DLL builds and behaves identically (nothing reads the new
entries yet).

## Dependencies
None — parallel-safe with plan 38. Plans 39, 40, 41, 42 depend on this plan.

Files touched (no other plan in this wave touches them):
- `internal/src/core/runtime/RuntimeOffsets.h`
- `internal/src/core/runtime/RuntimeOffsets.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.

## Current state

The offsets being centralized live today as private constants / locally
resolved statics in consumer files (all paths relative to `internal/src/`):

| Consumer | Line(s) | Constant | Value | Field identity |
|---|---|---|---|---|
| `features/movement/collider/PlayerCollider.cpp` | 12 | `kOffCollisionMultiplierFallback` | 0x780 | `ObjectProperties.collisionRadiusMultiplier` (real name — see PlayerCollider.cpp:115) |
| `gui/tabs/TestTAB.cpp` | 221 | `kOffCollisionMult` | 0x780 | same field, duplicated constant |
| `features/combat/autoaim/ProjNoclip.cpp` | 51 | `kFallbackEokOff` | 0x58 | `KJMONHENJEN.EOKJOGFPLOA` (BGAIOPJMHLO* tile ref) |
| `features/combat/autoaim/ProjNoclip.cpp` | 54 | `kFallbackEbclOff` | 0x44 | `BGAIOPJMHLO.EBCLNFDKKEH` (int32 layer enum) |
| `features/combat/autoaim/ProjNoclip.cpp` | 42 | `s_npmOff` (no fallback, 0) | — | `HBEAKBIHANL.NPMECLDKGEF` (bool noclip guard) |
| `gui/tabs/WorldTAB.cpp` | 2294 | `kSquareDamageOffFallback` | 0x10 | `BGAIOPJMHLO.EAPMKCKMNDI` (int32 cached damage) |
| `gui/tabs/WorldTAB.cpp` | 2295 | `kSquareCoverOffFallback` | 0x48 | `BGAIOPJMHLO.JGMBPFJEGAH` (ref, cover object) |
| `gui/tabs/WorldTAB.cpp` | 64 | `OFF_KJM_OBJECT_ID` | 0xC0 | `KJMONHENJEN.FDNHINDAEHK` (dict-key object id; distinct from `ObjId`/HHPOJBFICAH @0x34) |
| `gui/tabs/PlayerTAB.cpp` | 24 | `kFB_EM_SLOTS` | 0x48 | `EquipmentManager.equipmentSlots` (real name) |
| `gui/tabs/PlayerTAB.cpp` | 25 | `kFB_ITEM_OP` | 0x58 | `ItemSlot.HLJFBHLMANJ` (ObjectProperties*) |
| `gui/tabs/PlayerTAB.cpp` | 26 | `kFB_ITEM_TYPE` | 0x60 | `ItemSlot.INAAIAHOEFE` (int32 type id) |
| `gui/tabs/PlayerTAB.cpp` | 30 | `kCondRawOffset` | 0x440 | raw `[this+0x440]` from .lst analysis — NO field name exists |
| `features/combat/autoaim/WeaponProfile.cpp` | 17 | `kOffCharSpeedMul` | 0x188 | player proj-speed multiplier — RE'd, name unknown |
| `features/combat/autoaim/WeaponProfile.cpp` | 18 | `kOffCharLifetimeMul` | 0x18C | player proj-lifetime multiplier — RE'd, name unknown |
| `features/combat/autoaim/WeaponProfile.cpp` | 19 | `kOffCharRangeMul` | 0x6B8 | player range multiplier — RE'd, name unknown |
| `features/combat/autoaim/WeaponProfile.cpp` | 20 | `kOffProjId` | 0x15C | `ProjectileProperties` projectile id — RE'd, name unknown |
| `features/combat/autoaim/AimHooks.cpp` | 27 | `kOffShotAngle` | 0x1C | angle field in the SHOOT packet struct (`shotData`) |
| `gui/tabs/WorldTAB.cpp` | 76-82 | `OFF_WM_UINT_D8/DC/E0`, `OFF_WM_FLOAT_F4/F8`, `OFF_WM_INT_FC/100` | 0xD8-0x100 | WorldManager diagnostic words. **0xD8/0xDC already exist as `RuntimeOffsets::WM_TickId`/`WM_TickId2`** (RuntimeOffsets.cpp:94-95); the other five are unnamed diagnostics |
| `gui/tabs/WorldTAB.cpp` | 62 | `OFF_PLAYER_GUILD` | 0x468 | guild string on FKALGHJIADI. Commented as field `NFJGJKLPLBA`, which COLLIDES with the existing `PlayerName` table row (see Divergence) |

The registry's conventions to follow are documented in the block comment at
`RuntimeOffsets.cpp:232-258` (`Entry` struct: className →
`Resolver::FindClassLoose`, up to 4 candidate field names, optional
`kActk = 0x50` shift, `outPtr`, `done`).

## Target design

### A. New table-resolved entries (field name known → self-healing)

Add to `RuntimeOffsets.h` (in the matching class sections, same comment style
as neighbors) and to `RuntimeOffsets.cpp` (fallback initializer +
`s_entries[]` row):

```cpp
// ── ObjectProperties ──
extern uint32_t OP_CollRadiusMult;   // "collisionRadiusMultiplier"  fallback 0x780

// ── KJMONHENJEN ──
extern uint32_t KJ_TileRef;          // EOKJOGFPLOA  fallback 0x58  (BGAIOPJMHLO* current tile)
extern uint32_t KJ_DictObjectId;     // FDNHINDAEHK  fallback 0xC0  (dict-key object id; NOT ObjId/HHPOJBFICAH)

// ── BGAIOPJMHLO tile/square ──
extern uint32_t Sq_Layer;            // EBCLNFDKKEH  fallback 0x44  (int32 layer enum; ProjNoclip writes 37)
extern uint32_t Sq_DamageCached;     // EAPMKCKMNDI  fallback 0x10  (int32 current-damage cache)
extern uint32_t Sq_Cover;            // JGMBPFJEGAH  fallback 0x48  (ref; non-null = square has cover)

// ── HBEAKBIHANL projectile instance ──
extern uint32_t Hbeak_NoclipGuard;   // NPMECLDKGEF  fallback 0     (bool; 0 = unresolved — ProjNoclip
                                     // MUST NOT install until this is non-zero, preserving today's gate)

// ── EquipmentManager / ItemSlot (namespaced UI classes) ──
extern uint32_t EM_EquipSlots;       // "equipmentSlots"  fallback 0x48  (ItemSlot[] on EquipmentManager)
extern uint32_t Item_ObjProps;       // HLJFBHLMANJ       fallback 0x58  (ObjectProperties* on ItemSlot)
extern uint32_t Item_ObjType;        // INAAIAHOEFE       fallback 0x60  (int32 type id on ItemSlot)
```

Corresponding `s_entries[]` rows (all `actkShift = 0` — none of these classes
is ACTK-shifted; ProjNoclip.cpp:41 confirms for HBEAKBIHANL/BGAIOPJMHLO,
PlayerTAB's plan-25 comment at PlayerTAB.cpp:19-22 confirms
EquipmentManager/ItemSlot are separate non-shifted classes):

```cpp
{ "ObjectProperties", { "collisionRadiusMultiplier" }, 1, 0, &OP_CollRadiusMult, false },
{ "KJMONHENJEN",      { "EOKJOGFPLOA" },               1, 0, &KJ_TileRef,        false },
{ "KJMONHENJEN",      { "FDNHINDAEHK" },               1, 0, &KJ_DictObjectId,   false },
{ "BGAIOPJMHLO",      { "EBCLNFDKKEH" },               1, 0, &Sq_Layer,          false },
{ "BGAIOPJMHLO",      { "EAPMKCKMNDI" },               1, 0, &Sq_DamageCached,   false },
{ "BGAIOPJMHLO",      { "JGMBPFJEGAH" },               1, 0, &Sq_Cover,          false },
{ "HBEAKBIHANL",      { "NPMECLDKGEF" },               1, 0, &Hbeak_NoclipGuard, false },
{ "EquipmentManager", { "equipmentSlots" },            1, 0, &EM_EquipSlots,     false },
{ "ItemSlot",         { "HLJFBHLMANJ" },               1, 0, &Item_ObjProps,     false },
{ "ItemSlot",         { "INAAIAHOEFE" },               1, 0, &Item_ObjType,      false },
```

Class-name notes:
- `Resolver::FindClassLoose` matches the il2cpp SHORT name in any namespace
  (Il2CppResolver.cpp:340-352), so `"EquipmentManager"` and `"ItemSlot"`
  resolve the `DecaGames.RotMG.*` classes exactly as PlayerTAB.cpp:52/60 does
  today via `Resolver::FindClass`. PlayerTAB also had BeeByte class fallbacks
  (`PNBNDBIPENP`, `CMHHJNPDMHJ`) for older builds; the `Entry` struct supports
  only one className, so if a future build obfuscates these class names the
  row goes stale and the fallback constant holds — the same failure mode every
  other row already has, now VISIBLE in the health panel instead of silent.
- `Hbeak_NoclipGuard` intentionally has fallback **0**: ProjNoclip.cpp:180
  today refuses to install its hook when this field cannot be resolved from
  metadata ("no reliable static fallback" — ProjNoclip.cpp:55). Keeping 0
  preserves that safety gate through the registry.

### B. New manual constants (no field name known → no table row)

Add a clearly-marked section near the bottom of `RuntimeOffsets.h`, with the
same values the consumers use today. These do NOT self-heal; the point is one
place to update on a game patch and one grep-able namespace:

```cpp
// ── MANUAL OFFSETS — no known IL2CPP field name; NOT table-resolved.  ──────
// These were reverse-engineered numerically (disassembly / .lst / probing).
// They do NOT self-heal and do NOT appear in OFFSET HEALTH. After a game
// patch, re-derive each one (source cited per line) and update here.
// constexpr (not extern) — nothing ever overwrites them at runtime.
inline constexpr uint32_t Char_ProjSpeedMul    = 0x188; // player proj-speed mult (WeaponProfile RE)
inline constexpr uint32_t Char_ProjLifetimeMul = 0x18C; // player proj-lifetime mult (WeaponProfile RE)
inline constexpr uint32_t Char_RangeMul        = 0x6B8; // player range mult (WeaponProfile RE)
inline constexpr uint32_t PP_ProjId            = 0x15C; // ProjectileProperties projectile id (WeaponProfile RE)
inline constexpr uint32_t Shot_Angle           = 0x1C;  // SHOOT packet struct angle (AimHooks RE)
inline constexpr uint32_t Player_CondRaw       = 0x440; // raw [this+0x440] HasConditionEffect reads (.lst)
inline constexpr uint32_t Player_GuildName     = 0x468; // FKALGHJIADI guild string — see NFJGJKLPLBA
                                                        // conflict note in docs/plans/36-adoption-overview.md
// WorldManager diagnostic words (WorldTAB World-tab display only):
inline constexpr uint32_t WM_DiagE0  = 0xE0;  // uint32
inline constexpr uint32_t WM_DiagF4  = 0xF4;  // float
inline constexpr uint32_t WM_DiagF8  = 0xF8;  // float
inline constexpr uint32_t WM_DiagFC  = 0xFC;  // int32
inline constexpr uint32_t WM_Diag100 = 0x100; // int32
```

(No `WM_DiagD8`/`WM_DiagDC` — consumers must use the existing table-resolved
`WM_TickId`/`WM_TickId2`, which have the same fallbacks.)

### Divergence warnings
- **Do NOT add a table row for `Player_GuildName`/NFJGJKLPLBA.** The existing
  `PlayerName` row (`RuntimeOffsets.cpp:319`) already resolves field
  NFJGJKLPLBA on FKALGHJIADI. WorldTAB.cpp:58-62 claims NFJGJKLPLBA is the
  *guild* string at 0x468 while `PlayerName`'s fallback is 0x4B8 — the same
  name cannot be both. Adding a second row would make the health panel lie.
  Keep the manual constant and leave the conflict for a human to resolve
  in-game (flagged in plan 36).
- `KJ_DictObjectId` (0xC0) is intentionally distinct from the existing
  `ObjId` (HHPOJBFICAH, 0x34). WorldTAB.cpp:673-676 uses the 0xC0 field as a
  fallback when pointer-matching the local player fails. Do not merge them.

## Steps

### Step 1 — Add extern declarations to RuntimeOffsets.h
File: `internal/src/core/runtime/RuntimeOffsets.h`

Add the 10 `extern uint32_t` declarations from section A into the matching
class-grouped sections (KJMONHENJEN block around line 105-115, BGAIOPJMHLO
block around line 272-276, ObjectProperties block around line 288-313,
HBEAKBIHANL block around line 352-356; create a short new
"EquipmentManager / ItemSlot" section after the FKALGHJIADI block). Copy the
comment style of neighboring entries (BeeByte name + fallback).

Add the manual-constants section from B at the end of the namespace (before
the closing `}`), including the header comment verbatim.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 — Add fallback initializers and table rows to RuntimeOffsets.cpp
File: `internal/src/core/runtime/RuntimeOffsets.cpp`

- Add the 10 `uint32_t Name = fallback;` definitions next to their class
  groups (near lines 19-28 for KJMONHENJEN, 97-100 for BGAIOPJMHLO, 111-131
  for ObjectProperties, 165-169 for HBEAKBIHANL; new short group for
  EquipmentManager/ItemSlot after line 77).
- Add the 10 `s_entries[]` rows from section A, grouped with their classes
  (KJMONHENJEN rows after line 283, BGAIOPJMHLO rows after line 348, the
  ObjectProperties row after line 381, the `Hbeak_NoclipGuard` row in a new
  one-row HBEAKBIHANL group with a comment, EquipmentManager/ItemSlot rows
  after the CameraManager rows at lines 330-331).

Manual constants need NO .cpp change (they are `inline constexpr` in the
header).

**Verify:** `bash internal/tools/wsl-build.sh Debug` — must compile clean.
Also `bash internal/tools/check-raw-access.sh` — still exit 0 (this plan only
touches the sanctioned home, which is out of the checker's scope).

### Step 3 — Sanity-check offset-health panel row capacity
`GetOffsetReport(out, maxRows)` fills a caller-provided buffer. Search
`GetOffsetReport(` in `gui/tabs/TestTAB.cpp`; if the caller's row buffer is a
fixed array smaller than the new total row count, bump ONLY that array size
(and its `maxRows` argument). Do not otherwise modify TestTAB — plan 40 owns
it. If the buffer is already large enough, change nothing.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

## Verification
```bash
bash internal/tools/wsl-build.sh Debug          # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh          # exit 0

# New table entries exist (expect 10 names present):
grep -c 'OP_CollRadiusMult\|KJ_TileRef\|KJ_DictObjectId\|Sq_Layer\|Sq_DamageCached\|Sq_Cover\|Hbeak_NoclipGuard\|EM_EquipSlots\|Item_ObjProps\|Item_ObjType' internal/src/core/runtime/RuntimeOffsets.h

# Manual constants exist (expect >= 12 lines):
grep -c 'Char_ProjSpeedMul\|Char_ProjLifetimeMul\|Char_RangeMul\|PP_ProjId\|Shot_Angle\|Player_CondRaw\|Player_GuildName\|WM_Diag' internal/src/core/runtime/RuntimeOffsets.h
```

## Out of scope
- Migrating ANY consumer file (plans 39-42 do that).
- Touching `PlayerName` / `PlayerIGN` rows or resolving the NFJGJKLPLBA
  conflict.
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/` — dodge program
  territory (plans 30-35).
- `game/objects/GameObjects.h` — no new wrapper accessors in this plan.
