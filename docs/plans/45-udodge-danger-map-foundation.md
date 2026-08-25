# 45 — UDodge Danger-Map Foundation (types + sensors, additive)

## Goal

After this plan, `internal/src/features/movement/udodge/` contains the new
INSTANTANEOUS danger-map data model and its sensor builders, compiled into the
DLL but not yet consumed by anything: `DangerMap` / `LaneThreat` / `ZoneThreat`
/ `MapInput` types in `UDodgeTypes.h`, and `Sensors::ReadWorldTick` /
`Sensors::BuildMap` / `Sensors::ReanchorMap` in `UDodgeSensors.{h,cpp}`. All
existing UDodge machinery (time-parameterized `Snapshot`, `Build`, the CCD
core) keeps working unchanged — this plan is purely additive so the repo
builds and behaves identically after every step. Plans 46/47 switch the engine
over and delete the old machinery.

Context (read once): the user directed that UDodge's danger representation
become an instantaneous 2D map, rebuilt in lockstep with the server NewTick
(observable as the WorldManager tick counter `RuntimeOffsets::WM_TickId`),
with no time-parameterized prediction. `docs/plans/44-udodge-instant-overview.md`
is the rationale of record — you do not need it to execute this plan.

Branch: commit on `refactor/unified-gameapi`. There is a pre-existing
UNCOMMITTED modification to `client/build-tools/dev-build.bat` — leave it
alone (do not stage, revert, or commit it).

## Dependencies

None — first executable plan of the workstream. Parallel-UNSAFE with plans
46-49 (they touch the same files).

Files touched: `internal/src/features/movement/udodge/UDodgeTypes.h`,
`UDodgeSensors.h`, `UDodgeSensors.cpp`. No other plan wave touches these, but
plans 46-49 of THIS workstream do — run strictly before them.

## Current state

The sensor layer builds a TIME-parameterized snapshot every frame:

- `UDodgeTypes.h:74-82` — `ProjectileThreat` stores `samples[]` +
  `sampleTimesMs[]` (a time-parameterized polyline).
- `UDodgeTypes.h:88-94` — `AoeThreat` stores `landingMs` / `remainMs` time
  windows.
- `UDodgeSensors.cpp:201-332` — `Build()` traces projectile paths with
  calibrated clocks (`p.elapsedCalMs`, lines 266-278), windowed by
  `settings.horizonMs + kPathPadMs` (line 219), and classifies AoEs by
  landing/remaining time windows (lines 311-318).

Nothing in the codebase polls `WM_TickId` from feature code today; WorldTAB
reads it diagnostically (`gui/tabs/WorldTAB.cpp:540`) via
`GameState::GetWorldMgr()` + `Mem::TryRead` — that is the sanctioned pattern
this plan reuses (precedent for `GameState` use in features/:
`features/combat/enemytracker/EnemyTracker.cpp:224`,
`features/movement/dodge/AoeTracking.cpp:229`).

## Target design

### New types (append to `UDodgeTypes.h`, keep everything existing)

```cpp
// ── Instantaneous danger map (plan 45) ──────────────────────────────────────
// Present-tense spatial danger only. No time values are stored: lane points
// are the projectile's LIVE position followed by its remaining travel path as
// pure geometry; zones are discs classified active (hard) / pending (soft).

constexpr int   kMaxLanePoints    = 24;     // per-lane polyline cap
constexpr float kHugeClearance    = 1.0e9f; // "no danger anywhere" sentinel
constexpr float kServerTickSec    = 0.2f;   // planning quantum: one server tick of motion
constexpr int   kCandProbes       = 16;     // candidate-segment probe intervals
constexpr float kCorridorCap      = 0.75f;  // per-neighbor clearance cap in corridor sum
constexpr float kClearBucket      = 0.1f;   // clearance bucketing for lexicographic compare
constexpr float kTraceStepMs      = 30.f;   // sensor-internal geometry tracing step —
                                            // time never leaves the sensor

struct LaneThreat {
    int32_t  bulletId      = 0;   // identity for mid-tick re-anchoring...
    int32_t  attackerObjId = 0;   // ...(bulletId alone is not globally unique)
    uint32_t ownerObjId    = 0;
    float    hitHalf       = 0.5f; // game IsHit Chebyshev half (same rule as before)
    int      pointCount    = 0;
    Vec2     points[kMaxLanePoints]{};   // points[0] = live position (anchor)
};

struct ZoneThreat {
    Vec2  pos{};
    float radius = 1.f;
    bool  active = false;  // true = detonated & persisting (HARD danger);
                           // false = telegraphed, not yet landed (SOFT cost)
};

struct DangerMap {
    uint32_t tickId    = 0;      // WM_TickId this layout was built from
    bool     tickValid = false;  // false => tick source unreadable (fail-safe mode)
    LaneThreat lanes[kMaxProjectiles]{};
    int  laneCount = 0;
    ZoneThreat zones[kMaxAoes]{};
    int  zoneCount = 0;
    EnemyBlocker enemies[kMaxEnemies]{};
    int  enemyCount = 0;
    bool projectileSourceUnavailable = false;
    bool limited = false;
    bool    hasLock = false;   // autopilot boss lock (same semantics as Snapshot)
    int32_t lockId  = 0;
    Vec2    lockPos{};
};

// Input for the instantaneous core (plan 46). Mirrors CoreInput minus every
// time field: no nowMs, no horizon/lead — stepTiles is a DISTANCE.
struct MapInput {
    Vec2  player{};
    Vec2  intentDir{};          // unit WASD/goal direction; zero when idle
    float stepTiles = 1.f;      // candidate commitment distance (tiles)
    float speed = 0.f;          // tiles per ms — for velocity output only
    uint32_t tickId = 0;        // map's tick stamp (tick-locked hysteresis)
    bool  movementLocked = false;
    bool  playerOnHazard = false;
    Settings settings{};
    Env env{};
    const DangerMap* map = nullptr;
};
```

Also append to `CoreState` (do NOT remove existing members yet — the old core
still uses them until plan 47):

```cpp
    // Tick-locked hysteresis (instantaneous core). Heading held while the
    // server tick is unchanged; re-decided at each NewTick sync.
    uint32_t selectedTick = 0;
    bool     haveTick = false;
```
and extend `CoreState::Reset()` to also reset these two.

And append to `CandidateDebug` (additive; old fields deleted in plan 47):

```cpp
    float clearance = kMaxTimeMs;  // min hard clearance along the step segment (tiles)
    float softCost  = 0.f;         // pending-zone penetration sum (tiles)
    float blockDist = kMaxTimeMs;  // distance at which walls truncate the segment
```

### New sensor API (append to `UDodgeSensors.h`)

```cpp
// ── Instantaneous danger map (plan 45) ──────────────────────────────────────
// Reads the WorldManager server-tick counter (increments once per processed
// NEWTICK). Returns false when WorldMgr/offset is unavailable — caller falls
// back to rebuilding the map every frame (fail-safe = fresher, never staler).
bool ReadWorldTick(uint32_t& outTickId);

// Full layout rebuild from live game state (game-update thread only).
// Does NOT stamp tickId/tickValid — the caller owns the stamp.
void BuildMap(DangerMap& out, float playerX, float playerY, const Settings& settings);

// Mid-tick refresh: re-anchor every lane to its projectile's LIVE position,
// re-derive zones. Returns false when the live projectile set no longer
// matches the map's lane set (spawn/retire) — caller must BuildMap instead.
// Enemies/boss-lock intentionally NOT refreshed (layout is per-tick).
bool ReanchorMap(DangerMap& map, float playerX, float playerY, const Settings& settings);
```

### Sensor implementation (append to `UDodgeSensors.cpp`)

New includes needed: `#include "GameState.h"`, `#include "MemRead.h"`,
`#include "RuntimeOffsets.h"` (top of file, alongside existing includes).
Use `Mem::TryRead` — never `reinterpret_cast` reads (guardrail check 2).

**`ReadWorldTick`**:

```cpp
bool ReadWorldTick(uint32_t& outTickId)
{
    void* wm = GameState::GetWorldMgr();
    if (!wm) return false;
    uint32_t tick = 0;
    if (!Mem::TryRead(wm, RuntimeOffsets::WM_TickId, tick)) return false;
    outTickId = tick;
    return true;
}
```

**`BuildMap`** — clone of today's `Build()` (`UDodgeSensors.cpp:201-332`)
with these exact differences (copy the existing code as the base; do not
change `Build()` itself):

1. Signature/reset: writes `DangerMap& out`; resets `laneCount/zoneCount/
   enemyCount/projectileSourceUnavailable/limited/hasLock/lockId/lockPos` and
   `MemoClear()`. Leaves `tickId/tickValid` untouched (caller stamps).
2. Enemy + boss-lock pass: byte-for-byte the same as `Build()` lines 226-246
   (writes into `out.enemies` / `out.hasLock` etc.).
3. Projectile pass → LANES. Same filter chain as lines 253-260 (valid /
   not-self / canHitPlayer heuristic / finite / 16-tile cull / cap check).
   For each accepted projectile `p`, fill `LaneThreat`:
   - `bulletId = static_cast<int32_t>(p.bulletId)`,
     `attackerObjId = p.attackerObjId`, `ownerObjId = p.ownerObjId`.
   - `hitHalf` — identical rule to line 292-294
     (`runtimeChebyshevHalf` if finite & > 1e-4 → else `projHalfSize` if
     finite & > 1e-4 → else 0.5f).
   - Lane tracing, in order of preference (times are LOCAL variables only —
     nothing time-valued is stored in the lane):
     a. **Coarse elapsed only**: `elapsed = float(nowMs > p.spawnTick ?
        nowMs - p.spawnTick : 0)`. Do NOT read `p.elapsedCalMs` — the live
        position is the anchor; calibration is deliberately unused here.
     b. **Cached path** (adapt `AddCachedPath`, lines 133-157): if
        `p.hasCachedPath && p.pathSampleCount >= 2` and not past lifetime —
        find the anchor index with the existing `CachedAnchorIndex(p, elapsed)`
        helper (line 103); `points[0] = {p.x, p.y}`; append
        `p.pathX/Y[i] rebased by (live − cachedAnchor)` for `i > anchor`,
        skipping non-finite, stopping when the sample time exceeds
        `p.lifetime`, when `pointCount == kMaxLanePoints`, or when the
        CUMULATIVE polyline length reaches
        `laneCap = std::clamp(settings.laneTiles, 2.f, 16.f)`
        (`settings.laneTiles` is added in step 1 below).
     c. **Fresh trace fallback** (adapt `AddFreshPath`, lines 169-197, and
        the dense fallback at 279-291): compute the rebase offset from
        `TryPredict(p, elapsed, ax, ay)` → `off = live − (ax,ay)`;
        `points[0] = live`; for `k = 1, 2, ...`:
        `t = elapsed + k × kTraceStepMs`; stop at `t > p.lifetime` (when
        lifetime > 0), on `TryPredict` failure, at `kMaxLanePoints`, or at
        cumulative length ≥ `laneCap`; append `(x,y) + off`.
     d. If tracing produced only `points[0]`, keep the lane as a single-point
        threat (the live disc still blocks).
   - Accept the lane (`++out.laneCount`) when `pointCount >= 1`.
4. AoE pass → ZONES. Same hook sources and filters as lines 302-322
   (`AoeTracking::EnsureInstalled`, `CopyActiveForDraw`, damaging/enemy/
   finite/radius clamp/cull checks) with these semantic changes:
   - Present-tense classification only (local variables):
     `elapsed = float(nowMs > a.spawnTick ? nowMs - a.spawnTick : 0)`;
     `lifeMs = finite && > 0 ? a.lifetime : 2000`; `landAt = (finite arcMs > 0)
     ? a.arcMs : lifeMs`; `hasLanded = elapsed >= landAt`.
   - Skip fully expired: `if (elapsed >= lifeMs + 25.f) continue;` and skip
     landed zones with < 25 ms of life left (parity with line 318).
   - Do NOT window by horizon (there is none): every not-yet-expired zone
     within the distance cull becomes a `ZoneThreat` with
     `active = hasLanded`. (A far-future telegraph is a SOFT zone — the
     core treats pending zones as cost, not veto, so this cannot pin the
     player; the overview records the over-blocking trade-off.)
5. Uses the same `s_projs` / `s_aoes` static vectors — `BuildMap` and
   `Build` never run in the same frame once plan 47 lands, and both run
   only on the game-update thread, so sharing the scratch vectors is safe.

**`ReanchorMap`**:

```cpp
bool ReanchorMap(DangerMap& map, float playerX, float playerY, const Settings& settings)
{
    if (!ProjectileTracking::IsInstalled()) return false;
    MemoClear();   // per-frame hazard memo reset (same contract as Build)
    // 1. Live projectile set, same filter chain as BuildMap.
    //    Any mismatch with map.lanes => structural change => return false.
    // 2. Per lane: nearest-point re-anchor.
    // 3. Zones: rebuilt wholesale (cheap; classification is present-tense).
}
```

1. `CopyActiveForDraw` into the static vector; apply the exact BuildMap
   filter chain; collect matched flags. Matching key:
   `(bulletId, attackerObjId, ownerObjId)`. If a live projectile has no lane,
   or a lane has no live projectile, or the filtered live count differs from
   `map.laneCount` → return false.
2. For each lane with live projectile at `(p.x, p.y)`:
   - Find `i` = index of the lane point nearest to the live position
     (linear scan over `pointCount`, squared Euclidean — mirror of
     `CachedAnchorIndex`'s spatial branch, lines 110-118).
   - Rebase: `shift = live − points[i]`; new polyline =
     `{live, points[i+1] + shift, ..., points[pointCount-1] + shift}`;
     update `pointCount` accordingly (in-place: shift-copy forward). If
     `i == pointCount - 1`, the lane collapses to the single live point.
3. Zone pass: reset `zoneCount` and re-run BuildMap's step-4 zone pass
   verbatim (factor it into a private helper `RebuildZones(DangerMap&, float
   px, float py, const Settings&, uint64_t nowMs)` used by both).
4. Enemies / lock / limited / projectileSourceUnavailable: untouched.
5. Return true.

### Settings additions (`UDodgeTypes.h` `Settings` struct)

Append (do not remove existing fields yet — old core still reads them):

```cpp
    float laneTiles = 12.f;  // danger-lane paint length (tiles)      [2, 16]
    float stepTiles = 0.f;   // candidate step distance; 0 = auto
                             // (tilesPerSec × kServerTickSec)        [0 | 0.4, 3]
```

### Threading / lifetime

Everything here is game-update-thread only (same contract as the existing
`Build`, `UDodgeSensors.cpp:6`). `ReadWorldTick` performs one SEH-safe
pointer-checked read per call. No per-frame heap allocation is introduced
(fixed arrays; the shared static scratch vectors amortize).

## Steps

1. `UDodgeTypes.h`: append the new constants, `LaneThreat`, `ZoneThreat`,
   `DangerMap`, `MapInput` after the existing `Snapshot` definition; append
   `laneTiles`/`stepTiles` to `Settings`; append the two tick fields to
   `CoreState` (and reset them in `Reset()`); append the three new fields to
   `CandidateDebug`. Touch nothing existing.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
2. `UDodgeSensors.h`: append the three new declarations with the doc comments
   shown above.
   `UDodgeSensors.cpp`: add the three includes; implement `ReadWorldTick`.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
3. `UDodgeSensors.cpp`: implement the private `RebuildZones` helper and
   `BuildMap` per the spec above (copy `Build` as the base; keep `Build`
   itself untouched).
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
4. `UDodgeSensors.cpp`: implement `ReanchorMap` per the spec above.
   Verify: `bash internal/tools/wsl-build.sh Debug` → 0 errors.
5. Guardrail + symbol check:
   `bash internal/tools/check-raw-access.sh` → exit 0.
   `grep -n "BuildMap\|ReanchorMap\|ReadWorldTick" internal/src/features/movement/udodge/UDodgeSensors.h`
   → three declarations present.
   Commit on `refactor/unified-gameapi` (message:
   `refactor(plan45): udodge instantaneous danger-map foundation`).
   Do NOT include `client/build-tools/dev-build.bat` in the commit.

## Verification

- `bash internal/tools/wsl-build.sh Debug` → MSBuild 0 errors after every step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- No behavior change: nothing calls the new code yet. In-game smoke test is
  not required for this plan.
- `grep -c "elapsedCalMs" internal/src/features/movement/udodge/UDodgeSensors.cpp`
  → must still be exactly the count from the OLD `Build` path (2 uses, lines
  272-273); the new `BuildMap` must add ZERO uses.

## Out of scope

- Do NOT modify `Build()`, `IsHazardAt`, `CanOccupy`, or any existing type
  member. Do NOT delete anything.
- Do NOT touch `UDodgeCore.*`, `UDodgeField.*`, `UDodge.*`, `UDodgeDebug.*`
  (plans 46/47).
- Do NOT touch `dodge/` shared infrastructure, `repp/`, `pjdodge/`,
  `zdodge/`, `gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp`,
  `gui/tabs/PlayerTAB.cpp`, `gui/tabs/CameraTAB.cpp`,
  `internal/tools/check-raw-access.sh`.
- Do NOT touch client/ code.
