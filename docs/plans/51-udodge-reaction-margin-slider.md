# 51 — UDodge Stage 1: Live Reaction-Margin Slider

## Goal

After this plan, the UDodge reaction margin (the spatial clearance the dodge
keeps between the player and a bullet — currently the hard-coded constant
`kIntentSafeClearance`) is a LIVE, runtime-tunable value driven by a client
slider `[UDodge] Reaction margin (tiles)`, threaded through `MapInput.settings`
into every core use site, so the user can widen or tighten the "wide reaction
space" that substitutes for the deleted time dimension without rebuilding the
DLL. The already-edited widened constants (`kRelevanceClearance` 2.0,
`kIntentSafeClearance` 0.60, `kEmergencyIntentBand` 0.30) are preserved; 0.60
becomes the slider's default.

This is a behavior-preserving-at-default change: with the slider at 0.60 the
engine behaves exactly as the current widened constants already do.

## Dependencies

None beyond the merged 44-49 workstream. Parallel-safe with nothing — it is
Stage 1 and every later plan depends on it.

Files this plan touches (later plans also touch the first four — this plan must
merge before them): `UDodgeTypes.h`, `UDodge.h`, `UDodge.cpp`, `UDodgeCore.cpp`,
`UDodgeDebug.cpp`, `internal/src/features/control/FeatureCommandRegistry.cpp`,
`client/src/bridge/contract.ts`, `client/plugins/auto-dodge.ts`.

## Current state

`kIntentSafeClearance` is a `constexpr float` (value 0.60 after the uncommitted
widening edit) at `internal/src/features/movement/udodge/UDodgeTypes.h:32`. It
is read at these EXACT sites (all must be routed through the runtime value):

- `internal/src/features/movement/udodge/UDodgeCore.cpp:299` — inside
  `IsVelocitySafeMap` (has `const MapCtx& c`):
  `if (LaneDistCheb(L, probes[i]) - half < kIntentSafeClearance) return false;`
- `UDodgeCore.cpp:304` — `IsVelocitySafeMap`, active-zone check:
  `DistPointSeg(z.pos, probes[0], probes[n - 1]) - z.radius < kIntentSafeClearance`
- `UDodgeCore.cpp:511` — inside `Evaluate` (has `const MapInput& in`), field
  boxed-in test: `c.clearance[cand] >= kIntentSafeClearance`
- `UDodgeCore.cpp:553` — `Evaluate`, intent-preservation ladder:
  `c.clearance[kIntentCandidate] >= kIntentSafeClearance &&`
- `UDodgeCore.cpp:571` — `Evaluate`, gentle "fully-safe candidates" loop:
  `if (!c.valid[cand] || c.clearance[cand] < kIntentSafeClearance) continue;`
- `UDodgeCore.cpp:576` — `Evaluate`, emergency achievable:
  `} else if (hasIntent && c.clearance[proposed] >= kIntentSafeClearance) {`
- `UDodgeCore.cpp:580` — `Evaluate`, acceptable floor:
  `std::max(kIntentSafeClearance, c.clearance[proposed] - kEmergencyIntentBand);`
- `UDodgeCore.cpp:605` — `Evaluate`, hysteresis:
  `c.valid[held] && c.clearance[held] >= kIntentSafeClearance &&`
- `UDodgeCore.cpp:617` — `Evaluate`, speed-scale gate:
  `c.clearance[choice] >= kIntentSafeClearance)`
- `UDodgeDebug.cpp:130` — render-thread overlay coloring:
  `else if (c.clearance >= kIntentSafeClearance)` (cosmetic threshold).

`kRelevanceClearance` (`UDodgeCore.cpp:427,431,433,442,489,496`),
`kEmergencyIntentBand` (`:580`) and `kUnavoidableClearanceBand` (`:591`) stay as
constants — the slider controls ONLY `kIntentSafeClearance` (the reaction
margin). Leave those other constants untouched.

The `Settings` struct is at `UDodgeTypes.h:78-91`. Atomic knobs + `ReadSettings`
+ Set/Get accessors follow the existing pattern in `UDodge.cpp:26-37,65-81,
383-404`. The DLL command table is `ApplyUDodgeFeature` at
`FeatureCommandRegistry.cpp:238-254`. The existing `c.hitScale` assignment in
`Evaluate` is `UDodgeCore.cpp:382`:
`c.hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);`.

## Target design

Add a `reactMargin` field to `Settings`, thread it through `MapInput.settings`
into a `MapCtx.reactMargin` (game-update thread) and into `DebugSnapshot`
(render thread), and replace every `kIntentSafeClearance` read above with the
runtime value. Clamp `[0.05, 2.0]`; default 0.60 (== the current constant).

- `Settings` (in `UDodgeTypes.h`): add `float reactMargin = 0.60f;`.
- Keep `constexpr float kIntentSafeClearance = 0.60f;` — it becomes the DEFAULT
  reference (used to initialize the atomic and as the field-default). Nothing
  reads it in the core after this plan; the guardrail grep in Verification
  proves that.
- `MapCtx` (anonymous namespace struct in `UDodgeCore.cpp:32-49`): add
  `float reactMargin = 0.60f;`, set from `std::clamp(in.settings.reactMargin,
  0.05f, 2.0f)` at the top of `Evaluate` next to `c.hitScale`.
- `DebugSnapshot` (`UDodgeTypes.h:214-237`): add `float reactMargin = 0.60f;`
  so `UDodgeDebug.cpp:130` uses the live value instead of the constant.
- Atomic `std::atomic<float> g_reactMargin{ 0.60f };` in `UDodge.cpp`, clamp
  `[0.05, 2.0]`, plumbed into `ReadSettings`; `SetReactMargin`/`GetReactMargin`
  accessors; a slider in `RenderSettings`; declarations in `UDodge.h`.
- Command key `udodgeReactMargin` (`FH_FLOAT`) in `ApplyUDodgeFeature`.
- Client slider `udodgeReactMargin` in `auto-dodge.ts` (unified mode) + the
  key added to the `contract.ts` allow-list + the re-apply block.

Thread-safety: `g_reactMargin` is a relaxed atomic read once per frame in
`ReadSettings` (same pattern as every other UDodge knob). No new sharing.

## Steps

1. **`UDodgeTypes.h`** — in `Settings` (after `stepTiles`, ~line 90) add:
   `float reactMargin = 0.60f;  // reaction clearance floor (tiles) [0.05, 2.0]`.
   In `DebugSnapshot` (near `stepTiles`, ~line 228) add:
   `float reactMargin = 0.60f;`.
   Build: `bash internal/tools/wsl-build.sh Debug`.

2. **`UDodge.cpp`** — add the atomic and accessors, mirroring `g_hitScale`:
   - Near line 29 add: `std::atomic<float> g_reactMargin{ 0.60f };`.
   - In `ReadSettings` (after the `hitScale` line ~71) add:
     `s.reactMargin = Clamp(g_reactMargin.load(std::memory_order_relaxed), 0.05f, 2.0f);`.
   - Near the other Set/Get definitions (~388) add:
     `void  SetReactMargin(float m) { g_reactMargin.store(Clamp(m, 0.05f, 2.0f), std::memory_order_relaxed); }`
     `float GetReactMargin() { return g_reactMargin.load(std::memory_order_relaxed); }`.
   - In `Tick`, where the debug snapshot `d` is filled (~line 287, next to
     `d.stepTiles = in.stepTiles;`) add: `d.reactMargin = settings.reactMargin;`.
   Build.

3. **`UDodge.cpp` `RenderSettings`** — after the Hit-scale slider
   (~line 321) add:
   ```cpp
   float react = GetReactMargin();
   if (ImGui::SliderFloat("Reaction margin (tiles)##udodge", &react, 0.05f, 2.0f)) SetReactMargin(react);
   if (ImGui::IsItemHovered())
       ImGui::SetTooltip("Spatial clearance the dodge keeps from bullets. This is\n"
                         "the wide reaction space that replaces the deleted time\n"
                         "dimension: higher = start dodging sooner and keep more\n"
                         "buffer (smoother); lower = brush closer.");
   ```
   Build.

4. **`UDodge.h`** — declare the accessors next to `SetHitScale`/`GetHitScale`
   (~line 43): `void  SetReactMargin(float m);        float GetReactMargin();`.
   Build.

5. **`UDodgeCore.cpp`** — thread the runtime margin:
   - In `MapCtx` (~line 37, next to `float hitScale`) add:
     `float reactMargin = 0.60f;`.
   - In `Evaluate`, right after the existing `c.hitScale = std::clamp(
     in.settings.hitScale, 0.25f, 2.5f);` line (`:382`) add:
     `c.reactMargin = std::clamp(in.settings.reactMargin, 0.05f, 2.0f);`.
   - Replace `kIntentSafeClearance` with `c.reactMargin` at lines 299, 304
     (inside `IsVelocitySafeMap`, which has `const MapCtx& c`), and at lines
     511, 553, 571, 576, 580, 605, 617 (inside `Evaluate`, which has the local
     `c`). Mechanical: `kIntentSafeClearance` → `c.reactMargin` at each of those
     nine sites. Leave `kEmergencyIntentBand`, `kUnavoidableClearanceBand`,
     `kRelevanceClearance` unchanged.
   Build.

6. **`UDodgeDebug.cpp`** — at line 130 replace `kIntentSafeClearance` with
   `snap.reactMargin` (the `Render` function receives `const DebugSnapshot&
   snap`; confirm the parameter name and use it). Build.

7. **`FeatureCommandRegistry.cpp`** — in `ApplyUDodgeFeature` (the table at
   `:240-252`) add, after the `udodgeHitScale` line:
   `FH_FLOAT("udodgeReactMargin", UDodge::SetReactMargin),`. Build.

8. **`client/src/bridge/contract.ts`** — insert `'udodgeReactMargin'` into the
   alphabetically-ordered allow-list (`:75-78`); it sorts after `'udodgeMode'`
   and before `'udodgeSafeWalk'`.
   **`client/plugins/auto-dodge.ts`** — after the `udodgeHitScale`
   registration (~line 291) add:
   ```ts
   registerModeSetting('unified', 'udodgeReactMargin', {
     label: '[UDodge] Reaction margin (tiles — wider = dodge sooner/smoother)',
     type: 'range', value: 0.6, min: 0.05, max: 2.0, step: 0.05,
   }, (v: number) => sendDllFeature('udodgeReactMargin', v));
   ```
   In the re-apply block (~line 483, next to
   `sendDllFeature('udodgeHitScale', ...)`) add:
   `sendDllFeature('udodgeReactMargin', ctx.getSetting<number>('udodgeReactMargin'));`.
   Verify: `cd client && npm run build`.

9. Run the full Verification below, then commit on `refactor/unified-gameapi`
   (message: `refactor(plan51): udodge live reaction-margin slider (Stage 1)`).
   Do NOT stage `client/build-tools/dev-build.bat`.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors
bash internal/tools/check-raw-access.sh       # exit 0
cd client && npm run build                    # tsc clean

# The core must no longer read the constant (render-thread cosmetic use is
# also migrated to snap.reactMargin) — MUST return NOTHING:
grep -rn "kIntentSafeClearance" internal/src/features/movement/udodge/UDodgeCore.cpp internal/src/features/movement/udodge/UDodgeDebug.cpp

# The new key must be wired in all three tiers — each MUST return a hit:
grep -rn "udodgeReactMargin" internal/src/features/control/FeatureCommandRegistry.cpp
grep -rn "udodgeReactMargin" client/src/bridge/contract.ts client/plugins/auto-dodge.ts
```

Success = clean builds, guardrail exit 0, the first grep empty, the last two
non-empty. In-game: moving the "Reaction margin" slider visibly widens/narrows
the standoff distance at which the dodge engages; at 0.60 behavior matches the
pre-slider build.

## Out of scope

- Do NOT expose `kRelevanceClearance`, `kEmergencyIntentBand`, or
  `kUnavoidableClearanceBand` as sliders (they stay as the widened constants;
  revisit only if Stage-1 testing shows they need it — that would be its own
  plan).
- Do NOT touch the tick pipeline, field escape, or any teleport/position write
  (Stages 2-4).
- Do NOT touch `pjdodge*`/`repp*`/`zdodge*` settings or the uncommitted
  `dev-build.bat`.
</content>
