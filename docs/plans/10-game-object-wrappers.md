# 10 — Typed game-object wrappers (`game/objects/`)

## Goal
The OO layer the rest of the migration builds toward: flat, zero-cost wrapper
objects — `Game::Entity`, `Game::Player`, `Game::Projectile`, `Game::Tile` —
that encapsulate "how do I read field X of game concept Y" behind typed
accessors (`e.X()`, `e.Hp()`, `e.IsEnemy()`, `p.Damage()`). Feature code stops
naming `RuntimeOffsets::*` keys and `Mem::` primitives for the common concepts
and instead talks to objects. After this plan the wrappers exist and the three
heaviest repeat-consumers (EnemyTracker, AoeTracking's entity probes,
ProjectileRuntimeReader) use them; the long tail may migrate opportunistically
later. Behavior identical.

## Dependencies
MUST merge first: **01** (`Mem`), **02** (`Il2CppC`), and the consumer plans that
touch the same files: **04** (EnemyTracker), **05** (AoeTracking),
**06** (ProjectileRuntimeReader). This plan is the second, OO wave on top of
their mechanical `Mem::` wave — sequential by design so each wave is
independently verifiable. Parallel-safe against 07/08/09/11.

## Current state
After plans 04–06, entity field access looks like:
```cpp
float ex = Mem::ReadOr<float>(entity, RuntimeOffsets::PosX, 0.f);
float ey = Mem::ReadOr<float>(entity, RuntimeOffsets::PosY, 0.f);
void* props = Mem::ReadPtr(entity, RuntimeOffsets::ObjProps);
bool  isEnemy = Mem::ReadOr<bool>(props, RuntimeOffsets::OP_IsEnemy, false);
```
The (entity → field key) pairing is repeated at every consumer, and nothing
stops a consumer pairing the wrong key with the wrong pointer type (e.g. reading
`OP_IsEnemy` off the entity instead of its props — a real class of latent bug).
Count the repeated pairings:
```
grep -rn 'RuntimeOffsets::PosX\|RuntimeOffsets::PosY\|RuntimeOffsets::ObjProps\|RuntimeOffsets::OP_IsEnemy\|RuntimeOffsets::HP\b\|RuntimeOffsets::ObjType' internal/src/features/ internal/src/gui/
```

## Target design
Create `internal/src/game/objects/GameObjects.h` (header-only; add a `.cpp` only
if a non-template helper needs one). **Composition + flat wrappers — NO
inheritance hierarchies.** Each wrapper is a non-owning `void*` + typed
accessors; copyable by value; no virtuals; every accessor is a single
`Mem::ReadOr` and inlines to today's exact code.

```cpp
#pragma once
#include "core/runtime/MemRead.h"
#include "core/runtime/RuntimeOffsets.h"
namespace Game {

// Non-owning view of a KJMONHENJEN-derived world entity. Valid for the current
// frame only — do NOT store across frames (the pointer can die on world change);
// re-obtain from EnemyTracker / WalkDict each frame.
class Entity {
public:
    explicit Entity(void* p) : p_(p) {}
    bool     Ok()      const { return Mem::AddrOk(p_); }
    void*    Ptr()     const { return p_; }
    float    X()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosX, 0.f); }
    float    Y()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosY, 0.f); }
    int32_t  ObjType() const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::ObjType, 0); }
    int32_t  ObjId()   const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::ObjId, 0); }
    void*    Props()   const { return Mem::ReadPtr(p_, RuntimeOffsets::ObjProps); }
    // Props-derived (each re-reads Props(); callers in loops should hoist ObjectProps)
    bool     IsEnemy() const;        // Props() -> OP_IsEnemy, false if props null
    bool     IsInvincibleType() const; // Props() -> OP_InvincibleElem != null
    bool     HasHealthBar() const;   // Props() -> !OP_NoHealthBar
private:
    void* p_;
};

// Character view (LKHPPBEGNOM fields; ACTK-shifted offsets already baked into
// RuntimeOffsets values). Compose, don't inherit: holds an Entity by value.
class Character {
public:
    explicit Character(void* p) : e_(p) {}
    const Entity& AsEntity() const { return e_; }
    int32_t Hp()      const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::HP, 0); }
    int32_t MaxHp()   const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::MaxHP, 0); }
    int32_t Defense() const { return Mem::ReadOr<int32_t>(e_.Ptr(), RuntimeOffsets::Defense, 0); }
    bool    Velocity(float& vx, float& vy) const;  // MoVelocity; false if offset 0/unresolved
    bool    Conditions(uint64_t& out) const;       // via RuntimeOffsets::TryReadMapObjectConditions
private:
    Entity e_;
};

// Projectile instance view (HBEAKBIHANL).
class Projectile {
public:
    explicit Projectile(void* p) : p_(p) {}
    bool   Ok()        const { return Mem::AddrOk(p_); }
    float  Angle()     const { return Mem::ReadOr<float>(p_, RuntimeOffsets::Hbeak_Angle, 0.f); }
    int32_t Damage()   const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::Hbeak_InstanceDamage, 0); }
    int32_t SpawnAgeMs() const { return Mem::ReadOr<int32_t>(p_, RuntimeOffsets::Hbeak_SpawnAgeMs, 0); }
    void*  Props()     const { return Mem::ReadPtr(p_, RuntimeOffsets::Hbeak_ProjPropsPtr); }
private:
    void* p_;
};

// ProjectileProperties view (type-level XML properties).
class ProjProps { /* Speed(), Lifetime(), IsWavy(), Magnitude(), … same pattern */ };

} // namespace Game
```
Extend accessor lists to exactly the fields the three migrated consumers need —
do not speculatively wrap every RuntimeOffsets entry.

**Location:** `game/objects/` (new folder under `game/`, beside `math/` and
`symbols/` — game-specific by definition).
**Ownership/caching:** wrappers own NOTHING and cache NOTHING — they are views.
Caching/invalidation stays where it already lives: `RuntimeOffsets::EnsureAll()`
(offset resolution, per-frame self-heal), `GameState` (AppMgr/WorldMgr/local
pointers), `EnemyTracker` (snapshot). This keeps the hot path identical: an
accessor call compiles to one guarded load.
**Thread-safety:** as safe as the raw pointer it wraps; same rules as today
(render thread + SEH-guarded hook threads).
**LocalPlayer:** already an object-shaped facade (`core/runtime/LocalPlayer.h`)
— do NOT replace it; it is the cached distributor for the local player. If a
consumer needs a non-cached local-player field, `Game::Character(LocalPlayer::GetPtr())`
is the sanctioned path.

## Steps
1. Create `game/objects/GameObjects.h` with `Entity`, `Character`, `Projectile`,
   `ProjProps` (+ small `.cpp` if needed); add to `.vcxproj`. Build.
2. Migrate `features/combat/enemytracker/EnemyTracker.cpp`'s per-entity reads in
   its `WalkDict` callback onto `Game::Entity`/`Game::Character`. Before/after:
   ```cpp
   // before
   float ex = Mem::ReadOr<float>(entity, RuntimeOffsets::PosX, 0.f);
   // after
   Game::Entity e(entity); if (!e.Ok()) return; float ex = e.X();
   ```
   Build.
3. Migrate `features/movement/dodge/AoeTracking.cpp`'s entity probes
   (`FindOwnerIsEnemyAtPos` / `FindEntityIsEnemyById` callbacks: PosX/PosY/
   ObjProps/OP_IsEnemy) onto `Game::Entity`. Build.
4. Migrate `features/projectiles/ProjectileRuntimeReader.cpp` onto
   `Game::Projectile` / `Game::ProjProps`. Build.
5. Full build both configs.

Each: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- In the three migrated files, direct offset-keyed reads are gone:
  `grep -n 'Mem::ReadOr<[^>]*>([^,]*, RuntimeOffsets::' internal/src/features/combat/enemytracker/EnemyTracker.cpp internal/src/features/movement/dodge/AoeTracking.cpp internal/src/features/projectiles/ProjectileRuntimeReader.cpp`
  → empty (reads route through `Game::` accessors).
- Runtime smoke: enemy snapshot, AoE ownership classification, and projectile
  parameter reads unchanged.

## Out of scope
- Do NOT migrate every consumer — only the three named files; the rest follow
  the same pattern in future work.
- Do NOT add caching inside wrappers, virtual methods, or inheritance.
- Do NOT wrap WorldManager walking (that is `Il2CppC::WalkDict` + `GameState`).
- Do NOT replace `LocalPlayer` or `EnemyTracker` snapshots.
