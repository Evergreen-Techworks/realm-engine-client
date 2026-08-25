# 61 — Stage D2: Boss-Fight Goal Policy, Override Precedence, Settings + Client

## Goal
After this plan, UDodge Autopilot is a usable boss-fighting brain: it keeps weapon
range with a stable orbit (range bands + orbit-direction hysteresis, no jitter),
retreats when too close and closes when too far, holds the boss lock stickily, and
routes there via the plan-60 whole-window path — while the dodge always pre-empts
the path when a bullet threatens. New settings (planner window radius, orbit-range
mode, path-draw toggle) are exposed through the DLL command table, the client
contract, and the auto-dodge plugin.

## Dependencies
Plan 60 merged (whole-window route + path overlay). Touches
`internal/src/features/movement/udodge/UDodgePlanner.{h,cpp}`, `UDodge.{h,cpp}`,
`UDodgeDebug.cpp`, `internal/src/features/control/FeatureCommandRegistry.cpp`,
`client/src/bridge/contract.ts`, `client/plugins/auto-dodge.ts`. This is the last
behavior plan; only plan 62 (cleanup) follows.

## Current state (after 60)

- Goal = boss `lockPos` at `weaponRange × 0.85`, orbit direction is the fixed
  tangential `{-dir.y, dir.x}` (ported orbit helper from plan 58). No range bands,
  no orbit-direction hysteresis → the orbit heading can flip frame-to-frame near
  the band edge, and there is no explicit "retreat when too close".
- Lock selection: biggest-maxHp sticky enemy in `BuildMap`
  (`UDodgeSensors.cpp:279-286`) → `map.hasLock/lockPos`. Fine; keep it.
- Existing UDodge settings keys and their three wiring points:
  DLL table `FeatureCommandRegistry.cpp:238-254` (`ApplyUDodgeFeature`);
  contract allow-list `client/src/bridge/contract.ts:75-78`;
  plugin registration `client/plugins/auto-dodge.ts:279-324` and the push loop
  `:484-493`.

## Target design

### 1. Boss-fight goal policy (worker / `Planner::Compute` + snapshot scalars)
Compute the ORBIT GOAL POSITION with range bands and a persistent orbit sign:
- Range bands off `desired = orbitRange` (from settings, default = resolved weapon
  range × 0.85): `dist > desired + band` → goal biased toward closing (a point on
  the boss→player line at `desired`); `dist < desired − band` → goal biased toward
  retreating (point on the same line at `desired`, i.e. move outward);
  in-band → goal is the tangential orbit point at `desired` along the current
  orbit sign.
- **Orbit-direction hysteresis:** carry an orbit sign (+1/−1) in a worker-local
  static (worker thread only — no cross-thread state) that flips only when blocked
  (the tangential goal cell is walled/heavily-danger-costed) or when the player has
  clearly reversed; otherwise hold it. This kills the frame-to-frame flip.
- The resulting goal world pos is fed to the plan-60 Dijkstra as the goal cell, so
  range-keeping ROUTES around danger instead of walking straight.
- Add `float orbitRange` and `int planRadius` to `Settings`/`PlannerSnapshot` so
  the game thread passes the live slider values in.

### 2. Explicit dodge-override precedence (verify + document, minimal code)
This is already structurally guaranteed: the worker route only sets
`in.intentDir`, and `Core::Evaluate` treats intent as overridable
(`UDodgeCore.cpp:554-560` preserves a safe intent; `:563-601` overrides in
emergency/gentle). Add a one-line comment at the `Tick` intent-assignment site
documenting that the plan is an OVERRIDABLE goal, and confirm in testing that a
threatening bullet breaks the orbit. No behavioral code change needed here.

### 3. New settings (three, all optional / safe defaults)
- `udodgeDrawPath` (bool, default on) — toggles the plan-60 path overlay
  (`UDodge::SetDrawPath` gating the `DebugSnapshot` path copy / `Debug::Render`
  polyline).
- `udodgeOrbitRange` (float tiles, default 0 = auto from weapon range) —
  `UDodge::SetOrbitRange`; 0 means "use resolved weapon range × 0.85".
- `udodgePlanRadius` (float tiles, default 20, clamp [8,40]) — maps to
  `kPlanGridRadius` usage; lets the user shrink the window if the grid rasterize
  cost (plan-60 hot-path note) stutters. `UDodge::SetPlanRadius`.

Wire each through: `UDodge.{h,cpp}` atomic + Set/Get (mirror the existing pattern
`UDodge.cpp:409-432`); `ApplyUDodgeFeature` table (`FeatureCommandRegistry.cpp:239-253`,
`FH_INT_BOOL`/`FH_FLOAT`); contract allow-list (`contract.ts:75-78`, keep
alphabetical); plugin `registerModeSetting('unified', ...)` + the push loop
(`auto-dodge.ts:279-324`, `:484-493`).

## Steps

1. **Range bands + orbit hysteresis** in `Planner::Compute` (worker-local orbit
   sign static; goal position from the band logic). Add `orbitRange`/`planRadius`
   to `Settings`+`PlannerSnapshot`; pass live values from `Tick`. Build:
   `bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh`

2. **Wire `udodgeOrbitRange` + `udodgePlanRadius`** (DLL setters + command table +
   snapshot plumbing; `planRadius` clamps the grid fill loop in `Tick`). Build +
   guardrail.

3. **Wire `udodgeDrawPath`** (setter + gate the path copy in `Tick` and the
   polyline in `UDodgeDebug.cpp`). Build + guardrail.

4. **Client wiring**: add the three keys to `contract.ts:75-78` (alphabetical);
   register them in `auto-dodge.ts` (`:279-324`) and push them in the sync loop
   (`:484-493`). Build the client:
   `cd client && npm run build`

5. **Add the override-precedence comment** at the `Tick` intent-assignment site.
   Build + guardrail.

6. **In-game verify** (see Verification). Keep diagnostics for now.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug          # 0 errors
bash internal/tools/check-raw-access.sh         # exit 0
cd client && npm run build                       # tsc clean
```

In-game (Autopilot, boss fight):
- The player keeps weapon range: closes when far, backs off when too close, orbits
  in-band WITHOUT the heading flipping every frame.
- The planned path routes around danger to the orbit goal; the dodge breaks orbit
  to avoid bullets and resumes.
- The three new sliders/toggles take effect live: path draw on/off, orbit range
  changes the standoff distance, plan radius changes the path window (and relieves
  any stutter).
- `grep -n "udodgeDrawPath\|udodgeOrbitRange\|udodgePlanRadius" client/src/bridge/contract.ts`
  shows all three present.

## Out of scope
- Do NOT add a raw position-write teleport (the deferred plan-54 idea stays
  deferred; `MoveTo` only).
- Do NOT modify `repp/`/`pjdodge/`/`zdodge/` or the cleanup-wave files.
- Do NOT remove the `DBG_FILE_LOG` diagnostics yet (plan 62).
