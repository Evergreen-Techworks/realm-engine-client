# 102 — One home for the movement tile-sensor primitives (`Movement::TileSensor`)

## Goal

After this plan, the tile-probing primitives shared by all four dodge sensor
modules live in one place: `internal/src/features/movement/sensors/TileSensor.{h,cpp}`.
The open-addressed hazard memo (`kMemoSlots` / `MemoClear` / `MemoFind` /
`MemoInsert`, ~35 lines, currently **byte-identical** in two files), the tile-key
packing (4 copies), the finiteness helpers (4 copies), `DistSq` (4 copies), and
the `IsHazardAt` / `CanOccupy` / `IsWallAt` probes (2–3 copies) collapse onto one
implementation. Each module keeps **its own memo instance**, so clear timing and
threading are unchanged.

This removes ~120 duplicated lines and, more importantly, gives the "is this tile
walkable / damaging" question one place to change when `WorldTAB::IsTileDamagingLive`
or `TestTAB::IsWalkPositionBlocked` change shape.

**This is a C++ plan.** It builds the DLL and must not run concurrently with any
other C++ plan.

**Scope guard:** this plan touches only the four `*Sensors.cpp` files' *shared
infrastructure*. It does **not** touch any solver, planner, pathfinder, scoring
function, or any Phase-3 constant.

## Dependencies

None — content-independent of every other plan. Slot it anywhere in the C++
queue.

Files this plan touches that other plans also touch: none. `UDodgeSensors.cpp`,
`PJDodgeSensors.cpp`, `ReppSensors.cpp` and `ZDodgeSensors.cpp` are exclusive to
this plan.

## Current state

### The hazard memo: two byte-identical copies + one different one

`internal/src/features/movement/udodge/UDodgeSensors.cpp:41-81` and
`internal/src/features/movement/pjdodge/PJDodgeSensors.cpp:24-64` are the same
code, comment differences aside:

```cpp
// UDodgeSensors.cpp:45-81  (PJDodgeSensors.cpp:28-64 is identical)
constexpr uint32_t kMemoSlots    = 512;      // power of 2
constexpr uint32_t kMemoMask     = kMemoSlots - 1;
constexpr uint32_t kMemoEmpty    = 0xFFFFFFFFu;

struct MemoEntry { uint32_t key; uint8_t value; };
MemoEntry s_hazardMemo[kMemoSlots];

void MemoClear()
{
    for (uint32_t i = 0; i < kMemoSlots; ++i)
        s_hazardMemo[i].key = kMemoEmpty;
}

bool MemoFind(uint32_t key, uint8_t& outValue)
{
    uint32_t idx = key & kMemoMask;
    for (uint32_t probe = 0; probe < kMemoSlots; ++probe) {
        const MemoEntry& e = s_hazardMemo[idx];
        if (e.key == key) { outValue = e.value; return true; }
        if (e.key == kMemoEmpty) return false;
        idx = (idx + 1) & kMemoMask;
    }
    return false;
}

void MemoInsert(uint32_t key, uint8_t value) { /* linear probe insert */ }
```

`ReppSensors.cpp:27` uses a **`std::unordered_map<uint32_t, uint8_t>`** instead —
functionally the same memo with a different container (allocating; the UDodge
comment at `:42-44` specifically calls out "no per-frame heap allocation" as the
reason for the open-addressed table).

Clear sites:
- `UDodgeSensors.cpp:439` (in `BuildMap`) and `:547` (in `ReanchorMap`)
- `PJDodgeSensors.cpp:208` (in `Build`)
- `ReppSensors.cpp:195` (`s_hazardMemo.clear()`, in `Build`)

### `TileKey` — four copies, all identical

`UDodgeSensors.cpp:83-87`, `PJDodgeSensors.cpp:66-70`, `ReppSensors.cpp:28-32`:

```cpp
uint32_t TileKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}
```

(A fourth, structurally identical packing lives in the now-dead
`IpcTileState.cpp:41-42`, which plan 99 deletes.)

### `IsFinite` / `IsFinitePoint` — four copies

`UDodgeSensors.cpp:89-90`, `PJDodgeSensors.cpp:72-73`, `ReppSensors.cpp:34-35`,
`ZDodgeSensors.cpp:24-32`. All `std::isfinite`-based, all identical in effect.

### `DistSq` — four copies

`UDodgeSensors.cpp:92`, `PJDodgeSensors.cpp:75`, `ReppSensors.cpp:56`,
`ZDodgeSensors.cpp:53`. All `dx*dx + dy*dy`.

### `IsHazardAt` — three copies, two identical

`UDodgeSensors.cpp:638-649` and `PJDodgeSensors.cpp:311-322` are identical:

```cpp
bool IsHazardAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return false;
    const int tx = static_cast<int>(std::floor(worldX));
    const int ty = static_cast<int>(std::floor(worldY));
    const uint32_t key = TileKey(tx, ty);
    uint8_t cached = 0;
    if (MemoFind(key, cached)) return cached != 0;
    const bool hz = WorldTAB::IsTileDamagingLive(tx, ty);
    MemoInsert(key, hz ? 1 : 0);
    return hz;
}
```

`ReppSensors.cpp:294-307` is the same logic against the `unordered_map` memo.

### `CanOccupy` — two identical copies

`UDodgeSensors.cpp:651-657` and `PJDodgeSensors.cpp:324-330`:

```cpp
bool CanOccupy(float worldX, float worldY, bool safeWalk)
{
    if (!IsFinitePoint(worldX, worldY)) return false;   // unknown → treat as blocked
    if (TestTAB::IsWalkPositionBlocked(worldX, worldY)) return false;
    if (safeWalk && IsHazardAt(worldX, worldY)) return false;
    return true;
}
```

### `IsWallAt` — one copy, but it is `CanOccupy`'s first half

`ReppSensors.cpp:288-292`:

```cpp
bool IsWallAt(float worldX, float worldY)
{
    if (!IsFinitePoint(worldX, worldY)) return true;  // unknown → treat as blocked
    return TestTAB::IsWalkPositionBlocked(worldX, worldY);
}
```

Note the **polarity difference**: `IsWallAt` returns `true` (blocked) on a
non-finite point; `CanOccupy` returns `false` (cannot occupy). Same intent,
opposite sense — both are correct as written. `ZDodgeSensors.cpp:204` calls
`TestTAB::IsWalkPositionBlocked` directly with no finiteness guard at all.

### `SafeRadius` / `SafeReactWindowMs` / `ProjectileRadius` — NOT shareable as-is

`ReppSensors.cpp:37-54` and `ZDodgeSensors.cpp:34-51` are verbatim copies of
each other, **except** `SafeReactWindowMs` references
`Settings{}.reactWindowMs` — where `Settings` is the *module's own* type
(`Repp::Settings` from `ReppTypes.h` vs `ZDodge::Settings` from `ZDodgeTypes.h`)
with a different default. That is a real reason these copies differ, and the
clamp bounds happen to match today by coincidence, not by contract.
**Verdict: leave `SafeRadius`, `SafeReactWindowMs` and `ProjectileRadius` where
they are.** See "Out of scope".

## Target design

New files `internal/src/features/movement/sensors/TileSensor.h` / `.cpp`.

```cpp
// TileSensor.h
#pragma once
#include <cstdint>

// Movement::TileSensor — the tile-probing primitives every dodge mode needs.
//
// Before this header, UDodgeSensors / PJDodgeSensors / ReppSensors /
// ZDodgeSensors each carried their own copy of the tile-key packing, the
// finiteness guards, the per-tick hazard memo, and the hazard/wall probes. Two
// of those copies were byte-identical; one used std::unordered_map instead of
// the open-addressed table; one had no finiteness guard at all. This is the one
// home.
//
// OWNERSHIP: the memo is NOT a global. Each module owns a HazardMemo instance
// and clears it at exactly the point it cleared its old static — so clear
// timing, and therefore behavior, is unchanged.
//
// THREADING: HazardMemo is not synchronized. It is game-update-thread-only,
// exactly like the statics it replaces. UDodge's worker thread does NOT call
// these (UDodgePathfinder.cpp:127 documents that the game thread pre-fills the
// grid) — keep it that way.
//
// HOT PATH: every function here is called hundreds of times per frame by the
// planners. Everything except the two probe functions is header-inline; the
// probes are out-of-line because they call into WorldTAB / TestTAB.
namespace Movement { namespace TileSensor {

// Pack a signed tile coordinate pair into one 32-bit memo key. Wraps via
// uint16_t exactly as every prior copy did — negative coordinates alias into
// the high half, which is fine for a per-tick memo.
inline uint32_t TileKey(int tx, int ty)
{
    return (static_cast<uint32_t>(static_cast<uint16_t>(tx)) << 16) |
            static_cast<uint32_t>(static_cast<uint16_t>(ty));
}

inline bool IsFinite(float v);              // std::isfinite(v)
inline bool IsFinitePoint(float x, float y);
inline float DistSq(float ax, float ay, float bx, float by);

// Fixed-size open-addressed hazard memo. 512 slots, power of two, linear probe.
// No heap allocation, ever — that is why this is not a std::unordered_map.
class HazardMemo {
public:
    HazardMemo() { Clear(); }
    void Clear();
    bool Find(uint32_t key, uint8_t& outValue) const;
    void Insert(uint32_t key, uint8_t value);
private:
    static constexpr uint32_t kSlots = 512;
    static constexpr uint32_t kMask  = kSlots - 1;
    static constexpr uint32_t kEmpty = 0xFFFFFFFFu;
    struct Entry { uint32_t key; uint8_t value; };
    Entry e_[kSlots];
};

// Damaging-ground probe, memoized per tile in `memo`. Non-finite -> false
// (matches every prior copy: an unknown point is NOT reported as a hazard).
bool IsHazardAt(HazardMemo& memo, float worldX, float worldY);

// Wall probe. Non-finite -> true (blocked). This is ReppSensors::IsWallAt's
// polarity; CanOccupy below inverts it.
bool IsWallAt(float worldX, float worldY);

// Occupancy: not a wall, and (when safeWalk) not damaging ground.
// Non-finite -> false (cannot occupy).
bool CanOccupy(HazardMemo& memo, float worldX, float worldY, bool safeWalk);

} } // namespace Movement::TileSensor
```

`.cpp` bodies are the existing implementations verbatim, with
`WorldTAB::IsTileDamagingLive` and `TestTAB::IsWalkPositionBlocked` as the
backing calls.

### Divergence resolutions — which behavior is correct

1. **Open-addressed table vs `std::unordered_map` (Repp).** The open-addressed
   table is correct: it is what the newer modules chose specifically to avoid
   per-frame allocation (`UDodgeSensors.cpp:42-44`), and the probe count is
   bounded at 512. Migrating Repp onto it changes only allocation behavior, not
   results — a key either hits or misses identically. **However**: the
   `unordered_map` has unbounded capacity while the table saturates at 512
   distinct tiles per tick. If a Repp tick probes >512 distinct tiles, the table
   silently stops inserting (`MemoInsert` gives up after a full loop) and those
   tiles fall through to a live `IsTileDamagingLive` call each time — **correct
   results, more calls**. Repp's planner samples a bounded candidate set
   (`ReppPlanner.cpp:165`, `:337`) so this is not expected to trigger, but note
   it in the PR.
2. **`ZDodgeSensors.cpp:204` has no finiteness guard.** Routing it through
   `TileSensor::IsWallAt` **adds** one, turning a possible NaN-coordinate probe
   into a "blocked" answer instead of whatever `IsWalkPositionBlocked` does with
   NaN. This is a behavior change, however small. **Do NOT migrate that call
   site in this plan** — leave `ZDodgeSensors.cpp:204` exactly as it is and note
   it. ZDodge only adopts the inline helpers (`IsFinite`, `IsFinitePoint`,
   `DistSq`).
3. **`IsHazardAt` non-finite returns `false`, `IsWallAt` non-finite returns
   `true`.** Both are correct and intentional — one asks "is this dangerous"
   (unknown ⇒ not known-dangerous), the other asks "is this blocked"
   (unknown ⇒ treat as blocked). Preserve both polarities exactly.

### Hot path

`TileKey`, `IsFinite`, `IsFinitePoint`, `DistSq` and the whole `HazardMemo` are
header-inline so the migration costs nothing. `IsHazardAt` / `IsWallAt` /
`CanOccupy` stay out-of-line exactly as they are today (they already cross a
translation unit into `WorldTAB`/`TestTAB`). Do **not** add a virtual, a
`std::function`, or a registry lookup anywhere in this file.

## Steps

1. **Create `internal/src/features/movement/sensors/TileSensor.h` and `.cpp`**
   as specified, copying each body verbatim from `UDodgeSensors.cpp` (the
   canonical copy). Add both to `internal/il2cpp-dll-injection.vcxproj` and
   `.vcxproj.filters`.
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```
   Nothing uses it yet; expect 0 errors, 0 warnings.

2. **Migrate `PJDodgeSensors.cpp`** (start here: it is the smallest and its copy
   is byte-identical to the source).
   - Delete `:24-79` (`kMemoSlots`…`DistSq`), keeping any constants in that
     range that are NOT memo/tile helpers (`kEnemyRadius`, `kAoeCullPad`,
     `kPathPadMs` at `:20-22` are above the block — leave them).
   - Add `#include "features/movement/sensors/TileSensor.h"` and, in the
     anonymous namespace, `Movement::TileSensor::HazardMemo s_hazardMemo;`.
   - Add `using Movement::TileSensor::TileKey;` etc., or qualify at use sites —
     whichever produces the smaller diff.
   - `MemoClear()` at `:208` becomes `s_hazardMemo.Clear();`.
   - `IsHazardAt` (`:311-322`) becomes
     `return Movement::TileSensor::IsHazardAt(s_hazardMemo, worldX, worldY);`.
   - `CanOccupy` (`:324-330`) becomes
     `return Movement::TileSensor::CanOccupy(s_hazardMemo, worldX, worldY, safeWalk);`.
   - Leave `PJDodgeSensors.h` unchanged — the module's public API is identical.
   Verify: build + guardrail. Then confirm the diff removed ~55 lines and added
   ~5.

3. **Migrate `UDodgeSensors.cpp`** the same way. Delete `:41-93`, add the memo
   instance, and replace the two `MemoClear()` calls at `:439` and `:547` with
   `s_hazardMemo.Clear();`. Replace the `IsHazardAt` / `CanOccupy` bodies
   (`:638-657`) with forwards.
   **Keep both clear sites.** `:547`'s comment says "per-frame hazard memo reset
   (same contract as Build)" — that contract is what makes the memo per-tick and
   it must not change.
   Verify: build + guardrail.

4. **Migrate `ReppSensors.cpp`.** Delete `TileKey` (`:28-32`), `IsFinite` /
   `IsFinitePoint` (`:34-35`), `DistSq` (`:56`) and the
   `std::unordered_map<uint32_t, uint8_t> s_hazardMemo;` (`:27`), replacing the
   last with `Movement::TileSensor::HazardMemo s_hazardMemo;`.
   - `s_hazardMemo.clear()` at `:195` becomes `s_hazardMemo.Clear();`.
   - `IsWallAt` (`:288-292`) becomes
     `return Movement::TileSensor::IsWallAt(worldX, worldY);`.
   - `IsHazardAt` (`:294-307`) becomes
     `return Movement::TileSensor::IsHazardAt(s_hazardMemo, worldX, worldY);`.
   - **Keep** `SafeRadius` (`:37-41`), `SafeReactWindowMs` (`:43-47`) and
     `ProjectileRadius` (`:49-54`) exactly where they are.
   - Drop the now-unused `#include <unordered_map>` if nothing else needs it.
   Verify: build + guardrail.

5. **Migrate `ZDodgeSensors.cpp`, inline helpers only.** Delete `IsFinite`
   (`:24-27`), `IsFinitePoint` (`:29-32`) and `DistSq` (`:53-…`); add the
   include and use `Movement::TileSensor::` versions.
   - **Keep** `SafeRadius` (`:34-38`), `SafeReactWindowMs` (`:40-44`) and
     `ProjectileRadius` (`:46-51`).
   - **Do NOT touch `:204`** (`if (TestTAB::IsWalkPositionBlocked(x, y))`) —
     see divergence note 2.
   Verify: build + guardrail.

6. **Sweep for stragglers.**
   ```bash
   grep -rn 'kMemoSlots\|MemoFind\|MemoInsert\|MemoClear' internal/src   # empty
   grep -rnE 'uint32_t TileKey\(int' internal/src                        # only TileSensor.h
   ```
   Verify: full build + guardrail.

7. **Add guardrail check 17.** In `internal/tools/check-raw-access.sh`:

   ```bash
   # 17. Private tile-memo / tile-key copies under features/movement. The hazard
   #     memo and the tile-key packing live in
   #     features/movement/sensors/TileSensor.h; before that they were duplicated
   #     byte-for-byte across four sensor modules (one of which used a different
   #     container). A same-line raw-access-ok marker exempts a justified case.
   hits17="$(grep -rnE 'kMemoSlots|kMemoEmpty|\bMemoFind\(|\bMemoInsert\(|uint32_t TileKey\(int' "$root/features/movement" 2>/dev/null \
     | grep -v 'sensors/TileSensor' | grep -v 'raw-access-ok')"
   if [ -n "$hits17" ]; then
     echo "FORBIDDEN [private tile memo/key]:"; echo "$hits17"; fail=1
   fi
   ```

   Update the script header comment to mention check 17.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0. Paste
   `uint32_t TileKey(int a, int b);` into a movement file, confirm it fires,
   remove it.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
```

Greps that must return **zero** results when this plan is complete:

```bash
grep -rn 'kMemoSlots\|kMemoEmpty\|MemoFind(\|MemoInsert(' /home/jesse/realm-engine-client/internal/src \
  | grep -v 'sensors/TileSensor'
grep -rnE 'uint32_t TileKey\(int' /home/jesse/realm-engine-client/internal/src \
  | grep -v 'sensors/TileSensor'
grep -rn 'std::unordered_map<uint32_t, uint8_t> s_hazardMemo' /home/jesse/realm-engine-client/internal/src
```

**Runtime check.** Enable each dodge mode in turn from the dashboard
(`autoDodgeMode`: unified / pj-dodge / re-plus-plus / zdodge) with "Safe walk"
ON, stand next to damaging ground, and confirm each still refuses to path onto
it. The memo is a per-tick cache, so a clear-timing regression shows up as the
character walking onto a hazard it saw as safe one tick earlier — that is the
specific failure mode to watch for.

## Out of scope

- **Do NOT touch any solver, planner, pathfinder, scorer, or Phase-3 constant**
  (`kUArrivalMargin`, `kUDurablePocketMargin`, `kUTemporalSteps`, `kSolveWeaveW`,
  `kSolveOutRangeQuadW`, `kUReturnRangeSlack`, `kSolveReflexHystEps`, …). This
  plan is infrastructure only.
- **Do NOT move `SafeRadius`, `SafeReactWindowMs` or `ProjectileRadius`.**
  `SafeReactWindowMs` closes over each module's own `Settings` default type;
  unifying it means passing that default as a parameter, which changes four call
  chains for four lines of savings.
- **Do NOT change `ZDodgeSensors.cpp:204`.** Adding the finiteness guard there
  is a behavior change; it belongs in its own decision, not here.
- **Do NOT merge the four `*Sensors::Build` / `BuildMap` functions.** Their
  snapshot shapes (`DangerMap`, `Snapshot`, Repp's field) are genuinely
  different data structures for genuinely different planners.
- **Do NOT touch `WorldTAB::IsTileDamagingLive` or
  `TestTAB::IsWalkPositionBlocked`.** They are the backing implementations and
  stay exactly where they are.
- **Do NOT delete any of the four `*Sensors.h` headers or change their public
  signatures.** Every caller must compile untouched.
