# 103 — `Game::` object-view adoption for entity position (completes plan 26)

## Goal

After this plan, every non-hot-loop read of an entity's world position in
`features/` and `gui/` goes through a new `Game::Entity::TryPos(float&, float&)`
accessor instead of a hand-written pair of `Mem::TryRead(ptr, RuntimeOffsets::PosX/PosY, …)`
calls. Fourteen call sites across nine files stop pairing a raw `void*` with two
raw offset keys and start talking to a typed object. `Game::Entity` gains the two
accessors it was missing (`TryPos` and a `TryHp`), and a guardrail check keeps
new `PosX`/`PosY` pairs out of feature code.

This is the surviving, highest-value slice of the abandoned plan 26
(`docs/plans/26-game-wrapper-adoption.md`, status TODO): `Game::Entity` /
`Game::Character` / `Game::Projectile` / `Game::ProjProps` have existed since
plan 10 and are used by **7 files**, while `features/` + `gui/` still contain
**152** direct `Mem::*(ptr, RuntimeOffsets::…)` reads. `PosX`/`PosY` alone
account for 47 of the `RuntimeOffsets::` references there — by far the densest
single concept.

**This is a C++ plan.** It builds the DLL and must not run concurrently with any
other C++ plan.

## Dependencies

- **Plan 101 MUST be merged first.** Both edit
  `internal/src/gui/tabs/WorldTAB.cpp` and
  `internal/src/features/movement/dodge/ProjectileTracking.cpp`.
- Plan 100 must also already be merged (101 depends on it).

Files this plan touches that other plans also touch:
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` — plans 100,
  101 (before), 104 (after).
- `internal/src/gui/tabs/WorldTAB.cpp` — plan 101 (before).
- `internal/src/features/movement/dodge/AoeTracking.cpp` — plan 100 (before).
- `internal/tools/check-raw-access.sh` — plans 100, 101, 102, 104 also append
  checks. Append yours after theirs.

## Current state

### The wrappers exist and are barely used

`internal/src/game/objects/GameObjects.h:21-46` defines `Game::Entity` with
`Ok()`, `Ptr()`, `X()`, `Y()`, `ObjType()`, `ObjId()`, `Props()`, `IsEnemy()`,
`IsInvincibleType()`, `HasHealthBar()`. All are `Mem::ReadOr` one-liners:

```cpp
    float    X()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosX, 0.f); }
    float    Y()       const { return Mem::ReadOr<float>(p_, RuntimeOffsets::PosY, 0.f); }
```

Adoption today (`grep -rln 'Game::Entity\|Game::Character\|Game::Projectile\|Game::ProjProps' internal/src/features internal/src/gui`):
`AoeTracking.cpp`, `ProjectileRuntimeReader.cpp`, `EnemyTracker.cpp`,
`AutoNexus.cpp`, `WeaponProfile.cpp`, `AutoAim.cpp`, `PlayerTAB.cpp` — 11 uses
in 7 files.

**The gap:** `X()`/`Y()` return a *value with a fallback*. Almost every real
call site needs to know whether the read **succeeded** — so it cannot use them
and writes the `Mem::TryRead` pair by hand instead. That missing accessor is why
plan 26 stalled. This plan adds it.

### The 14 migratable position sites

All of these are `Mem::TryRead` pairs where a `TryPos` is an exact,
short-circuit-equivalent substitute:

| File:line | Shape |
|---|---|
| `features/movement/dodge/DangerPlanner.cpp:67-68` | two sequential `if (!TryRead) return false;` |
| `features/movement/dodge/ProjectileTracking.cpp:145-146` | two sequential `if (!TryRead) return false;` |
| `features/movement/dodge/ProjectileTracking.cpp:324-325` | `if (TryRead && TryRead) { … }` |
| `features/movement/dodge/AoeTracking.cpp:152-153` | two sequential `if (!TryRead) return false;` |
| `features/movement/dodge/AoeTracking.cpp:186-187` | two sequential `if (!TryRead) return false;` |
| `features/projectiles/ProjectileStore.cpp:54-55` | `return TryRead && TryRead;` |
| `features/combat/enemytracker/EnemyTracker.cpp:310-311` | `if (TryRead && TryRead && isfinite… ) { … }` |
| `features/combat/killaura/KillAura.cpp:168-169` | `if (!TryRead \|\| !TryRead) { … return; }` |
| `features/combat/autoaim/AutoAim.cpp:77-78` | same shape as KillAura |
| `gui/CamState.cpp:29-30` | `if (TryRead && TryRead) return true;` |
| `gui/tabs/WorldTAB.cpp:309-310` | two bare calls, return value **ignored** |
| `gui/tabs/WorldTAB.cpp:543-544` | two bare calls, return value ignored |
| `gui/tabs/WorldTAB.cpp:561-562` | two bare calls, return value ignored |
| `gui/tabs/WorldTAB.cpp:627-628` | two bare calls, return value ignored |
| `gui/tabs/WorldTAB.cpp:2140` | `bool ok = TryRead && TryRead;` |

Representative — `DangerPlanner.cpp:62-70`:

```cpp
bool ReadLivePlayerPosition(void* player, float& outX, float& outY)
{
    outX = 0.f;
    outY = 0.f;
    if (!player) return false;
    if (!Mem::TryRead(player, RuntimeOffsets::PosX, outX)) return false;
    if (!Mem::TryRead(player, RuntimeOffsets::PosY, outY)) return false;
    return std::isfinite(outX) && std::isfinite(outY);
}
```

and `EnemyTracker.cpp:309-313`:

```cpp
        float ex = 0.f, ey = 0.f;
        if (Mem::TryRead(entity, RuntimeOffsets::PosX, ex) &&
            Mem::TryRead(entity, RuntimeOffsets::PosY, ey) &&
            std::isfinite(ex) && std::isfinite(ey) && !(ex == 0.f && ey == 0.f)) {
```

### Sites that must NOT be migrated

**Hot-loop `__try` field sweeps (already exempted, keep them exempt).** These
read many fields inside one shared SEH block on purpose; a per-field fallback
would defeat the abort semantics (plan 16). Each already carries a same-line
`raw-access-ok` marker:

- `features/combat/enemytracker/EnemyTracker.cpp:115-116`, `:186-187`
- `features/combat/autoaim/AimHooks.cpp:80-81`, `:96-97`, `:118-119`
- `gui/tabs/WorldTAB.cpp:1452-1453`

**Writes.** `gui/tabs/TestTAB.cpp:802-805` writes `PosX`/`PosY`/`KJ_Float3Pos`.
Plan 105 owns write-path changes; leave them alone.

**`gui/tabs/VisualsTAB.cpp`.** It reads `MaxHP`/`ObjType`/`HP` through private
`ReadInt32At` / `WriteInt32At` helpers (`VisualsTAB.cpp:23-43`) that gate on
`Mem::PageReadable` — a **stricter** check than `Mem::AddrOk`, which is what
`Mem::TryRead` (and therefore every `Game::` accessor) uses. Migrating VisualsTAB
would *loosen* its pointer validation. That is a real behavior change and this
plan is behavior-preserving.
**Record it, do not migrate it.** (Note also that these helpers currently slip
past `check-raw-access.sh` check 2 because the cast names a `fieldOffset`
parameter rather than `RuntimeOffsets::` directly — see "Out of scope".)

## Target design

Extend `internal/src/game/objects/GameObjects.h`, inside `class Entity`, right
after `Y()`:

```cpp
    // Success-reporting position read. X()/Y() answer "what is it, with a
    // fallback"; TryPos answers "did the read work" — which is what almost
    // every real call site needs, and why so many of them hand-wrote the
    // Mem::TryRead pair instead of using X()/Y().
    //
    // EXACTLY equivalent to:
    //     Mem::TryRead(p, RuntimeOffsets::PosX, x) && Mem::TryRead(p, RuntimeOffsets::PosY, y)
    // including the short circuit: if PosX faults, PosY is NOT read and `y` is
    // left untouched. PosX and PosY are separate table entries and are NOT
    // guaranteed adjacent, so this deliberately does NOT read a Vec2 under one
    // guard.
    //
    // Zero-cost: two inlined Mem::TryRead calls, identical codegen to the
    // hand-written pair.
    bool TryPos(float& x, float& y) const {
        return Mem::TryRead(p_, RuntimeOffsets::PosX, x)
            && Mem::TryRead(p_, RuntimeOffsets::PosY, y);
    }

    // Finite, non-origin position. The (0,0) reject is the "entity exists in
    // the dict but has not been positioned yet" filter that EnemyTracker and
    // several planners apply by hand today. Callers that genuinely want (0,0)
    // must use TryPos.
    bool TryPosFinite(float& x, float& y) const {
        return TryPos(x, y) && std::isfinite(x) && std::isfinite(y);
    }
```

`GameObjects.h` must gain `#include <cmath>` for `std::isfinite`.

Also add to `class Character`, next to `Hp()`:

```cpp
    // Success-reporting HP pair. Same rationale as Entity::TryPos.
    bool TryHp(int32_t& hp, int32_t& maxHp) const {
        return Mem::TryRead(e_.Ptr(), RuntimeOffsets::HP,    hp)
            && Mem::TryRead(e_.Ptr(), RuntimeOffsets::MaxHP, maxHp);
    }
```

### Divergence warnings

1. **`TryPosFinite` folds in a finiteness check that only 3 of 14 sites do
   today** (`DangerPlanner.cpp:69`, `EnemyTracker.cpp:312`,
   `ProjectileStore.cpp` does not). **Only use `TryPosFinite` at the sites that
   already perform that check**; everywhere else use plain `TryPos`. Adding a
   finiteness filter where there was none is a behavior change.
2. **`EnemyTracker.cpp:312` additionally rejects `(0,0)`.** `TryPosFinite` does
   **not** include that. Keep the `&& !(ex == 0.f && ey == 0.f)` clause at that
   call site verbatim.
3. **The four `WorldTAB` sites ignore the return value.** `Mem::TryRead` leaves
   `out` untouched on failure, and so does `TryPos` — so
   `(void)Game::Entity(value).TryPos(ent.x, ent.y);` is exactly equivalent,
   including the short circuit (if PosX faults, `ent.y` keeps whatever it had,
   which is the struct's initializer — same as before).
4. **`CamState.cpp:27-35` falls back to `WorldTAB::GetLocalX/Y()` and returns
   `true` regardless.** Keep that fallback exactly; only the two `TryRead` lines
   change.

### Hot path

Every accessor is an inline `Mem::TryRead`. `Game::Entity` holds one `void*`
and has no virtuals, no allocation, and no caching
(`GameObjects.h:5-13` states the contract). Constructing
`Game::Entity(ptr)` at a call site compiles to nothing. Verify with a Release
build if you want, but the Debug build passing is sufficient for this plan.

## Steps

1. **Add `TryPos`, `TryPosFinite` and `Character::TryHp`** to
   `internal/src/game/objects/GameObjects.h`, plus `#include <cmath>`.
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```
   Nothing uses them yet; expect 0 errors, 0 warnings.

2. **Migrate the four `features/movement/dodge` sites.**

   `DangerPlanner.cpp:67-69` — before:
   ```cpp
       if (!Mem::TryRead(player, RuntimeOffsets::PosX, outX)) return false;
       if (!Mem::TryRead(player, RuntimeOffsets::PosY, outY)) return false;
       return std::isfinite(outX) && std::isfinite(outY);
   ```
   after:
   ```cpp
       return Game::Entity(player).TryPosFinite(outX, outY);
   ```
   (uses `TryPosFinite` because this site already checks finiteness — see
   divergence 1.)

   `ProjectileTracking.cpp:145-146` — before:
   ```cpp
       if (!Mem::TryRead(projInst, RuntimeOffsets::PosX, outX)) return false;
       if (!Mem::TryRead(projInst, RuntimeOffsets::PosY, outY)) return false;
   ```
   after:
   ```cpp
       if (!Game::Entity(projInst).TryPos(outX, outY)) return false;
   ```

   `ProjectileTracking.cpp:324-325` and `AoeTracking.cpp:152-153`, `:186-187`
   follow the same two patterns.

   Add `#include "game/objects/GameObjects.h"` to each file that does not
   already have it.
   Verify: build + guardrail after each file.

3. **Migrate `features/projectiles/ProjectileStore.cpp:54-55`.** Before:
   ```cpp
       return Mem::TryRead(projInst, RuntimeOffsets::PosX, outX)
           && Mem::TryRead(projInst, RuntimeOffsets::PosY, outY);
   ```
   after:
   ```cpp
       return Game::Entity(projInst).TryPos(outX, outY);
   ```
   Verify: build + guardrail.

4. **Migrate `features/combat` sites.**
   - `EnemyTracker.cpp:310-312`: replace the two `TryRead` lines with
     `Game::Entity(entity).TryPosFinite(ex, ey)` and **keep**
     `&& !(ex == 0.f && ey == 0.f)`.
   - `KillAura.cpp:168-169`: `if (!Game::Entity(local).TryPos(px, py)) { … }`.
   - `AutoAim.cpp:77-78`: same shape.
   Verify: build + guardrail after each.

5. **Migrate `gui/CamState.cpp:29-30`.** Before:
   ```cpp
       if (Mem::TryRead(p, RuntimeOffsets::PosX, outX) &&
           Mem::TryRead(p, RuntimeOffsets::PosY, outY))
           return true;
   ```
   after:
   ```cpp
       if (Game::Entity(p).TryPos(outX, outY))
           return true;
   ```
   Keep the `WorldTAB::GetLocalX/Y()` fallback and the unconditional
   `return true;` exactly as they are.
   Verify: build + guardrail.

6. **Migrate the five `gui/tabs/WorldTAB.cpp` sites** (`:309-310`, `:543-544`,
   `:561-562`, `:627-628`, `:2140`). The four ignored-return sites become
   `(void)Game::Entity(<ptr>).TryPos(<x>, <y>);`. `:2140` becomes
   `const bool ok = Game::Entity(e.ptr).TryPos(lx, ly);`.
   Also migrate `:563-564` (HP/MaxHP, ignored returns) to
   `(void)Game::Character(value).TryHp(ent.hp, ent.maxHp);`.
   **Do NOT touch `:1452-1453`** (the `raw-access-ok` hot-loop sweep).
   Verify: build + guardrail.

7. **Add guardrail check 18.** In `internal/tools/check-raw-access.sh`, after
   the last existing check:

   ```bash
   # 18. Hand-written entity-position reads in features/ + gui/. PosX/PosY have
   #     a typed accessor (Game::Entity::TryPos / TryPosFinite in
   #     game/objects/GameObjects.h); pairing a raw void* with the two offset
   #     keys is what this program removed. The documented hot-loop __try sweeps
   #     keep their same-line raw-access-ok markers and are exempt.
   hits18="$(grep -rnE 'RuntimeOffsets::Pos[XY]' "${scope_feat[@]}" 2>/dev/null \
     | grep -v 'raw-access-ok' | grep -v 'TestTAB.cpp')"
   if [ -n "$hits18" ]; then
     echo "FORBIDDEN [hand-written entity position read]:"; echo "$hits18"; fail=1
   fi
   ```

   The `TestTAB.cpp` exclusion covers the teleport **writes** at `:802-805`,
   which plan 105 owns. Note that exclusion in the check's comment so the next
   person knows it is deliberate and temporary.

   Also update the script's header comment to mention check 18.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0, no output.
   Then paste `Mem::TryRead(p, RuntimeOffsets::PosX, x);` into a features/ file,
   confirm check 18 fires, remove it.

8. **Record the VisualsTAB decision.** Add a comment above
   `VisualsTAB.cpp:23` (`ReadInt32At`):
   ```cpp
   // NOT migrated to Mem::ReadOr / Game:: accessors (plan 103): these gate on
   // Mem::PageReadable, which is STRICTER than the Mem::AddrOk check every
   // Mem::/Game:: read uses. Switching would loosen validation on a panel that
   // WRITES to the local player. If this is ever unified, the decision to make
   // is whether PageReadable should become the default for write-adjacent
   // reads, not whether VisualsTAB should drop it.
   ```
   Verify: build + guardrail.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Greps that must return **zero** results when this plan is complete:

```bash
# Only raw-access-ok hot-loop sweeps and the TestTAB writes may name PosX/PosY:
grep -rnE 'RuntimeOffsets::Pos[XY]' \
  /home/jesse/realm-engine-client/internal/src/features \
  /home/jesse/realm-engine-client/internal/src/gui \
  | grep -v 'raw-access-ok' | grep -v 'TestTAB.cpp'
```

Adoption metric (should roughly double):

```bash
grep -rn 'Game::Entity\|Game::Character\|Game::Projectile\|Game::ProjProps' \
  /home/jesse/realm-engine-client/internal/src/features \
  /home/jesse/realm-engine-client/internal/src/gui | wc -l
# before: 11    after: ~26
```

**Runtime check.** Inject and confirm: the World tab entity list still shows
correct x/y and HP for every entity; auto-aim and killaura still acquire targets
(both read the local position through migrated sites); the camera "Follow Mouse"
and screen-to-world anchor still track (CamState). A `TryPos` short-circuit
mistake shows up as entities frozen at their previous coordinates, so watch the
World tab list while moving.

## Out of scope

- **Do NOT touch any `raw-access-ok`-marked line.** Those exemptions were
  granted deliberately by plan 16 and re-affirmed by check 2's escape hatch.
- **Do NOT migrate `gui/tabs/VisualsTAB.cpp`** (see divergence note above), and
  do **not** "fix" `check-raw-access.sh` check 2 to catch its
  `fieldOffset`-parameter casts in this plan — widening that check would fire on
  code this plan is not allowed to change.
- **Do NOT migrate `gui/tabs/TestTAB.cpp`.** Its position accesses are writes
  and belong to plan 105.
- **Do NOT migrate the other ~138 `Mem::*(ptr, RuntimeOffsets::…)` reads**
  (`OP_*`, `PP_*`, `Hbeak_*`, `Sq_*`, `KJ_*`, `WM_*`, `TP_*`, `Player_*`).
  Each needs its own accessor design and most have 1–3 call sites; sweeping them
  is a separate plan with a much worse payoff-to-risk ratio. `PosX`/`PosY` is
  the one concept dense enough to be worth it.
- **Do NOT add caching to any `Game::` wrapper.** `GameObjects.h:5-13` states
  the contract: wrappers own nothing and cache nothing; caching lives in
  `RuntimeOffsets::EnsureAll`, `GameState`, `LocalPlayer` and `EnemyTracker`.
  Breaking that would make the frame-local-view guarantee unsound.
- **Do NOT add inheritance.** `Character` composes an `Entity` by value
  (`GameObjects.h:77`); keep it that way.
