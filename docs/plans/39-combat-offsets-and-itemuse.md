# 39 — Combat Offset Migration + Shared ItemUse Home

## Goal
The combat features stop resolving game field offsets privately and stop
duplicating the "use an inventory item" call sequence:

1. A new `Game::ItemUse` module (`game/actions/ItemUse.{h,cpp}`) owns
   EquipmentManager method resolution and the equipment-manager pointer read.
   AutoAbility and AutoNexus (which today carry two near-identical private
   copies) call it instead.
2. WeaponProfile's four RE'd magic offsets and AimHooks' SHOOT-packet angle
   offset move to the `RuntimeOffsets` manual constants added by plan 37.

Behavior is preserved except one flagged gating change (see Divergence
warnings).

## Dependencies
- **Plan 37 must be merged first** (uses `RuntimeOffsets::Char_ProjSpeedMul`,
  `Char_ProjLifetimeMul`, `Char_RangeMul`, `PP_ProjId`, `Shot_Angle`).
- Parallel-safe with plans 38, 40, 41, 42 (disjoint files).
- **Cross-wave conflict:** `il2cpp-dll-injection.vcxproj` (+ `.filters`) is
  also edited by dodge plans 31/33/35 (udodge files). Merge this plan after
  those, or resolve the trivial ItemGroup conflict.

Files touched:
- `internal/src/game/actions/ItemUse.h` (NEW)
- `internal/src/game/actions/ItemUse.cpp` (NEW)
- `internal/il2cpp-dll-injection.vcxproj` and `.vcxproj.filters`
- `internal/src/features/combat/autoability/AutoAbility.cpp`
- `internal/src/features/combat/autonexus/AutoNexus.cpp`
- `internal/src/features/combat/autoaim/WeaponProfile.cpp`
- `internal/src/features/combat/autoaim/AimHooks.cpp`

Do NOT touch `internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.

## Current state

### Duplicated item-use resolution (AutoAbility ≡ AutoNexus)
`features/combat/autoability/AutoAbility.cpp:25-72` and
`features/combat/autonexus/AutoNexus.cpp:36-39,576-624` both:

1. typedef `UseInvByHotkeyFn = void(__fastcall*)(void* eqMgr, int32_t hotkey,
   void* methodInfo)` (AutoAbility.cpp:25, AutoNexus.cpp:36);
2. resolve `EquipmentManager.UseInventoryItemByHotkey` (real name +
   `PNBNDBIPENP` BeeByte fallback) via `Il2CppHook::ResolveMethodCached`
   (AutoAbility.cpp:44-50, AutoNexus.cpp:585-591);
3. resolve `FKALGHJIADI.AJJJBDBNBLM` with a private
   `il2cpp_class_get_field_from_name` + `il2cpp_field_get_offset` block into a
   local `s_eqMgrFieldOff` **with no fallback** (AutoAbility.cpp:61-67,
   AutoNexus.cpp:594-600) — even though this exact field is already in the
   registry as `RuntimeOffsets::PlayerEquipMgr` (fallback 0x668,
   RuntimeOffsets.cpp:77,327);
4. read `eqMgr = Mem::ReadPtr(lp, s_eqMgrFieldOff)` and call the game function
   inside `Resolver::Protection::safe_call` (AutoAbility.cpp:94-130,
   AutoNexus.cpp:604-623).

AutoAbility additionally resolves the 6-arg `UseInventoryItem` targeted
overload (AutoAbility.cpp:52-58) and calls it with
`(eqMgr, player, slot, 0, Vec2{x,y}, false, false)` (AutoAbility.cpp:118-124).

### WeaponProfile magic offsets
`features/combat/autoaim/WeaponProfile.cpp:16-20`:
```cpp
// Player character projectile tuning fields (RE'd offsets, not yet in RuntimeOffsets)
static constexpr uint32_t kOffCharSpeedMul    = 0x188;
static constexpr uint32_t kOffCharLifetimeMul = 0x18C;
static constexpr uint32_t kOffCharRangeMul    = 0x6B8;
static constexpr uint32_t kOffProjId          = 0x15C;
```
Used in `raw-access-ok`-marked hot-loop reads at WeaponProfile.cpp:30, 31, 36
and 118-119. The reads stay raw (shared-SEH sweep, plan 16); only the
constants move so a game patch has one update site.

### AimHooks SHOOT-packet offset
`features/combat/autoaim/AimHooks.cpp:26-27`:
```cpp
// shotData+0x1C is the angle field in the SHOOT packet struct
static constexpr uint32_t kOffShotAngle = 0x1C;
```
Used at AimHooks.cpp:129: `Mem::TryWrite<float>(shotData, kOffShotAngle, newAngle);`
(There is also a pointer-validity probe at AimHooks.cpp:115 using `+ 0x24`;
that is a bounds check, not a named field — leave it.)

## Target design

### game/actions/ItemUse.h (new)
```cpp
#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// Game::ItemUse — the ONE home for invoking EquipmentManager item usage.
// Owns method resolution (cached via Il2CppHook::ResolveMethodCached) and the
// player→EquipmentManager pointer read (RuntimeOffsets::PlayerEquipMgr).
// Consumers: AutoAbility (ability fire), AutoNexus (auto-pot).
// Thread-safety: call from the render thread only (same rule the current
// per-feature copies follow — resolution is lazy, calls are safe_call-wrapped).
// ─────────────────────────────────────────────────────────────────────────────
namespace Game { namespace ItemUse {

    // Lazily resolves methods on first call; cheap afterwards. True when the
    // hotkey path is callable (method resolved AND local player + eq-mgr
    // pointer currently available).
    bool Ready();

    // EquipmentManager.UseInventoryItemByHotkey(eqMgr, hotkey).
    // Returns false (no-op) if not Ready().
    bool UseByHotkey(int hotkey);

    // True when the 6-arg targeted overload resolved (optional capability).
    bool TargetedAvailable();

    // EquipmentManager.UseInventoryItem(eqMgr, player, slot, 0, {x,y}, false, false).
    // Returns false (no-op) if the targeted overload is unavailable.
    bool UseTargeted(int slot, float x, float y);

}} // namespace Game::ItemUse
```

### game/actions/ItemUse.cpp (new)
Port AutoAbility.cpp:25-72 wholesale, with these changes:
- typedefs and `Vec2` struct move here unchanged (keep the ABI comment from
  AutoAbility.cpp:26-28: Vector2 passes by value, two register slots).
- Resolution tries real name first, BeeByte second — exactly
  AutoAbility.cpp:44-58 (`ResolveMethodCached("EquipmentManager",
  "UseInventoryItemByHotkey", 1, false, "DecaGames.RotMG.Managers.Equipment")`
  then `("PNBNDBIPENP", …, 1)`; same pattern for `UseInventoryItem` argc 6).
- The private field resolution block (AutoAbility.cpp:61-67) is NOT ported.
  The eq-mgr pointer read becomes:
  ```cpp
  void* lp = LocalPlayer::GetPtr();
  if (!lp) return false;
  void* eqMgr = Mem::ReadPtr(lp, RuntimeOffsets::PlayerEquipMgr);
  if (!eqMgr) return false;
  ```
- Game calls stay wrapped in `Resolver::Protection::safe_call` exactly as
  AutoAbility.cpp:122-129.

Includes needed: `pch-il2cpp.h`, `Il2CppHook.h`, `Il2CppResolver.h`,
`LocalPlayer.h`, `core/runtime/MemRead.h`, `core/runtime/RuntimeOffsets.h`.

### Divergence warnings
- **Gating change (flagged, accepted):** today AutoAbility.cpp:71 and
  AutoNexus.cpp:601 refuse to fire until `AJJJBDBNBLM` resolves from live
  metadata (`s_eqMgrFieldOff != 0`, no fallback). `RuntimeOffsets::
  PlayerEquipMgr` is pre-initialised to 0x668, so after migration the gate is
  "methods resolved" only. This matches PlayerTAB, which already reads
  equipment through the 0x668 fallback (PlayerTAB.cpp:187-191). Risk is
  bounded: `Mem::ReadPtr` AddrOk-validates the pointer and every game call is
  SEH-wrapped. If the user wants the strict gate back, it must come from a
  registry-health query, not a private resolver — do not re-add the local
  copy.
- AutoNexus resolves ONLY the hotkey path; AutoAbility also resolves the
  targeted path. `ItemUse` resolves both in one lazy pass — AutoNexus gains a
  harmless extra cached lookup.

## Steps

### Step 1 — Create ItemUse and register it in the project
Files: `internal/src/game/actions/ItemUse.h` (new),
`internal/src/game/actions/ItemUse.cpp` (new),
`internal/il2cpp-dll-injection.vcxproj`, `internal/il2cpp-dll-injection.vcxproj.filters`

Create both files per Target design. In the vcxproj add
`<ClCompile Include="src\game\actions\ItemUse.cpp" />` to the ClCompile
ItemGroup and `<ClInclude Include="src\game\actions\ItemUse.h" />` to the
ClInclude ItemGroup (alongside the existing
`src\game\objects\GameObjects.h` entry at vcxproj line ~173). Mirror the
entries in `.filters`, copying the filter-node convention used by the
`src\game\objects\` entries (add a `game\actions` filter if the file uses
per-folder filters).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 — Migrate AutoAbility
File: `internal/src/features/combat/autoability/AutoAbility.cpp`

- Delete lines 24-37 (typedefs, `Vec2`, `s_fnHotkey`, `s_fnTargeted`,
  `s_eqMgrFieldOff`, `s_resolved`) and the whole `ResolveOnce()`
  (lines 39-72).
- In `Tick()` (lines 78-132): replace `ResolveOnce(); if (!s_fnHotkey ||
  !s_eqMgrFieldOff) return;` with `if (!Game::ItemUse::Ready()) return;`;
  delete the local `lp`/`eqMgr` reads (lines 94-97); replace the targeted
  branch's direct `s_fnTargeted(...)` call (lines 118-124) with
  `Game::ItemUse::UseTargeted(hk, target.x, target.y)` and the hotkey branch
  (lines 126-129) with `Game::ItemUse::UseByHotkey(hk)`. The targeting
  availability check `s_fnTargeted != nullptr` (line 100) becomes
  `Game::ItemUse::TargetedAvailable()`.
- In `SetEnabled` (line 137): `if (on) ResolveOnce();` →
  `if (on) (void)Game::ItemUse::Ready();`
- Add `#include "game/actions/ItemUse.h"`; drop now-unused includes if any
  (`Il2CppResolver.h` stays only if still referenced).

The aim-target computation (lines 102-116) is unchanged — only the transport
of `target.x/target.y` into `UseTargeted` changes.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 3 — Migrate AutoNexus auto-pot
File: `internal/src/features/combat/autonexus/AutoNexus.cpp`

- Delete the statics at lines 36-39 (`UseInvByHotkeyFn`,
  `s_fnUseInvByHotkey`, `s_eqMgrFieldOff`, `s_autoPotResolved`) and the
  functions `ResolveAutoPotOnce()` (lines 580-602) and
  `ReadEquipmentManagerPtr()` (lines 604-608).
- Rewrite `TryDrinkHotkey` (lines 610-624) to:
  ```cpp
  static void TryDrinkHotkey(int hotkey, ULONGLONG& lastTickMs, ULONGLONG cooldownMs)
  {
      if (!Game::ItemUse::Ready()) return;
      const ULONGLONG now = GetTickCount64();
      if (now - lastTickMs < cooldownMs) return;
      if (Game::ItemUse::UseByHotkey(hotkey))
          lastTickMs = now;
      else
          lastTickMs = now;   // preserve old behavior: cooldown starts on attempt
  }
  ```
  Note: the old code set `lastTickMs = now` after the safe_call regardless of
  outcome — keep that (both branches above), do not make retry-on-failure
  faster.
- Add `#include "game/actions/ItemUse.h"`.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 4 — WeaponProfile constants → RuntimeOffsets manual constants
File: `internal/src/features/combat/autoaim/WeaponProfile.cpp`

Delete lines 16-20 (the four `kOff…` constants). Replace uses:
- line 30: `p + kOffCharSpeedMul` → `p + RuntimeOffsets::Char_ProjSpeedMul`
- line 31: `p + kOffCharLifetimeMul` → `p + RuntimeOffsets::Char_ProjLifetimeMul`
- line 36: `+ kOffCharRangeMul` → `+ RuntimeOffsets::Char_RangeMul`
- lines 118-119: `+ kOffProjId` → `+ RuntimeOffsets::PP_ProjId`

Keep the existing same-line `raw-access-ok` comments on every read — the
reads must stay raw (shared-SEH hot-loop sweep, plan 16); with
`RuntimeOffsets::` now on those lines, the marker is what keeps guardrail
check 2 green. `RuntimeOffsets.h` is already included (line 5).

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

### Step 5 — AimHooks shot-angle constant
File: `internal/src/features/combat/autoaim/AimHooks.cpp`

Delete lines 26-27 (`kOffShotAngle`). Replace the use at line 129:
```cpp
Mem::TryWrite<float>(shotData, RuntimeOffsets::Shot_Angle, newAngle);
```
Ensure `#include "RuntimeOffsets.h"` (or `core/runtime/RuntimeOffsets.h`)
is present. Leave the `+ 0x24` validity probe at line 115 untouched.

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
bash internal/tools/wsl-build.sh Debug            # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh            # exit 0

# Private eq-mgr resolution gone (expect ZERO hits):
grep -rn 's_eqMgrFieldOff\|AJJJBDBNBLM' internal/src/features/combat/

# Magic constants gone (expect ZERO hits):
grep -rn 'kOffCharSpeedMul\|kOffCharLifetimeMul\|kOffCharRangeMul\|kOffProjId\|kOffShotAngle' internal/src/features/

# ItemUse is the only UseInventoryItem resolver (expect hits ONLY in game/actions/):
grep -rn 'UseInventoryItem' internal/src/features/ internal/src/game/
```

## Out of scope
- Any change to WHEN AutoAbility/AutoNexus fire (thresholds, cooldowns,
  targeting logic).
- PlayerTAB's equipment reads (plan 42).
- `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.
- Adding an inventory-slot abstraction beyond the two call paths that exist.
