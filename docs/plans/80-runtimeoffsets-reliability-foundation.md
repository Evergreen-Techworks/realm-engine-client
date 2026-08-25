# 80 — RuntimeOffsets Reliability Foundation

## Goal
After this plan, `core/runtime/RuntimeOffsets.{h,cpp}` (1) carries the **correct**
fallback for `collisionRadiusMultiplier` (`0x798` boxed — confirmed against the
current published build dump, not the wrong `0x780` = `questBarYOffset`), (2) has a
**table row for the projectile speed multiplier**
`HBEAKBIHANL::KDAJOMOFMJB` so it self-heals and appears in OFFSET HEALTH like every
other offset, and (3) exposes a small **write-trust API**
(`GetOffsetStateFor` / `IsFieldWriteTrusted`) that lets a consumer refuse a float
WRITE when the offset was not resolved from live metadata. This is the foundation both
plan 81 (collider) and plan 82 (projectile) build on. Nothing behaves differently in
the field yet — the fallback change is inert on the happy path and the new API is
unused until 81/82.

## Dependencies
None — parallel-safe foundation.
This plan is the **sole** editor of `RuntimeOffsets.{h,cpp}` in the 79–83 series;
plans 81 and 82 only READ the symbols it adds. Land this first.

## Current state

### 1. Wrong collision-multiplier fallback
`core/runtime/RuntimeOffsets.cpp:142`:
```cpp
uint32_t OP_CollRadiusMult= 0x780;   // "collisionRadiusMultiplier"
```
`core/runtime/RuntimeOffsets.h:326`:
```cpp
extern uint32_t OP_CollRadiusMult; // "collisionRadiusMultiplier"  fallback 0x780
```
Table row `core/runtime/RuntimeOffsets.cpp:406`:
```cpp
{ "ObjectProperties", { "collisionRadiusMultiplier" },           1, 0,     &OP_CollRadiusMult, false },
```
Field order (both builds) is `questBarXOffset` (float), `questBarYOffset` (float),
`hasAnimationFrame` (bool + pad), `collisionRadiusMultiplier` (float), `hasActivators`
(bool). The boxed offset of `collisionRadiusMultiplier` depends on the build:

- Our stale Aug-17 generated header (`il2cpp-types.h:13530-13539`) placed
  `questBarYOffset` at `0x780`, giving `collisionRadiusMultiplier` = `0x788`.
- **The current published build** (`builds.him.is/latest`, `dump.cs`) places the whole
  group `0x10` higher: `questBarXOffset` `0x78C`, `questBarYOffset` `0x790`,
  `hasAnimationFrame` `0x794`, **`collisionRadiusMultiplier` = `0x798`**, `hasActivators`
  `0x79C`. The diag bridge confirms the game has patched since our headers
  (`bootgate: UpdateDetected`), so `0x798` is the value that matches the running build.

Use **`0x798`**. The current fallback `0x780` is `questBarYOffset` (in the OLD build) —
writing the collider's `0` there would silently corrupt a UI float and log a
perfect-looking before/after. Live metadata resolves the true offset regardless of this
constant; the fallback only bites on a give-up/rename, and `0x798` is the correct
last-known-good for the current build.

### 2. Speed multiplier resolved outside the registry (added here, consumed in 82)
`features/movement/dodge/ProjectileTracking.cpp:104-115` resolves
`HBEAKBIHANL::KDAJOMOFMJB` with a private `il2cpp_class_get_field_from_name` +
`il2cpp_field_get_offset` into its own atomic — it is NOT a table row today. This plan
only ADDS the table row (`Hbeak_SpeedMul`); plan 82 migrates the consumer and deletes
the private resolver. There is precedent for the `0 = unresolved` fallback in the
table: `Hbeak_NoclipGuard` (`RuntimeOffsets.cpp` / `.h`, fallback `0`).

### 3. No write-trust query
`OffsetState` (`RuntimeOffsets.h:44`) and the per-entry `s_entryState[]`
(`RuntimeOffsets.cpp:553`) already exist. `MarkSuspect` (`RuntimeOffsets.cpp:587`)
already does the reverse lookup "given a `const uint32_t*` offset var, find its table
row." There is no public "is this offset trustworthy for a write?" query yet.

## Target design

### Header additions (`core/runtime/RuntimeOffsets.h`)
Next to the other `HBEAKBIHANL` externs (near `Hbeak_ProjRadius`, `RuntimeOffsets.h:363`):
```cpp
// HBEAKBIHANL — KDAJOMOFMJB (Flash speedMul_ per-shot projectile speed multiplier).
// Resolved via IL2CPP; fallback 0 = unresolved (consumer treats as speed-mul 1.0,
// exactly like the old private resolver and like Hbeak_NoclipGuard).
extern uint32_t Hbeak_SpeedMul;   // KDAJOMOFMJB  fallback 0
```
Near the offset-health API (after `MarkSuspect`, `RuntimeOffsets.h:64`):
```cpp
// Health state for a specific offset variable (reverse lookup by address).
// Returns OffsetState::Pending if the variable is not a table entry.
OffsetState GetOffsetStateFor(const uint32_t* offsetVar);

// Fail-closed gate for FLOAT WRITES that fail OPEN (a wrong float offset writes
// successfully onto another valid, writable float — silent corruption). Returns
// true ONLY when the offset was resolved from live IL2CPP metadata this session
// (ResolvedMatch or ResolvedShifted). Fallback / Suspect / Pending -> false ->
// the caller MUST refuse the write. Reads may still use the fallback; this gate
// is specifically for writes.
bool IsFieldWriteTrusted(const uint32_t* offsetVar);
```

### Source additions (`core/runtime/RuntimeOffsets.cpp`)
- Storage init near the other `Hbeak_*` vars (`RuntimeOffsets.cpp:176` region):
  ```cpp
  uint32_t Hbeak_SpeedMul           = 0;      // KDAJOMOFMJB — 0 = unresolved (speed-mul 1.0)
  ```
- Table row grouped with the other `HBEAKBIHANL` rows (`RuntimeOffsets.cpp:448-457`):
  ```cpp
  { "HBEAKBIHANL", { "KDAJOMOFMJB" },                                           1, 0, &Hbeak_SpeedMul,        false },
  ```
- The two new functions, next to `MarkSuspect` (`RuntimeOffsets.cpp:587`):
  ```cpp
  OffsetState GetOffsetStateFor(const uint32_t* offsetVar)
  {
      for (int i = 0; i < kEntryCount; ++i)
          if (s_entries[i].outPtr == offsetVar) return s_entryState[i];
      return OffsetState::Pending;
  }

  bool IsFieldWriteTrusted(const uint32_t* offsetVar)
  {
      const OffsetState st = GetOffsetStateFor(offsetVar);
      return st == OffsetState::ResolvedMatch || st == OffsetState::ResolvedShifted;
  }
  ```

### Divergence note (which value is correct, and why)
The correct fallback is **`0x798`**, from the current published build's `dump.cs`
(`builds.him.is/latest`): `collisionRadiusMultiplier // 0x798`, with `questBarYOffset`
at `0x790` and `hasActivators` at `0x79C` bracketing it. Our older Aug-17 header showed
`0x788`; the game has since patched (whole group shifted `0x10`, `bootgate:
UpdateDetected`), so `0x788` is now stale and `0x780` (the shipped value) is
`questBarYOffset` from a build older still. After this fix, on the running build the
OFFSET HEALTH row for `ObjectProperties::collisionRadiusMultiplier` should read
`ResolvedMatch` (fallback == live). If in-game it instead reads `ResolvedShifted`, the
running build differs from the dump — record the live-resolved value from OFFSET HEALTH
as the fallback and note it. Never use `0x780` or `0x788`.

## Steps

1. **Fix the collision-multiplier fallback.**
   In `core/runtime/RuntimeOffsets.cpp:142` change `= 0x780;` to `= 0x798;` and update
   the trailing comment to `// "collisionRadiusMultiplier" (boxed; current build per builds.him.is dump; 0x780 was questBarYOffset)`.
   In `core/runtime/RuntimeOffsets.h:326` update the comment `fallback 0x780` →
   `fallback 0x798`.
   Build:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ```
   Expect 0 errors. No behavior change on the happy path (live metadata resolves the
   true offset); this corrects the give-up fallback to the current build.

2. **Add the `Hbeak_SpeedMul` storage + extern + table row.**
   - Add the extern in `core/runtime/RuntimeOffsets.h` next to `Hbeak_ProjRadius`
     (~line 363), text as in Target design.
   - Add the storage line in `core/runtime/RuntimeOffsets.cpp` next to the other
     `Hbeak_*` vars (~line 176).
   - Add the table row in the `HBEAKBIHANL` group (~line 448-457).
   Build:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ```
   Expect 0 errors. Nothing reads `Hbeak_SpeedMul` yet (plan 82 does), so no behavior
   change.

3. **Add the write-trust API.**
   - Declare `GetOffsetStateFor` and `IsFieldWriteTrusted` in
     `core/runtime/RuntimeOffsets.h` after `MarkSuspect` (~line 64).
   - Define both in `core/runtime/RuntimeOffsets.cpp` next to `MarkSuspect`
     (~line 587), bodies as in Target design.
   Build + guardrail:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   bash internal/tools/check-raw-access.sh
   ```
   Expect 0 errors and guardrail exit 0. The API is unused, so no behavior change.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0
```
Grep checks:
```bash
# The wrong fallback constant is gone from the RuntimeOffsets storage/extern:
command grep -n '0x780' internal/src/core/runtime/RuntimeOffsets.cpp   # no OP_CollRadiusMult line; 0x798 now
# The new symbols exist exactly once as table plumbing:
command grep -rn 'Hbeak_SpeedMul\|IsFieldWriteTrusted\|GetOffsetStateFor' internal/src/core/runtime/
```
In-game (optional, on the user's Release deploy): Test → OFFSET HEALTH shows
`ObjectProperties::collisionRadiusMultiplier` as `ResolvedMatch` (green) and a new
`HBEAKBIHANL::KDAJOMOFMJB` row that resolves once a projectile-bearing realm loads.

## Out of scope
- Do NOT edit `PlayerCollider`, `ProjectileTracking`, `ProjectileRuntimeReader`, or
  any consumer — this plan is registry-only. Consumers migrate in 81 and 82.
- Do NOT touch any other fallback value or table row; only the three additions above.
- Do NOT add a `CheckFieldExtent`/uniqueness engine — the state-based trust gate is
  the adopted discipline (YAGNI; plan 81 may add a light extent check locally if it
  chooses, but it is not required here).
