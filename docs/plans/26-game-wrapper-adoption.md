# 26 — Game:: Wrapper Adoption Sweep

## Goal
Increase adoption of the `Game::Entity`, `Game::Character`, `Game::Projectile`,
and `Game::ProjProps` typed wrappers from 7 call sites to all feature/GUI
code that reads game-object fields via `Mem::ReadOr(ptr, RuntimeOffsets::*)`.
After this plan, feature code talks to typed objects (`Game::Character(ptr).Hp()`)
instead of pairing a raw `void*` with a `RuntimeOffsets::` key. The wrappers
already exist (`game/objects/GameObjects.h`) and are zero-cost (inline, no
virtual dispatch, no caching).

## Dependencies
- **Plan 25 must be merged first** if PlayerTAB reads are being migrated
  here. Otherwise, parallel-safe for files that do not overlap with plan 25.
- Plan 24 (CameraTAB) is independent -- CameraTAB reads CameraManager fields,
  not game entities.

Files touched:
- `internal/src/game/objects/GameObjects.h` (extend with new accessors)
- `internal/src/features/combat/autoaim/AutoAim.cpp`
- `internal/src/features/combat/autoaim/WeaponProfile.cpp`
- `internal/src/features/combat/autoaim/AimHooks.cpp`
- `internal/src/features/combat/autonexus/AutoNexus.cpp`
- `internal/src/features/movement/dodge/DangerPlanner.cpp`
- `internal/src/features/movement/dodge/MovementRuntime.cpp`
- `internal/src/features/movement/dodge/AoeTracking.cpp`
- `internal/src/features/movement/collider/PlayerCollider.cpp`
- `internal/src/features/combat/autoability/AutoAbility.cpp`
- `internal/src/features/visuals/FloatingTextService.cpp`
- `internal/src/gui/tabs/PlayerTAB.cpp` (if not already covered by plan 25)

## Current state

### Game:: wrappers exist but are barely used
`game/objects/GameObjects.h` defines four wrapper classes:
- `Game::Entity` -- PosX, PosY, ObjType, ObjId, Props, IsEnemy,
  IsInvincibleType, HasHealthBar
- `Game::Character` -- Hp, MaxHp, Defense, Velocity, Conditions
- `Game::Projectile` -- Angle, Damage, SpawnAgeMs, Props
- `Game::ProjProps` -- Lifetime, Speed, IsWavy, Magnitude

Current adoption (7 sites total):
- `EnemyTracker.cpp` -- 1 use (`Game::Character` for velocity)
- `AoeTracking.cpp` -- 4 uses (`Game::Character`, `Game::Entity`)
- `ProjectileRuntimeReader.cpp` -- 2 uses (`Game::Projectile`, `Game::ProjProps`)

### Representative raw-access pattern being replaced
Most feature code reads game fields like this:

```cpp
// AutoAim.cpp (representative pattern)
float ex = Mem::ReadOr<float>(entity, RuntimeOffsets::PosX, 0.f);
float ey = Mem::ReadOr<float>(entity, RuntimeOffsets::PosY, 0.f);
int32_t hp = Mem::ReadOr<int32_t>(entity, RuntimeOffsets::HP, 0);
```

After migration:
```cpp
Game::Character ch(entity);
float ex = ch.AsEntity().X();
float ey = ch.AsEntity().Y();
int32_t hp = ch.Hp();
```

### Accessors needed but not yet on the wrappers
Some feature code reads fields that Game:: wrappers don't yet expose. These
need to be added to `GameObjects.h`:

1. **Entity::Conditions** -- `RuntimeOffsets::MoConditions` (single-word
   condition read, different from Character::Conditions which reads the
   full 2-word mask via `TryReadMapObjectConditions`)
2. **Character::CurMP** -- `RuntimeOffsets::CurMP` (float)
3. **Character::MaxMP** -- `RuntimeOffsets::MaxMP` (int32)
4. **Entity::Name** -- `RuntimeOffsets::PlayerName` (after plan 25 adds it)
   -- returns `void*` (Il2CppString*), not a C++ string

Check what each consumer file actually reads and add only what is needed.
Do NOT add accessors speculatively.

## Target design

### Extended Game:: wrappers
Add to `GameObjects.h` only the accessors that at least one feature file
needs. Each accessor follows the existing pattern: one `Mem::ReadOr` or
`Mem::ReadPtr` call, inline, zero-cost.

```cpp
// Example additions to Game::Character:
float   CurMpF()  const { return Mem::ReadOr<float>(e_.Ptr(), RuntimeOffsets::CurMP, 0.f); }
int32_t MaxMp()   const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::MaxMP, 0); }
```

### Migration rules
1. Replace `Mem::ReadOr<T>(ptr, RuntimeOffsets::Field, default)` with
   `Game::Entity(ptr).Field()` or `Game::Character(ptr).Field()` as
   appropriate.
2. When a feature reads multiple fields from the same pointer in a block,
   construct one wrapper at the top of the block:
   ```cpp
   Game::Character ch(entity);
   // use ch.Hp(), ch.AsEntity().X(), etc.
   ```
3. Do NOT wrap pointers that are not game entities (e.g., CameraManager,
   Unity Transform, EquipmentManager). Those are not `KJMONHENJEN` objects.
4. Hot-loop reads marked `raw-access-ok` must STAY raw -- do not migrate
   them. They are inside `__try` blocks where per-field SEH recovery would
   change behavior.
5. `reinterpret_cast` sites that are IL2CPP interop (unboxing, class casts)
   or PE parsing are not candidates for Game:: wrapping.

## Steps

### Step 1 -- Extend GameObjects.h with needed accessors
File: `internal/src/game/objects/GameObjects.h`

Audit each target file (listed above) to find which RuntimeOffsets fields
they read. Add only those accessors that are missing. Likely additions:
- `Character::CurMpF()`, `Character::MaxMp()`
- `Entity::ConditionWord()` (single uint32 from RuntimeOffsets::MoConditions)

Do NOT add accessors for fields that live on non-entity objects (equipment,
camera, tile).

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 2 -- Migrate AutoAim.cpp
File: `internal/src/features/combat/autoaim/AutoAim.cpp`

Replace `Mem::ReadOr(ptr, RuntimeOffsets::PosX/PosY/HP/MaxHP/ObjType/...)`
calls with `Game::Entity` or `Game::Character` accessors. The file already
includes `RuntimeOffsets.h` and `MemRead.h`. Add `#include "game/objects/GameObjects.h"`.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 3 -- Migrate AutoNexus.cpp
File: `internal/src/features/combat/autonexus/AutoNexus.cpp`

Same pattern as step 2. AutoNexus reads HP, MaxHP, Defense, Position, and
conditions from the local player pointer.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 4 -- Migrate DangerPlanner.cpp and MovementRuntime.cpp
Files: `internal/src/features/movement/dodge/DangerPlanner.cpp`,
       `internal/src/features/movement/dodge/MovementRuntime.cpp`

These read entity positions and conditions for dodge planning.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 5 -- Migrate remaining files
Files: `AutoAbility.cpp`, `WeaponProfile.cpp`, `AimHooks.cpp`,
       `PlayerCollider.cpp`, `FloatingTextService.cpp`

Same mechanical pattern. Each file gets `#include "game/objects/GameObjects.h"`
and replaces `Mem::ReadOr(ptr, RuntimeOffsets::Field, default)` with the
typed wrapper accessor.

Skip any reads marked `raw-access-ok`.

**Verify:** `bash internal/tools/wsl-build.sh Debug`

### Step 6 -- Final verification
Run full build and guardrails:

**Verify:** `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh`

## Verification
```bash
# Must compile clean
bash internal/tools/wsl-build.sh Debug

# Guardrails still pass
bash internal/tools/check-raw-access.sh

# Game:: adoption should be substantially higher:
grep -rc 'Game::' internal/src/features/ internal/src/gui/ | grep -v ':0$' | sort -t: -k2 -nr
# Expected: 15+ files with Game:: usage (up from 3)

# Count remaining Mem::ReadOr + RuntimeOffsets pairs in features/ that
# could be Game:: calls (excluding raw-access-ok):
grep -rn 'Mem::ReadOr.*RuntimeOffsets' internal/src/features/ | grep -v 'raw-access-ok' | wc -l
# Expected: significantly lower than before (target: < 10)
```

## Out of scope
- Migrating `EnemyTracker.cpp`'s hot-loop reads (marked `raw-access-ok`)
  -- those are inside `__try` blocks and must stay raw.
- Migrating `ProjectileRuntimeReader.cpp`'s hot-loop reads (41 `raw-access-ok`
  markers) -- same reason.
- Migrating WorldTAB.cpp's hot-loop reads (6 `raw-access-ok` markers).
- Adding Game:: wrappers for non-entity objects (CameraManager, EquipmentManager,
  ItemSlot, Square/Tile).
- Creating a `Game::Player` subclass of `Game::Character` for player-specific
  fields -- that can come later if needed.
