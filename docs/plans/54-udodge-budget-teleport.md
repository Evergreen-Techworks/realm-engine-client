# 54 — UDodge Stage 4: Budget-Bounded Precise Placement (Direct-Write Teleport)

## Goal

After this plan, UDodge has a second execution mode alongside smooth `MoveTo`:
when a hit lands THIS server tick (standing clearance ≤ 0) and smooth `MoveTo`
cannot interpolate to the clear spot within the frame, UDodge writes the player
position DIRECTLY to a clear point along its chosen escape — but only by the
REMAINING per-tick move budget (sub-tile), so it can never exceed what live
Exalt's movement validation accepts. Normal play (~95% of frames) keeps using
`MoveTo` untouched. The teleport is opt-in (default OFF) and factors the
existing TestTAB Ctrl+Click write path into a shared, reusable helper.

## Dependencies

Plans 52 (per-tick budget tracker `g_budget`) and 53 (grid-flow field target
`out.fieldTarget`) MUST be merged first. Files touched:
`internal/src/features/movement/dodge/MovementRuntime.h`,
`MovementRuntime.cpp`, `UDodge.h`, `UDodge.cpp`, `UDodgeTypes.h` (diag fields),
`internal/src/features/control/FeatureCommandRegistry.cpp`,
`client/src/bridge/contract.ts`, `client/plugins/auto-dodge.ts`.

## Current state

- The teleport write primitive exists inline at
  `internal/src/gui/tabs/TestTAB.cpp:800-805` (Ctrl+Click teleport):
  ```cpp
  Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosX, tpX);
  Mem::TryWrite<float>(localPlayer, RuntimeOffsets::PosY, tpY);
  Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos, tpX);
  Mem::TryWrite<float>(localPlayer, RuntimeOffsets::KJ_Float3Pos + 4u, -tpY);
  ```
  Note the Float3 Y is written NEGATED (`-tpY`) — the game's
  `Unity.Mathematics.float3` world position uses an inverted Y relative to the
  `PosX/PosY` pair. Offsets: `RuntimeOffsets.h:106` (PosX), `:107` (PosY),
  `:115` (KJ_Float3Pos). `Mem::TryWrite` is the sanctioned write path (raw-access
  guardrail compliant). **TestTAB.cpp is owned by concurrent work and must NOT
  be edited by this plan** — the helper is created elsewhere; TestTAB keeps its
  inline copy (a known duplicate, noted below).
- The budget tracker `g_budget` (`UDodge.cpp`, plan 52) exposes
  `g_budget.Remaining({px,py})` and `g_budget.valid`.
- UDodge execution today (`UDodge.cpp:252-271`): compute `moveTarget` from
  `g_out.velocity × frameMs`, then `DodgeRuntime::CallMoveTo`. The core reports
  `g_out.standClearance` (≤ 0 ⇒ danger covers the current position →
  `Decision::EmergencyOverride`/`EmergencyManualBlend`) and, from plan 53,
  `g_out.fieldActive` + `g_out.fieldTarget` (the safe pocket).
- `Core::PointClear(const MapInput&, Vec2)` is available in `UDodge.cpp`
  (declared in `UDodgeCore.h`, already included) — the spatial "is this spot
  safe right now" test.

## DIVERGENCE / RISK you must respect (do not silently ignore)

`DangerPlanner.h:29-35,142-152` records that an earlier RAW position-write
teleport "caused server snap-backs" and was removed in favor of a native-move
speed boost, with the standing rule "USE [NativeMoveTo] for every movement
write." This plan reintroduces a raw write DELIBERATELY, but under the new
constraint that the old one lacked: the teleport delta is CLAMPED to the
remaining per-tick move budget (sub-tile). The debugging session confirmed
sub-1-tile teleports ARE accepted by live validation; the old teleport snapped
back because it moved multiple tiles ignoring the budget. The correct behavior
is: clamp to budget, sub-tile only, opt-in. If any snap-back is observed
in-game, the user disables the setting and the engine reverts to pure `MoveTo`.

## Target design

### Shared helper (factored from TestTAB's inline block)

In `MovementRuntime.h`, add:
```cpp
// Direct player-position write (the teleport primitive). Writes PosX/PosY and
// the Unity float3 (x, -y) in one SEH-guarded call. BYPASSES the game's move
// speed clamp — callers MUST bound the delta to the per-tick move budget or the
// server snaps the player back (see DangerPlanner.h). Returns true if the write
// path is resolved and did not fault.
bool WritePlayerPosition(void* player, float worldX, float worldY);
```
In `MovementRuntime.cpp` (add `#include "RuntimeOffsets.h"` and
`#include "MemRead.h"`), implement:
```cpp
bool WritePlayerPosition(void* player, float worldX, float worldY)
{
    if (!player || !std::isfinite(worldX) || !std::isfinite(worldY)) return false;
    __try {
        Mem::TryWrite<float>(player, RuntimeOffsets::PosX, worldX);
        Mem::TryWrite<float>(player, RuntimeOffsets::PosY, worldY);
        Mem::TryWrite<float>(player, RuntimeOffsets::KJ_Float3Pos, worldX);
        Mem::TryWrite<float>(player, RuntimeOffsets::KJ_Float3Pos + 4u, -worldY);
    } __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    return true;
}
```
(This is the exact TestTAB write, including the negated Float3 Y. TestTAB's
inline copy is a known duplicate left in place because TestTAB.cpp is owned by
concurrent work — record it as a divergence for a future consolidation plan, do
not touch it here.)

### Pinch execution in `UDodge::Tick`

New UDodge-local opt-in atomic `g_teleport` (default `false`). Constants
(file-local in `UDodge.cpp`):
```cpp
constexpr float kTpBudgetSafety = 0.9f;   // never spend more than 90% of remaining
constexpr float kTpMaxTiles     = 0.9f;   // hard sub-tile cap regardless of budget
constexpr float kTpMinTiles     = 0.05f;  // below this, not worth a teleport
```
After `Core::Evaluate` and after computing `frameMs`/`moveTarget`, BEFORE the
existing `CallMoveTo` block, insert the pinch check:
```cpp
bool teleported = false;
float tpDist = 0.f;
const bool pinch =
    g_teleport.load(std::memory_order_relaxed) &&
    g_map.tickValid && g_budget.valid &&
    g_out.overrideActive &&
    g_out.standClearance <= 0.f;               // a hit covers where we stand NOW
if (pinch) {
    // Clear target: the field pocket (plan 53) if routing, else the chosen
    // candidate's step endpoint.
    Vec2 target = g_out.fieldActive
        ? g_out.fieldTarget
        : Add(in.player, Mul(g_out.candidates[g_out.candidate].dir, in.stepTiles));
    const Vec2 toT = Sub(target, in.player);
    const float distToTarget = Len(toT);
    if (distToTarget > 1e-3f) {
        const Vec2 dir = Mul(toT, 1.f / distToTarget);
        const float moveStep = in.speed * frameMs;                 // MoveTo's reach this frame
        const float remaining = g_budget.Remaining(in.player);
        // Cover only the gap MoveTo can't, never more than budget, never > cap.
        const float cap = std::min(remaining * kTpBudgetSafety, kTpMaxTiles);
        tpDist = std::clamp(distToTarget - moveStep, 0.f, cap);
        if (tpDist > kTpMinTiles) {
            const Vec2 land = Add(in.player, Mul(dir, tpDist));
            if (Core::PointClear(in, land) &&
                Sensors::CanOccupy(land.x, land.y, settings.safeWalk)) {
                if (DodgeRuntime::WritePlayerPosition(player, land.x, land.y)) {
                    // Re-sync the game's move target to the landing so the
                    // rigidbody/packet state matches the raw write (no extra
                    // displacement — MoveTo to the current point moves ~0).
                    DodgeRuntime::CallMoveTo(player, land.x, land.y);
                    moveTarget = land;
                    teleported = true;
                }
            }
        }
    }
}
if (!teleported && (g_out.overrideActive || autoWalk)) {
    moveTarget = Add(in.player, Mul(g_out.velocity, frameMs));
    if (!DodgeRuntime::CallMoveTo(player, moveTarget.x, moveTarget.y))
        moveFailed = true;
}
```
(The `if (!teleported && ...)` replaces the existing `if (g_out.overrideActive
|| autoWalk)` block at `UDodge.cpp:267-271` — the teleport path and the MoveTo
path are mutually exclusive per frame, which bounds this frame's displacement to
`tpDist ≤ remaining × 0.9 < budget`.)

Budget-invariant proof to preserve in a comment: `tpDist ≤ Remaining × 0.9`, and
`Remaining = budget − |player − startPos|`, so after the write
`|land − startPos| ≤ |player − startPos| + tpDist ≤ budget`. Because the
teleport frame does NOT also issue a far MoveTo, no additional displacement is
added that frame. Subsequent frames recompute `Remaining` from the new actual
position, so the bound is self-correcting.

### Diagnostics

Add `bool teleported = false;` and `float tpDist = 0.f;` to `DebugSnapshot`
(`UDodgeTypes.h`) and set them in the debug fill (~`UDodge.cpp:287`). Optionally
add `bool teleported` to `DiagView`. This lets the overlay show when/how far the
pinch teleport fired.

Thread-safety: all of this is game-update thread only (same as the rest of
`Tick`). `g_teleport` is a relaxed atomic read once per frame.

## Steps

1. **`MovementRuntime.h` + `MovementRuntime.cpp`** — add `WritePlayerPosition`
   as specified (include `RuntimeOffsets.h`, `MemRead.h`). Build:
   `bash internal/tools/wsl-build.sh Debug`; then
   `bash internal/tools/check-raw-access.sh` (must stay exit 0 —
   `Mem::TryWrite`+`RuntimeOffsets` is the sanctioned path).

2. **`UDodge.cpp`** — add `std::atomic<bool> g_teleport{ false };` (~line 33),
   `SetTeleport`/`GetTeleport` accessors (~line 396 area), reset is not required
   (a bool knob). **`UDodge.h`** — declare `void SetTeleport(bool en); bool
   GetTeleport();`. Build.

3. **`UDodgeTypes.h`** — add `bool teleported = false; float tpDist = 0.f;` to
   `DebugSnapshot`. Build.

4. **`UDodge.cpp` `Tick`** — insert the pinch block from Target design,
   replacing the existing override/autoWalk `CallMoveTo` block
   (`:267-271`). Fill `d.teleported`/`d.tpDist` in the debug snapshot. Ensure
   `Sensors::CanOccupy` and `Core::PointClear` are reachable (headers already
   included). Build.

5. **`UDodge.cpp` `RenderSettings`** — add a checkbox near the field-escape one:
   ```cpp
   bool tp = GetTeleport();
   if (ImGui::Checkbox("Pinch teleport (budget-bounded, sub-tile)##udodge", &tp)) SetTeleport(tp);
   if (ImGui::IsItemHovered())
       ImGui::SetTooltip("When a hit lands THIS tick and smooth movement can't\n"
                         "reach the clear spot in time, snap the remaining sub-tile\n"
                         "gap directly. Clamped to the per-tick move budget so the\n"
                         "server accepts it. Off = pure MoveTo. Disable if you see\n"
                         "any rubber-banding.");
   ```
   Build.

6. **`FeatureCommandRegistry.cpp`** — in `ApplyUDodgeFeature` add
   `FH_INT_BOOL("udodgeTeleport", UDodge::SetTeleport),`. Build.

7. **Client** — `client/src/bridge/contract.ts`: add `'udodgeTeleport'` to the
   alphabetical allow-list (sorts after `'udodgeStepTiles'`, before
   `'xdodgeArbiter'`). `client/plugins/auto-dodge.ts`: add a unified-mode
   toggle after `udodgeFieldEscape`:
   ```ts
   registerModeSetting('unified', 'udodgeTeleport',
     onOff('[UDodge] Pinch teleport (budget-bounded sub-tile snap when a hit lands this tick)', 'off'),
     (v: string) => sendDllFeature('udodgeTeleport', v === 'on' ? 1 : 0));
   ```
   and add `'udodgeTeleport'` to the boolean re-apply loop array (~line 486-488).
   Verify: `cd client && npm run build`.

8. Run full Verification, commit on `refactor/unified-gameapi` (message:
   `refactor(plan54): udodge budget-bounded pinch teleport (Stage 4)`), do NOT
   stage `client/build-tools/dev-build.bat`. **Test in-game with the toggle OFF
   first** (confirm zero behavior change), then ON: in a tight pinch the
   character should snap the last sub-tile to safety with NO rubber-band. If any
   snap-back occurs, turn the toggle off and report — the budget clamp needs
   tightening (lower `kTpBudgetSafety`/`kTpMaxTiles`).

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0 (Mem::TryWrite is sanctioned)
cd client && npm run build                    # tsc clean

# Shared helper exists and UDodge uses it (not a duplicated raw write):
grep -n "WritePlayerPosition" internal/src/features/movement/dodge/MovementRuntime.h internal/src/features/movement/dodge/MovementRuntime.cpp internal/src/features/movement/udodge/UDodge.cpp
# UDodge must NOT contain its own raw PosX/Float3 writes — MUST return NOTHING:
grep -rn "RuntimeOffsets::PosX\|KJ_Float3Pos" internal/src/features/movement/udodge/
# New key wired end to end:
grep -n "udodgeTeleport" internal/src/features/control/FeatureCommandRegistry.cpp client/src/bridge/contract.ts client/plugins/auto-dodge.ts
```

Success = clean builds, guardrail exit 0, the udodge/ raw-write grep empty
(the write lives only in the shared helper), the helper referenced from both
the helper files and `UDodge.cpp`, and the in-game behavior above (no snap-back).

## Out of scope

- Do NOT edit `internal/src/gui/tabs/TestTAB.cpp` to adopt the helper (owned by
  concurrent work). Its inline write stays a known duplicate — record it for a
  future consolidation plan, do not migrate it here.
- Do NOT teleport when `!g_map.tickValid` or `!g_budget.valid` (no budget
  guarantee → no raw write).
- Do NOT raise `kTpMaxTiles` above sub-tile or remove the budget clamp.
- Do NOT teleport outside the emergency (standClearance ≤ 0) case — normal and
  gentle overrides stay pure `MoveTo`.
- Do NOT touch legacy engine settings or the uncommitted `dev-build.bat`.
</content>
