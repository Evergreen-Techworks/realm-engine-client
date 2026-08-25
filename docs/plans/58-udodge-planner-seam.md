# 58 — Stage C1: Extract the Plain-Data Planner Seam (behavior-preserving)

## Goal
After this plan, UDodge has a clean, plain-data planning seam: a `PlannerSnapshot`
struct (everything the goal planner needs, no IL2CPP handles), a `PlanResult`
struct (the planner's decision, no IL2CPP handles), and a pure
`Planner::Compute(const PlannerSnapshot&, PlanResult&)` function that today
reproduces exactly the current Autopilot boss-lock orbit intent. It runs
SYNCHRONOUSLY on the game-update thread; behavior is byte-for-byte identical to
today. This is the refactor that makes Stage C2 (moving `Compute` to a worker
thread) a pure relocation with no behavior change.

## Dependencies
Plan 57 merged. Touches `internal/src/features/movement/udodge/UDodge.cpp`,
`UDodgeTypes.h`, and adds `UDodgePlanner.{h,cpp}`. Plans 59-61 build directly on
the symbols this creates.

## Current state

The autopilot goal intent is computed inline in `UDodge.cpp`:

- `OrbitIntent(Vec2 player, float tx, float ty)` — `UDodge.cpp:102-113`: unit
  direction that closes to / orbits at `AutoAim::GetProjRangeTiles() × 0.85`.
- `AutopilotIntent(const DangerMap& sn, Vec2 player, const Settings&, bool&,
  Vec2&)` — `UDodge.cpp:129-160`: priority 1 = stand-on lantern (walks
  `WorldTAB::GetEntities()` — an IL2CPP entity walk, MUST stay game-thread);
  priority 2 = boss lock (`sn.hasLock`, `sn.lockPos`) → `OrbitIntent`.
- Called from `Tick` at `UDodge.cpp:230-232`:
  ```cpp
  } else if (settings.mode == 1 /*Autopilot*/) {
      in.intentDir = AutopilotIntent(g_map, in.player, settings, apHasTarget, apTarget);
      intentIsAuto = true;
  }
  ```

`AutoAim::GetProjRangeTiles()` / `IsProjRangeResolved()` read cached weapon-range
state; whether they touch live IL2CPP must be verified (Step 1) — if they do,
their result is captured into the snapshot on the game thread.

## Target design

New files `internal/src/features/movement/udodge/UDodgePlanner.{h,cpp}`, namespace
`UDodge::Planner`.

`UDodgePlanner.h`:
```cpp
#pragma once
#include "UDodgeTypes.h"
namespace UDodge { namespace Planner {

// Everything the goal planner needs — PLAIN DATA ONLY (no IL2CPP handles, no
// void*, no function pointers). Safe to copy across a thread boundary.
struct PlannerSnapshot {
    uint32_t seq = 0;          // monotonically increasing publish sequence
    uint32_t tickId = 0;
    Vec2     player{};
    Settings settings{};
    bool     hasLock = false;
    Vec2     lockPos{};
    float    weaponRangeTiles = 6.f;   // resolved on the game thread
    bool     rangeResolved = false;
    // (Stage D1/60 adds the DangerMap + rasterized occupancy grid here.)
};

// The planner's output — PLAIN DATA ONLY.
struct PlanResult {
    uint32_t forSeq = 0;       // snapshot seq this plan was computed from
    bool     hasGoal = false;  // a goal target exists (autopilot has a lock)
    Vec2     goalPos{};        // world target the plan aims at
    Vec2     firstDir{};       // unit intent direction to feed Core::Evaluate (0 = none)
    // (Stage D1/60 adds Vec2 path[] + int pathCount for overlay drawing.)
};

// Pure, host-independent, thread-safe: no IL2CPP, no globals, no I/O.
void Compute(const PlannerSnapshot& in, PlanResult& out);

} } // namespace UDodge::Planner
```

`UDodgePlanner.cpp` — port `OrbitIntent` verbatim (it is pure math already) and
implement `Compute`: if `in.hasLock`, set `out.hasGoal=true`, `out.goalPos =
in.lockPos`, `out.firstDir = OrbitIntent(in.player, in.lockPos, in.weaponRangeTiles)`;
else clear. `OrbitIntent` takes the resolved range as a parameter now (instead of
calling `AutoAim` inside), so the function is pure.

**The lantern stand-on path (`UDodge.cpp:134-153`) STAYS in `UDodge.cpp` on the
game thread** — it walks `WorldTAB::GetEntities()` (IL2CPP) and can never move to
a worker. In `Tick`, the autopilot branch becomes: try the lantern path first
(unchanged, game-thread); if it did not produce a target, pack the snapshot and
call `Planner::Compute` for the boss-lock orbit. This preserves the exact
priority order of today's `AutopilotIntent`.

## Steps

1. **Verify `AutoAim` range access threading.** Read
   `AutoAim::GetProjRangeTiles()` / `IsProjRangeResolved()`. Confirm they read
   cached plain state (safe to call game-thread and cache into the snapshot).
   Record the finding as a comment in `UDodgePlanner.cpp`. No build.

2. **Add `UDodgePlanner.{h,cpp}`** with the types and `Compute` above; move
   `OrbitIntent` into it as a pure function taking `rangeTiles`. Add the new `.cpp`
   to the build (it is picked up by the project's glob; if not, note the `.vcxproj`
   entry). Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

3. **Rewire `Tick`'s autopilot branch** (`UDodge.cpp:230-232`) to: (a) run the
   lantern stand-on scan inline (extract the `settings.followLantern` block from
   the old `AutopilotIntent`, `UDodge.cpp:134-153`, keeping it exactly); (b) if no
   lantern target, build a `PlannerSnapshot` from `g_map`/`in.player`/`settings`
   plus the game-thread-resolved weapon range, call `Planner::Compute`, and use
   `result.firstDir` as `in.intentDir` with `apHasTarget/apTarget` from
   `result.hasGoal/goalPos`. Delete the now-unused `OrbitIntent`/`AutopilotIntent`
   from `UDodge.cpp`. Build + guardrail.

4. **In-game verify** autopilot orbit is unchanged from before this plan (same
   orbit distance, same lock behavior). Assist mode and pure dodge unaffected.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
```

In-game: Autopilot (udodgeMode=autopilot) orbits the boss at the same radius and
follows the lock exactly as before Stage C1. No behavioral difference is the
success criterion — this is a pure refactor.

`grep -n "AutopilotIntent\|OrbitIntent" internal/src/features/movement/udodge/UDodge.cpp`
returns nothing (both moved out).

## Out of scope
- Do NOT start any threading — `Compute` runs synchronously this stage.
- Do NOT add the DangerMap or occupancy grid to `PlannerSnapshot` yet (plan 60).
- Do NOT change orbit math, range, or lock selection behavior.
- Do NOT touch `repp/` (read-only reference for the ported math).
