# 25 — PlayerTAB Offset Centralization

## Goal
Retire PlayerTAB's private 20-field offset resolution system
(`PlayerFieldCache` + `EnsurePlayerFieldOffsets` + 20 `FB_*` fallback
constants) by routing all reads through `RuntimeOffsets` (for fields it
already covers) and extending RuntimeOffsets with the ~10 fields it does not
yet cover (MP, Name, ClassNum, GuildRank, stat fields, EquipmentManager,
ItemSlot). After this plan, PlayerTAB has zero private offset constants
and one source of truth for field layout.

## Dependencies
None -- parallel-safe. No other plan touches `PlayerTAB.cpp`.

The RuntimeOffsets.h/cpp additions here overlap with plan 24 (which also
extends RuntimeOffsets). If both run in parallel, the implementer of the
later-merged plan must resolve trivial merge conflicts in RuntimeOffsets
(appending to disjoint sections of the table).

Files touched:
- `internal/src/core/runtime/RuntimeOffsets.h` (add ~10 offset variables)
- `internal/src/core/runtime/RuntimeOffsets.cpp` (add ~10 table entries)
- `internal/src/gui/tabs/PlayerTAB.cpp` (main migration target)

## Current state

### Private fallback constants (PlayerTAB.cpp:21-43)
```cpp
static constexpr uint32_t FB_POS_X         = 0x3C;
static constexpr uint32_t FB_POS_Y         = 0x40;
static constexpr uint32_t FB_HP            = 0x20C;
static constexpr uint32_t FB_MAX_HP        = 0x208;
static constexpr uint32_t FB_NAME          = 0x4B8;
static constexpr uint32_t FB_CLASSNUM      = 0x4B0;
static constexpr uint32_t FB_GRANK         = 0x4AC;
static constexpr uint32_t FB_CUR_MP        = 0x54C;
static constexpr uint32_t FB_MAX_MP        = 0x548;
static constexpr uint32_t FB_ATK           = 0x474;
static constexpr uint32_t FB_SPD           = 0x478;
static constexpr uint32_t FB_DEX           = 0x47C;
static constexpr uint32_t FB_VIT           = 0x480;
static constexpr uint32_t FB_WIS           = 0x484;
static constexpr uint32_t FB_DEF           = 0x508;
static constexpr uint32_t FB_COND_INT      = 0x514;
static constexpr uint32_t FB_COND_RAW      = 0x440;
static constexpr uint32_t FB_EQUIPMENT_MGR = 0x668;
static constexpr uint32_t FB_EM_SLOTS      = 0x48;
static constexpr uint32_t FB_ITEM_OP       = 0x58;
static constexpr uint32_t FB_ITEM_TYPE     = 0x60;
```

### Private resolution system (PlayerTAB.cpp:48-178)
- `PlayerFieldCache` struct (20 fields + `ready` + `fromIl2Cpp` flags)
- `FindFieldOnHierarchy()` -- walks IL2CPP class hierarchy
- `FieldOffsetOr()` -- gets offset with fallback
- `ApplyFallbackFieldOffsets()` -- populates cache with FB_* or RuntimeOffsets::*
- `EnsurePlayerFieldOffsets()` -- resolves all fields from FKALGHJIADI class
- `ResolveEquipmentManagerClass()` -- finds EquipmentManager by namespace or BeeByte
- `ResolveItemSlotClass()` -- finds ItemSlot by namespace or BeeByte

### Fields already in RuntimeOffsets
These are duplicated between PlayerTAB and RuntimeOffsets:
- `PosX` (RuntimeOffsets::PosX, fallback 0x3C) -- matches FB_POS_X
- `PosY` (RuntimeOffsets::PosY, fallback 0x40) -- matches FB_POS_Y
- `HP` (RuntimeOffsets::HP, fallback 0x20C) -- matches FB_HP
- `MaxHP` (RuntimeOffsets::MaxHP, fallback 0x208) -- matches FB_MAX_HP
- `Defense` (RuntimeOffsets::Defense, fallback 0x210) -- **diverges from FB_DEF 0x508**
  (see Divergence section below)
- `CurMP` (RuntimeOffsets::CurMP, fallback 0x54C) -- matches FB_CUR_MP
- `MaxMP` (RuntimeOffsets::MaxMP, fallback 0x548) -- matches FB_MAX_MP

### Fields NOT yet in RuntimeOffsets (need to be added)
- `Name` (NFJGJKLPLBA, fallback 0x4B8) -- Il2CppString* field
- `ClassNum` (KABPJBJPGCM, fallback 0x4B0) -- int32
- `GuildRank` (GBANOMPLGBH, fallback 0x4AC) -- int32
- `Atk` (HCMECDPHEMC, fallback 0x474) -- int32
- `Spd` (BHJFNEAHAOE, fallback 0x478) -- int32
- `Dex` (GDNEBFDDDKM, fallback 0x47C) -- int32
- `Vit` (CGFPEPCKKOK, fallback 0x480) -- int32
- `Wis` (HDCDGHKGLDI, fallback 0x484) -- int32
- `CondInt` (MPJGAPJBBBF, fallback 0x514) -- int32 (single-int condition)
- `EquipmentMgr` (AJJJBDBNBLM, fallback 0x668) -- pointer to EquipmentManager

Equipment-internal offsets (`EM_SLOTS`, `ITEM_OP`, `ITEM_TYPE`) are harder
to add to RuntimeOffsets because they belong to different classes
(EquipmentManager, ItemSlot). These can remain as local constants with
runtime resolution, or be added to RuntimeOffsets as separate class entries.

### Divergence: Defense offset
RuntimeOffsets uses `HODJPKFINKF` (fallback 0x210) for Defense. PlayerTAB
uses `NNECFGPDBEE` (fallback 0x508 = dump 0x4B8 + 0x50 ACTK). These are
different fields on potentially different classes in the hierarchy.
`RuntimeOffsets::Defense` resolves on LKHPPBEGNOM (the MapObject base),
while PlayerTAB resolves on FKALGHJIADI (the Player subclass). The Player
subclass field `NNECFGPDBEE` is the correct defense for display purposes.
Both should resolve to the same runtime value if the self-healing lookup
succeeds. **When migrating, use `RuntimeOffsets::Defense` (which is already
used by `LocalPlayer::GetDefense()` and every combat feature). If the
PlayerTAB display shows a different value, it is a sign that the two field
names point to different data -- investigate before shipping.**

## Target design

### New RuntimeOffsets entries
Add to `RuntimeOffsets.h` under a `// Player diagnostic stats` section:
```cpp
extern uint32_t PlayerName;      // NFJGJKLPLBA  fallback 0x4B8
extern uint32_t PlayerClassNum;  // KABPJBJPGCM  fallback 0x4B0
extern uint32_t PlayerGuildRank; // GBANOMPLGBH  fallback 0x4AC
extern uint32_t PlayerAtk;       // HCMECDPHEMC  fallback 0x474
extern uint32_t PlayerSpd_Stat;  // BHJFNEAHAOE  fallback 0x478 (renamed to avoid Player_Spd conflict)
extern uint32_t PlayerDex;       // GDNEBFDDDKM  fallback 0x47C
extern uint32_t PlayerVit;       // CGFPEPCKKOK  fallback 0x480
extern uint32_t PlayerWis;       // HDCDGHKGLDI  fallback 0x484
extern uint32_t PlayerCondInt;   // MPJGAPJBBBF  fallback 0x514
extern uint32_t PlayerEquipMgr; // AJJJBDBNBLM  fallback 0x668
```

Note: `Player_Spd` already exists in RuntimeOffsets (line 234) for the
movement speed field. The stat "speed" on the character sheet is a different
field. Name it `PlayerSpd_Stat` or check whether `Player_Spd` is actually
the same field -- if so, reuse it.

All entries resolve against the FKALGHJIADI class (the Player class), which
is already known to RuntimeOffsets (it is the class used for the self-healing
table lookups of HP, MaxHP, etc.).

### PlayerTAB simplification
After migration:
1. Delete `FB_*` constants (lines 21-43)
2. Delete `PlayerFieldCache` struct (lines 48-60)
3. Delete `g_fields` global (line 62)
4. Delete `FindFieldOnHierarchy` (lines 64-72)
5. Delete `FieldOffsetOr` (lines 74-80)
6. Delete `ApplyFallbackFieldOffsets` (lines 82-109)
7. Simplify `EnsurePlayerFieldOffsets` -- either delete entirely (if all
   offsets are now in RuntimeOffsets) or reduce to resolving only the 3
   equipment sub-class offsets
8. Replace all `g_fields.posX` reads with `RuntimeOffsets::PosX`, etc.

The equipment sub-offsets (`EM_SLOTS`, `ITEM_OP`, `ITEM_TYPE`) can remain
as locally resolved fields with their fallback constants, since they belong
to different IL2CPP classes (EquipmentManager, ItemSlot) and are only used
in the equipment display section of PlayerTAB.

## Steps

### Step 1 -- Add player stat offsets to RuntimeOffsets
Files: `internal/src/core/runtime/RuntimeOffsets.h`,
       `internal/src/core/runtime/RuntimeOffsets.cpp`

Add the ~10 new offset variables with their BeeByte field names and fallback
values. Add corresponding entries to the self-healing table in
`RuntimeOffsets.cpp` (the `s_entries` array), resolving against FKALGHJIADI.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Replace g_fields reads with RuntimeOffsets in PlayerTAB
File: `internal/src/gui/tabs/PlayerTAB.cpp`

Mechanically replace every `g_fields.posX` with `RuntimeOffsets::PosX`,
`g_fields.hp` with `RuntimeOffsets::HP`, etc. For the new fields, use the
new RuntimeOffsets names (e.g., `g_fields.nameStr` -> `RuntimeOffsets::PlayerName`).

Ensure the reads still use `Mem::TryRead` or `Mem::ReadOr` (they already do
in most places via the existing pattern).

Before:
```cpp
float px = Mem::ReadOr<float>(localFk, g_fields.posX, 0.f);
```
After:
```cpp
float px = Mem::ReadOr<float>(localFk, RuntimeOffsets::PosX, 0.f);
```

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 -- Delete private offset infrastructure
File: `internal/src/gui/tabs/PlayerTAB.cpp`

1. Delete `FB_*` constants (lines 21-43).
2. Delete `PlayerFieldCache` struct, `g_fields` global.
3. Delete `FindFieldOnHierarchy`, `FieldOffsetOr`, `ApplyFallbackFieldOffsets`.
4. Simplify `EnsurePlayerFieldOffsets` to only resolve the 3 equipment
   sub-class offsets (EM_SLOTS, ITEM_OP, ITEM_TYPE) or delete it entirely
   if those are also centralized.

Keep `ResolveEquipmentManagerClass()` and `ResolveItemSlotClass()` -- they
are still needed for equipment display.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Verify parity and clean up
File: `internal/src/gui/tabs/PlayerTAB.cpp`

1. Confirm the Player tab displays identical values to before migration.
   (This requires injecting into a game -- manual testing.)
2. Remove any dead includes.
3. Run guardrails.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails still pass
bash internal/tools/check-raw-access.sh

# No private fallback constants remain:
grep -n 'FB_POS\|FB_HP\|FB_MAX_HP\|FB_NAME\|FB_CLASSNUM\|FB_GRANK\|FB_CUR_MP\|FB_MAX_MP\|FB_ATK\|FB_SPD\|FB_DEX\|FB_VIT\|FB_WIS\|FB_DEF\|FB_COND\|FB_EQUIPMENT' internal/src/gui/tabs/PlayerTAB.cpp
# Expected: EMPTY (or only equipment sub-offsets if kept locally)

# PlayerFieldCache struct should be gone:
grep -n 'PlayerFieldCache\|g_fields\.' internal/src/gui/tabs/PlayerTAB.cpp
# Expected: EMPTY
```

## Out of scope
- Migrating PlayerTAB reads to `Game::Character` wrappers -- that is a
  separate concern (plan 26). This plan centralizes offsets; Game:: adoption
  is the next layer.
- Adding equipment sub-class offsets (EM_SLOTS, ITEM_OP, ITEM_TYPE) to
  RuntimeOffsets -- these belong to EquipmentManager/ItemSlot classes and
  are only used in PlayerTAB's equipment display. They can stay as locally
  resolved fields.
- Changing the Defense field source (HODJPKFINKF vs NNECFGPDBEE) -- this
  is flagged as a divergence and must be investigated manually.
