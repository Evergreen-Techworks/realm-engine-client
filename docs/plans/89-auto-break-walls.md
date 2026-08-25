# 89 — Auto-break-walls + raw-access guardrail (DLL)

## Goal

After this plan, when navigation wedges against a breakable wall on the route,
the DLL detects it, pins killaura onto that wall, engages autofire until the wall
dies (or a timeout expires), then releases and lets navigation re-plan. It is a
thin orchestrator: it introduces **no** new game bindings, **no** new hooks, and
**no** nav-grid mutation — it composes `UDodge`'s existing stuck detector,
`EnemyTracker`'s existing entity snapshot, `KillAura::SetForcedTargetId`
(plan 85) and `AutoFire::SetAutoEngage` (plan 88).

This plan also closes the workstream with the guardrail that stops new private
shoot/aim bindings from creeping back into `features/`.

## Dependencies

**Plans 85, 87 and 88 must all be merged first.**
* 85 → `KillAura::SetForcedTargetId` / `KillAura::GetState`
* 87 → the local origin actually moves, so the wall takes damage
* 88 → `AutoFire::SetAutoEngage`

Files this plan touches that other plans also touch:

| File | Also touched by |
|---|---|
| `internal/il2cpp-dll-injection.vcxproj` (+ `.filters`) | 85, 87, 88 |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp` | 85, 87, 88 |
| `internal/src/features/control/FeatureCommandRegistry.cpp` | 85, 88 |
| `internal/src/features/movement/udodge/UDodge.{h,cpp}` | **nobody else — but see the Phase-3 warning** |
| `internal/tools/check-raw-access.sh` | nobody else |

**PHASE-3 CONFLICT WARNING.** `internal/src/features/movement/udodge/UDodgeSolver.cpp`
and `internal/src/features/movement/udodge/UDodgeTypes.h` were retuned by the
Phase-3 dodge-tightness work (plans 90–95). **Do not edit either file.** This
plan's *only* udodge change is a ~15-line, purely-additive publication of an
already-computed signal inside `UDodge.cpp` plus one struct + one declaration in
`UDodge.h`. If your working tree shows `UDodge.cpp` as modified, rebase first and
re-read the stuck-detector block before editing — the line numbers below may have
drifted.

**BUILD HAZARD:** `internal/tools/wsl-build.sh` writes to a shared
`C:\rebuild\Debug`. Do not run it while another agent is building.

## Current state

### 1. The nav stuck detector already exists — it just isn't published

`internal/src/features/movement/udodge/UDodge.cpp:559-586`, inside `UDodge::Tick`:

```cpp
    bool navReplan = false;
    Vec2 navStep{ walkX, walkY };
    if (walkActive) {
        const Vec2  wg{ walkX, walkY };
        ...
        // STUCK detector: if we stop making progress toward the goal for a while
        // (wedged on a wall the cached route didn't know about, or the route runs
        // through undiscovered geometry), force a re-plan with a freshly-rasterized
        // window so the A* can route around it. ...
        static ULONGLONG s_navProgressMs = 0;
        static float     s_navBestDist   = 1e18f;
        const ULONGLONG  nowNav   = GetTickCount64();
        const float      distGoal = std::sqrt(LenSq(Sub(wg, in.player)));
        if (!g_navCache.valid || distGoal < s_navBestDist - 1.0f) {
            s_navBestDist = distGoal; s_navProgressMs = nowNav;      // made progress → reset
        } else if (nowNav - s_navProgressMs > 1500ULL) {
            navReplan = true;                                        // no progress for 1.5s → stuck → re-plan
            s_navBestDist = distGoal; s_navProgressMs = nowNav;
        }
```

The walk goal itself comes from
`internal/src/features/movement/udodge/UDodge.cpp:510-511`:

```cpp
    bool  walkActive = false;
    DangerPlanner::GetWalkGoal(walkX, walkY, walkActive);
```

Nothing outside `UDodge::Tick` can see any of this today —
`internal/src/features/movement/udodge/UDodge.h:76` exposes `GetDiagView()` and
`GetSafetyState()` but neither carries the wedge state.

### 2. Breakable walls are already in the enemy snapshot

`internal/src/features/combat/enemytracker/EnemyTracker.h:11-20`:

```cpp
struct Entry {
    int32_t id; int32_t objType;
    float   x, y;
    int32_t hp, maxHp;
    float   vx, vy;
    bool    isInvulnerable;
    bool    hasHealthBar;    // false for walls/destructibles (noHealthBar)
    void*   ptr;
};
```

`internal/src/features/combat/enemytracker/EnemyTracker.cpp:147-149` populates it
and explicitly does **not** reject the entity:

```cpp
        // noHealthBar (walls/destructibles) — stored as metadata, not hard-rejected
        const uint8_t noHB = *reinterpret_cast<uint8_t*>(op + RuntimeOffsets::OP_NoHealthBar);
```

`TargetSelector` is where the filtering happens
(`internal/src/features/combat/autoaim/TargetSelector.cpp:80,126`:
`if (cfg.ignoreWalls && !e.hasHealthBar) …`). Plan 85's `SelectKillAura` already
disables that filter when a forced target id is set.

### 3. Wall entities are ALREADY fed into the nav occupancy — mostly

`internal/src/features/movement/udodge/UDodgeSensors.cpp:363-391`
(`PopulateEnemies`) walks the **whole** `EnemyTracker` snapshot with no
`hasHealthBar` filter and writes each entry as an `EnemyBlocker` with a baked
`kEnemyRadius = 0.8f` (`UDodgeSensors.cpp:34`). The worker pathfinder consults
those blockers per nav cell —
`internal/src/features/movement/udodge/UDodgePathfinder.cpp:491-497`
(`NavBlocked` → `EnemyBlockedLocal`), and so does the immediate solver
(`internal/src/features/movement/udodge/UDodgeCore.cpp:186-194`, `EnemyBlocked`).

So the "nav paths straight through breakable walls" problem is **not** a missing
data feed. It has two real, narrower causes, both of which this plan
**documents rather than changes**:

* **Cap.** `PopulateEnemies` culls to 16 tiles (`kThreatCullTiles`,
  `UDodgeSensors.cpp:24`) and stops at `kMaxEnemies = 64`
  (`internal/src/features/movement/udodge/UDodgeTypes.h:23`), setting
  `out.limited = true`. A corridor lined with breakable walls can exhaust 64
  slots, after which the remaining walls are invisible to nav.
  `UDodgeTypes.h` is in the Phase-3 conflict zone — **do not raise the cap here.**
* **Filter.** `EnemyTracker` rejects `maxHp == 200` entities as decoys unless
  whitelisted (`EnemyTracker.cpp:165-170`). Some breakable walls have exactly
  200 max HP and are therefore never in the snapshot at all — invisible to both
  nav and killaura.

Both are pre-existing behaviours shared with AutoAim and auto-dodge. Changing
either silently changes targeting and dodging for every user, so they belong in
their own plan. See §Divergence bugs.

### 4. Feature plumbing precedents

* Per-frame entry: `internal/src/gui/tabs/CombatTab/CombatTAB.cpp:19-33` ←
  `internal/src/platform/hooks/DirectX.cpp:236`.
* IPC key table: `internal/src/features/control/FeatureCommandRegistry.cpp:93-110`.
* Guardrail script and its check-numbering convention:
  `internal/tools/check-raw-access.sh` (checks 1–12; check 12 forbids
  `il2cpp_field_get_offset` in `features/`).

## Target design

### 9.1 `UDodge::GetNavWedge()` — publish the existing signal

`internal/src/features/movement/udodge/UDodge.h`, add next to `SafetyState`
(around line 47):

```cpp
// Nav wedge signal (plan 89). Published from the walk-to stuck detector inside
// Tick(): `wedged` latches true when the nav goal has seen no progress for
// >1.5 s and clears on the next real progress step or when walk-to ends. Written
// on the game thread at the end of each Tick, read by auto-break-walls on the
// render thread — a plain atomic snapshot, consumed as a hint (never a lock).
struct NavWedge {
    bool     walkActive = false;
    bool     wedged     = false;
    float    goalX = 0.f, goalY = 0.f;
    float    playerX = 0.f, playerY = 0.f;
    uint32_t stampMs = 0;    // GetTickCount64() low 32 bits, updated every Tick
};
NavWedge GetNavWedge();
```

`internal/src/features/movement/udodge/UDodge.cpp` — additive only:

1. file-scope, next to the other module state:
   ```cpp
   static std::atomic<bool>     g_wedgeWalkActive{ false };
   static std::atomic<bool>     g_wedged{ false };
   static std::atomic<float>    g_wedgeGoalX{ 0.f }, g_wedgeGoalY{ 0.f };
   static std::atomic<float>    g_wedgePlayerX{ 0.f }, g_wedgePlayerY{ 0.f };
   static std::atomic<uint32_t> g_wedgeStampMs{ 0 };
   ```
2. inside the existing stuck-detector block (currently `UDodge.cpp:571-585`),
   **without changing any existing statement**, set `g_wedged` to `false` on the
   progress branch and to `true` on the 1500 ms branch, and always store
   `walkActive`, the goal, the player position and the stamp;
3. in the `else if (g_navCache.valid)` branch at `UDodge.cpp:585-587` (walk-to
   ended) clear `g_wedged` and `g_wedgeWalkActive`;
4. implement `GetNavWedge()` as a plain read of the six atomics.

**Do not** promote the two function-local `static`s to file scope, **do not**
change the 1.0-tile progress epsilon or the 1500 ms threshold, and **do not**
touch `navReplan`. The wedge signal must be a pure observation of a decision the
solver already makes.

### 9.2 `AutoBreakWalls`

New file pair `internal/src/features/combat/autobreak/AutoBreakWalls.h` / `.cpp`
(not on the include path — include by full subpath).

```cpp
#pragma once
#include <cstdint>

// AutoBreakWalls — when nav wedges against a breakable wall on the route, pin
// killaura onto it and hold autofire until it dies, then release. Pure
// orchestration: no game bindings, no hooks, no nav mutation. Ticked from
// CombatTAB::Tick on the render thread.
namespace AutoBreakWalls {

void Tick();

void SetEnabled(bool on);          bool  IsEnabled();          // default OFF
void SetProbeTiles(float t);       float GetProbeTiles();      // clamp [0.5, 6], default 2.5
void SetTimeoutMs(int ms);         int   GetTimeoutMs();       // clamp [1000, 30000], default 6000

struct Diag {
    bool     enabled     = false;
    bool     navWedged   = false;
    int32_t  targetId    = 0;      // 0 = not engaged
    int32_t  targetHp    = 0;
    uint32_t engagedMs   = 0;
    uint32_t engagements = 0;
    char     lastRelease[24] = {}; // "killed" | "timeout" | "gone" | "unwedged" | "disabled"
};
Diag GetDiag();

void RenderSettings();   // render thread

} // namespace AutoBreakWalls
```

State machine (`Tick`, evaluated once per frame, throttled to 50 ms):

```
Idle:
  if (!enabled)                                    -> release("disabled"); return
  w = UDodge::GetNavWedge()
  if (!w.walkActive || !w.wedged)                  -> return
  if ((uint32_t)GetTickCount64() - w.stampMs > 500) -> return   // stale udodge tick
  pick = SelectBreakable(w)
  if (!pick)                                       -> rate-limited log; return
  KillAura::SetForcedTargetId(pick.id)
  AutoFire::SetAutoEngage(true)
  -> Engaged, log the ENGAGE edge (id, objType, dist, hp)

Engaged:
  if (!enabled)                                    -> release("disabled")
  e = find pick.id in EnemyTracker::GetSnapshot()
  if (!e)                                          -> release("gone")     // despawned or killed
  if (e->hp <= 0)                                  -> release("killed")
  if (now - engageStart > timeoutMs)               -> release("timeout")
  w = UDodge::GetNavWedge()
  if (!w.wedged) { if (unwedgedFor > 1000ms) release("unwedged"); }
  else unwedgedSince = 0
  // otherwise hold: killaura stays pinned, autofire stays engaged

release(reason):
  KillAura::SetForcedTargetId(0)
  AutoFire::SetAutoEngage(false)
  record reason, log the RELEASE edge, -> Idle
```

`SelectBreakable(w)` — pure math over `EnemyTracker::GetSnapshot()`:

```
dirX,dirY = normalize(w.goal - w.player)      // if length < 1e-4 -> no pick
best = none
for e in EnemyTracker::GetSnapshot():
    if (e.hasHealthBar) continue              // only no-health-bar destructibles
    if (e.hp <= 0) continue
    if (e.isInvulnerable) continue
    rx = e.x - w.playerX; ry = e.y - w.playerY
    along = rx*dirX + ry*dirY                 // projection onto the route direction
    if (along <= 0.f || along > probeTiles + 1.5f) continue   // behind us / too far ahead
    perp = fabsf(rx*dirY - ry*dirX)           // lateral distance from the route line
    if (perp > probeTiles) continue
    score = along + perp                      // nearest along-route wall wins
    keep the minimum
```

Call `EnemyTracker::Tick()` (self-throttled — `EnemyTracker.cpp:205-209`) before
reading the snapshot, exactly as `AutoAim::RunTick` does
(`internal/src/features/combat/autoaim/AutoAim.cpp:74`).

**Threading.** `Tick` runs on the render thread only, same as `KillAura::Tick`
and `AutoFire::Tick`, so no synchronisation beyond the atomics in `GetNavWedge`.

**Interaction with killaura's normal mode.** `KillAura::SetForcedTargetId(id)` is
a hard override; while engaged the user's at-target/at-mouse selection is
suspended. `AutoBreakWalls` **must** be the only caller of
`SetForcedTargetId` — enforced by the guardrail grep in §9.4 — and must always
restore `0` on every release path, including the `disabled` path, so a disabled
feature can never strand the override.

### 9.3 IPC keys + UI

`internal/src/features/control/FeatureCommandRegistry.cpp`, `ApplyCoreFeature`:

```cpp
FH_BOOL ("autoBreakWallsEnabled",    AutoBreakWalls::SetEnabled),
FH_FLOAT("autoBreakWallsProbeTiles", AutoBreakWalls::SetProbeTiles),
FH_INT  ("autoBreakWallsTimeoutMs",  AutoBreakWalls::SetTimeoutMs),
```

Do **not** add these to `client/src/bridge/contract.ts` (no client plugin drives
them in v1; keeping the TS side untouched preserves plan 86's independence).

`AutoBreakWalls::RenderSettings()`: Enable checkbox, probe-tiles slider,
timeout slider, and a status line
`wedged=<0/1> target=<id> hp=<n> engagedMs=<n> lastRelease=<reason> total=<n>`.

### 9.4 Guardrail (the ratchet step)

Append to `internal/tools/check-raw-access.sh`, following the existing numbered
style (the file currently ends with check 12 and `exit $fail`):

```bash
# 13. Shoot/aim method tokens outside their sanctioned homes. AimHooks HOOKS
#     these; ShootRuntime CALLS them. A third site means someone re-bound the
#     shoot path privately instead of routing through those two.
hits13="$(grep -rnE 'ELCBJAFBLJG|EHGHCACPAGH|PMIANFBMMNN' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autoaim/AimHooks.cpp' | grep -v 'autoaim/ShootRuntime.cpp' \
  | grep -v 'raw-access-ok')"
if [ -n "$hits13" ]; then
  echo "FORBIDDEN [private shoot-method binding]:"; echo "$hits13"; fail=1
fi

# 14. KillAura's forced-target override has exactly ONE owner (auto-break-walls).
#     A second caller would silently fight it for the target.
hits14="$(grep -rn 'KillAura::SetForcedTargetId' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autobreak/AutoBreakWalls.cpp' | grep -v 'raw-access-ok')"
if [ -n "$hits14" ]; then
  echo "FORBIDDEN [second forced-target owner]:"; echo "$hits14"; fail=1
fi
```

Mirror both checks in `internal/tools/check-raw-access.ps1` if that file defines
the same numbered checks (it is the Windows mirror run by
`internal/build-and-test.bat`); if the mirror has drifted, add the two checks in
whatever form it already uses and note the drift in the commit message.

## Steps

1. **Publish the nav wedge signal.**
   Edit `internal/src/features/movement/udodge/UDodge.h` (add `NavWedge` +
   `GetNavWedge()`), and `internal/src/features/movement/udodge/UDodge.cpp` (add
   the six atomics, the stores inside the existing stuck-detector branches, the
   clear on walk-to end, and `GetNavWedge()`), all per §9.1.
   *Purely additive: no existing statement, constant or branch changes, so udodge
   behaviour is bit-identical.*
   → `bash internal/tools/wsl-build.sh Debug`

2. **Create `AutoBreakWalls` (observe only).**
   Create `internal/src/features/combat/autobreak/AutoBreakWalls.{h,cpp}` with
   all setters/getters, `Diag`, `SelectBreakable`, and a `Tick` that runs the full
   state machine **but never calls `KillAura::SetForcedTargetId` or
   `AutoFire::SetAutoEngage`** (leave `// STEP 4:` markers). Register both files
   in `internal/il2cpp-dll-injection.vcxproj` and `.vcxproj.filters`.
   → `bash internal/tools/wsl-build.sh Debug`

3. **Wire tick + UI.**
   Edit `internal/src/gui/tabs/CombatTab/CombatTAB.cpp`: include
   `features/combat/autobreak/AutoBreakWalls.h`, call `AutoBreakWalls::Tick();`
   in `CombatTAB::Tick`, and add a separator + `AutoBreakWalls::RenderSettings();`
   to `CombatTAB::Render()`. Implement `RenderSettings` per §9.3.
   *In-game: enable it, walk-to into a breakable wall, and confirm the status line
   shows `wedged=1 target=<id>` with a plausible id. Nothing fires yet.*
   → `bash internal/tools/wsl-build.sh Debug`

4. **Engage.**
   Replace the `// STEP 4:` markers with the real
   `KillAura::SetForcedTargetId(...)` / `AutoFire::SetAutoEngage(...)` calls on
   engage and all five release paths. Add transition-only ENGAGE/RELEASE edge
   logs (id, objType, hp, reason) and a 30-second liveness stamp
   `[AutoBreakWalls] alive enabled=1 wedged=<0/1> target=<id>` — this feature owns
   no hook, so the stamp is the only proof it runs.
   → `bash internal/tools/wsl-build.sh Debug`

5. **IPC keys.**
   Edit `internal/src/features/control/FeatureCommandRegistry.cpp` per §9.3.
   → `bash internal/tools/wsl-build.sh Debug`

6. **Guardrail.**
   Edit `internal/tools/check-raw-access.sh` (and its `.ps1` mirror) per §9.4.
   → `bash internal/tools/check-raw-access.sh` (must exit 0) and
     `bash internal/tools/wsl-build.sh Debug`

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # "0 Error(s)"
bash internal/tools/check-raw-access.sh       # exit 0, no output — now includes checks 13 & 14
```

Must return **zero** results — the forced-target override has exactly one owner:

```bash
grep -rn 'SetForcedTargetId' internal/src/ \
  | grep -v 'internal/src/features/combat/killaura/KillAura' \
  | grep -v 'internal/src/features/combat/autobreak/AutoBreakWalls.cpp'
```

Must return **zero** results — auto-break introduces no bindings and no hooks:

```bash
grep -rnE 'MH_CreateHook|il2cpp_|RuntimeOffsets::' internal/src/features/combat/autobreak/
```

Must return **zero** results — the udodge edit is additive only, so the tuned
Phase-3 files are untouched:

```bash
git diff --name-only main -- internal/src/features/movement/udodge/ \
  | grep -vE 'UDodge\.(h|cpp)$'
```

In-game acceptance:
1. Enable UDodge walk-to, click a spot behind a breakable wall.
2. Enable Combat → AUTO-BREAK-WALLS (and Killaura + Autofire).
3. Within ~2 s the character stops making progress, the status line shows
   `wedged=1 target=<id>`, firing starts, the wall dies, `lastRelease=killed`
   appears, and navigation resumes to the original spot.
4. The trace log has exactly one ENGAGE and one RELEASE line per wall.
5. Disable the feature mid-engagement: firing stops immediately and
   `KillAura`'s status line returns to normal target selection (proving the
   override was restored).

## Divergence bugs (do NOT fix here — record and hand off)

Two pre-existing behaviours limit how many breakable walls are visible. Both are
shared with AutoAim and auto-dodge, so changing either alters behaviour for
features that never asked for it. They need their own plan and their own
in-game A/B, not a smuggled edit inside this refactor.

1. **`maxHp == 200` decoy rejection.**
   `internal/src/features/combat/enemytracker/EnemyTracker.cpp:165-170`:
   ```cpp
   if (!IsWhitelistedType(objType)) {
       if (maxHp == 200) return false;
   ```
   Breakable walls with exactly 200 max HP never enter the snapshot, so neither
   nav nor killaura can see them. *Intended behaviour is almost certainly to keep
   the decoy filter for health-bar enemies but exempt `noHealthBar` destructibles*
   — but that changes AutoAim's target pool too, so it must be decided
   deliberately.

2. **64-blocker cap in nav occupancy.**
   `internal/src/features/movement/udodge/UDodgeSensors.cpp:376-382` stops at
   `kMaxEnemies = 64` (`internal/src/features/movement/udodge/UDodgeTypes.h:23`)
   and sets `out.limited = true`. In a corridor of breakable walls the overflow
   walls are invisible to `NavBlocked`
   (`internal/src/features/movement/udodge/UDodgePathfinder.cpp:491-497`), which
   is the actual "nav paths through walls" symptom. `UDodgeTypes.h` is in the
   Phase-3 conflict zone; raising the cap also raises the per-cell cost of every
   pathfinder query, so it needs a perf measurement.

## Out of scope

* **Do not** edit `internal/src/features/movement/udodge/UDodgeSolver.cpp`,
  `UDodgeTypes.h`, `UDodgeSensors.cpp`, `UDodgePathfinder.cpp` or
  `UDodgeCore.cpp`. The only udodge change is the additive signal in
  `UDodge.{h,cpp}`.
* **Do not** change the stuck detector's thresholds (1.0-tile progress epsilon,
  1500 ms), the `kEnemyRadius = 0.8f` blocker size, `kMaxEnemies`, or
  `kThreatCullTiles`.
* **Do not** write into the nav grid, the danger map, or the walk goal. Auto-break
  never steers; it only shoots. Navigation resumes on its own once the wall
  entity disappears from the snapshot.
* **Do not** change `EnemyTracker`'s filters (see §Divergence bugs).
* **Do not** teach killaura or autofire about walls — they already work for any
  object id.
* **Do not** add client-side (`client/**`) code. This feature is entirely
  DLL-side.
