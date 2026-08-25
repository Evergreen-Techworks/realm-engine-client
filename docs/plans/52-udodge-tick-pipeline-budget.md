# 52 — UDodge Stage 2: Tick-Hooked Pipeline + Per-Tick Move-Budget Tracker

## Goal

After this plan, UDodge's per-frame work is a formally ordered, tick-driven
pipeline — NewTick(applied) → rebuild/re-anchor danger map → decide → execute —
and it tracks "displacement spent so far this server tick" keyed on
`WM_TickId`, exposing the REMAINING per-tick move budget. Nothing yet consumes
the budget to move (that is Stage 4); this plan lays the load-bearing
accounting that makes budget-bounded execution possible and safe, plus a
diagnostic readout so the user can watch the budget in-game. Behavior is
unchanged: the same `CallMoveTo` runs with the same target every frame.

The plan also records the investigation of the update-hook ordering vs. the
game's outgoing MOVE emit, and includes an OPTIONAL, independently-revertible
final step that reorders UDodge to run before the game's update (so a dodge can
land in the same tick's MOVE). That step is fenced off with a clear rollback
because it trades sensing freshness for MOVE timing — see Step 6.

## Dependencies

Plan 51 MUST be merged first (this plan adds fields next to the Stage-1
`reactMargin` fields in `UDodgeTypes.h` and new accessors in `UDodge.cpp`).

Files touched: `UDodgeTypes.h`, `UDodge.cpp` (and, in the optional Step 6,
`internal/src/features/movement/dodge/DangerPlanner.cpp`). Plan 53 also touches
`UDodgeCore.cpp`/`UDodgeTypes.h` — merge this plan first.

## Current state

- The UDodge pipeline already runs in order inside `UDodge::Tick`
  (`UDodge.cpp:180-299`): `Sensors::ReadWorldTick` (201-202) →
  `ReanchorMap`/`BuildMap` with tick stamping (204-211) → build `MapInput`
  (218-248) → `Core::Evaluate` (250) → `CallMoveTo` (267-271). It is ordered
  but NOT documented as a pipeline, and it does no budget accounting.
- The dispatch hook: `DangerPlanner.cpp:805-809`
  `Detour_AppEngineUpdate` calls `s_origUpdate(__this, method)` (the whole game
  `AppEngineManager::Update`) FIRST, then `DodgeTickGuarded()` (which calls
  `RunDodgeTickBody` → `UDodge::Tick`). So UDodge currently runs AFTER the
  game's update for the frame.
- The move budget source exists: `DodgeRuntime::GetTilesPerSec(player)`
  (`MovementRuntime.cpp:153-186`) and `kServerTickSec = 0.2f`
  (`UDodgeTypes.h:110`). One tick of motion = `tilesPerSec × kServerTickSec`
  (this is already the `stepTiles` auto value at `UDodge.cpp:239-241`).
- `WM_TickId` read helper: `Sensors::ReadWorldTick(uint32_t&)`
  (`UDodgeSensors.cpp:321-329`), returns false when the source is unreadable.

## Investigation findings (record; they justify Step 6's caution)

- The outgoing MOVE is emitted by the game inside `AppEngineManager::Update`
  (the hook target). `MoveTo` (`FKALGHJIADI::DGLCONCOIBO`) is documented as
  "speed-clamped, collision-checked, packet-emitting" (`DangerPlanner.h:29-34`):
  it records the authoritative position; the periodic MOVE flushes it on server
  tick boundaries. There is NO separate DLL-hookable MOVE method (packets are
  parsed Electron-side; the DLL only observes game state).
- Because UDodge calls `MoveTo` EVERY frame (60 Hz) and the game integrates
  toward the target each frame, the player's position at the next tick boundary
  already reflects the dodge regardless of pre/post-update ordering on the
  boundary frame. Pre-vs-post ordering changes at most ONE frame (~16 ms) of
  motion in the boundary-frame MOVE.
- Running UDodge BEFORE `s_origUpdate` (Step 6) makes a dodge landable in the
  same tick's MOVE, but it also means the danger map is built/re-anchored from
  PRE-update game state (projectile positions one frame old; `WM_TickId` read
  before the game applies the NewTick, so the tick-change rebuild can lag by one
  frame). This is a real sensing-vs-acting tradeoff, which is why Step 6 is
  optional and revertible on its own.
- The per-tick BUDGET accounting does NOT require the reorder — it only needs to
  key on `WM_TickId` transitions, which works in either order (and is actually
  fresher post-update). So Steps 1-5 are the safe, mandatory core of this plan.

## Target design

A small budget tracker, game-update-thread only, owned by `UDodge.cpp`:

```cpp
// Per-tick move-budget accounting (game-update thread only). Keyed on the
// server tick (WM_TickId). At each tick boundary, latch the player's position
// and the tick's move budget; "spent" is the straight-line displacement from
// that latched position; "remaining" is budget − spent, floored at 0.
struct TickBudget {
    uint32_t tick   = 0;
    bool     valid  = false;   // false => tick unreadable; no budget guarantee
    Vec2     startPos{};       // player position latched at tick start
    float    budgetTiles = 0.f;

    // Call once per frame AFTER reading the tick and player position.
    void Update(bool tickOk, uint32_t curTick, Vec2 playerPos, float tilesPerSec) {
        const float budget = std::max(0.f, tilesPerSec) * kServerTickSec;
        if (!tickOk) { valid = false; startPos = playerPos; budgetTiles = budget; return; }
        if (!valid || curTick != tick) {   // new tick (or first valid frame)
            tick = curTick; startPos = playerPos; budgetTiles = budget; valid = true;
        } else {
            budgetTiles = budget;          // refresh budget; keep the latch
        }
    }
    float Spent(Vec2 cur) const { return Len(Sub(cur, startPos)); }
    float Remaining(Vec2 cur) const {
        if (!valid) return 0.f;            // unknown tick => no teleport budget
        return std::max(0.f, budgetTiles - Spent(cur));
    }
};
```

Ownership: a single `TickBudget g_budget;` global next to `g_state`/`g_map`
(`UDodge.cpp:40-42`), touched only from `Tick`. Reset in `SetEnabled(false)`
and `OnEnter` (set `g_budget = TickBudget{};`). Diagnostics surfaced via new
`DebugSnapshot`/`DiagView` fields.

`kServerTickSec` (0.2) is the tick length; `tilesPerSec` comes from the same
value `Tick` already reads (`spd`/`tilesPerSec` at `UDodge.cpp:190-191`, filled
by `TestTAB::ReadDodgePlayerStats`). Use that `tilesPerSec`.

## Steps

1. **`UDodgeTypes.h`** — add the `TickBudget` struct is defined in `UDodge.cpp`
   (it uses `Vec2`/`kServerTickSec` which are in `UDodgeTypes.h`, already
   included). Here just add diagnostic fields:
   - In `DebugSnapshot` (near `reactMargin`): add
     `float budgetRemaining = 0.f;` and `float budgetTiles = 0.f;` and
     `bool budgetValid = false;`.
   - In `DiagView` (`UDodge.h`, not this file) — done in Step 4.
   Build: `bash internal/tools/wsl-build.sh Debug`.

2. **`UDodge.cpp`** — define `TickBudget` (paste the struct from Target design
   into the anonymous namespace, after `CoreState`/before the globals) and add
   `TickBudget g_budget;` next to `g_map` (~line 41). In `SetEnabled` (the
   `if (!enabled)` block ~166) and `OnEnter` (~176) add `g_budget = TickBudget{};`.
   Build.

3. **`UDodge.cpp` `Tick`** — after the tick is read and the map is synced
   (after line 211, where `tick`/`tickOk` and `px,py` are known and
   `tilesPerSec` was read at 191), add:
   `g_budget.Update(tickOk, tick, { px, py }, tilesPerSec);`.
   Then, where the debug snapshot `d` is filled (~287), add:
   ```cpp
   d.budgetTiles     = g_budget.budgetTiles;
   d.budgetRemaining = g_budget.Remaining({ px, py });
   d.budgetValid     = g_budget.valid;
   ```
   Build. (No behavior change — nothing reads the budget to move yet.)

4. **`UDodge.h` + `UDodge.cpp` `GetDiagView`** — add to `DiagView`
   (`UDodge.h:13-29`): `float budgetRemaining = 0.f; float budgetTiles = 0.f;
   bool budgetValid = false;`. In `GetDiagView` (`UDodge.cpp:354-381`) copy them
   from the `DebugSlot()` snapshot (`v.budgetRemaining = d.budgetRemaining;`
   etc.). Build.

5. Run Verification (below), commit on `refactor/unified-gameapi` (message:
   `refactor(plan52): udodge tick-pipeline formalize + per-tick move-budget tracker (Stage 2)`).
   **STOP and test in-game**: the budget readout (Test-tab overlay / diag) should
   show `budgetRemaining` decreasing as the character moves within a tick and
   resetting to ~`budgetTiles` (≈ tilesPerSec × 0.2) at each tick. Dodge
   behavior must be visually identical to Stage 1.

6. **OPTIONAL — same-tick MOVE ordering (revertible on its own).** Only do this
   after Step 5 is confirmed working, and commit it SEPARATELY so it can be
   reverted without unwinding the budget tracker. In `DangerPlanner.cpp`,
   `Detour_AppEngineUpdate` (`:805-809`), change:
   ```cpp
   void __fastcall Detour_AppEngineUpdate(void* __this, void* method)
   {
       if (s_origUpdate) s_origUpdate(__this, method);
       DodgeTickGuarded();
   }
   ```
   to:
   ```cpp
   void __fastcall Detour_AppEngineUpdate(void* __this, void* method)
   {
       // UDodge runs BEFORE the game update so its MoveTo lands in this tick's
       // outgoing MOVE. UDodge is mutually exclusive with the other engines
       // (see the if/else chain in RunDodgeTickBody), so when it is on nothing
       // else runs; when it is off, everything runs post-update exactly as
       // before — behavior for the other engines is unchanged.
       const bool uni = UDodge::IsEnabled();
       if (uni) DodgeTickGuarded();
       if (s_origUpdate) s_origUpdate(__this, method);
       if (!uni) DodgeTickGuarded();
   }
   ```
   Add `#include "features/movement/udodge/UDodge.h"` to `DangerPlanner.cpp` if
   not already present (it references `UDodge::IsEnabled` at `:731`, so it is).
   Build, commit SEPARATELY (message:
   `refactor(plan52-opt): run UDodge pre-update for same-tick MOVE landing`),
   and **test in-game**. If the dodge reacts LATE to newly-spawned bullets or
   the tick-change rebuild visibly lags (danger map one frame behind), the
   pre-update sensing regression outweighs the MOVE-timing gain: `git revert`
   this one commit and keep the post-update order. Document the outcome.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0

# The tracker is present and wired:
grep -rn "struct TickBudget" internal/src/features/movement/udodge/UDodge.cpp   # 1 hit
grep -rn "g_budget" internal/src/features/movement/udodge/UDodge.cpp            # >= 4 hits
```

Success = clean build, guardrail exit 0, budget readout behaves as described
in Step 5, and (if Step 6 applied) the dodge does not regress on new-bullet
reaction. No client changes in this plan.

## Out of scope

- Do NOT consume the budget to move or teleport (Stage 4 does that).
- Do NOT change the field escape or candidate scoring (Stage 3).
- Do NOT reorder the detour for any engine other than UDodge, and do NOT touch
  `RunDodgeTickBody`'s preamble or the other engines' dispatch.
- Do NOT add a client setting for the budget (it is a diagnostic only).
</content>
