# 30 — Unified Dodge ("UDodge") Overview

This is the overview/index for the unified auto-dodge workstream (plans 31-35).
It is not itself executable — it records the comparative analysis of the two
dodge implementations being merged, the merge decisions and why, the plan
dependency graph, and the global verification commands. Implementer agents
execute plans 31-35; each of those is self-contained, but this file is the
rationale of record.

## Why this workstream exists

The internal DLL has accumulated **five** auto-dodge engines behind one
selector (`TestTAB::DodgeMode`, `internal/src/gui/tabs/TestTAB.h:10-18`):
XDodge, RolloutDodge (grid/quadtree), ZDodge, RePP, PJDodge. The two most
recent — RePP (`internal/src/features/movement/repp/`) and PJDodge
(`internal/src/features/movement/pjdodge/`) — each work poorly alone but are
strong in complementary halves. This workstream builds ONE new engine,
**UDodge** (`internal/src/features/movement/udodge/`, DodgeMode 7), that takes
the best half of each, then (after in-game validation by the user) retires
RePP and PJDodge.

## Comparative analysis

### Shared substrate (both engines already use it; UDodge keeps it)
- `ProjectileTracking` (`dodge/ProjectileTracking.h`) — projectile ring buffer
  fed by the SpawnProjectile hook; `CopyActiveForDraw`, `ComputePosAt`
  (game-parity `positionAt`), per-shot clock calibration (`elapsedCalMs`,
  `PredictionDiag`), live Chebyshev hit half (`runtimeChebyshevHalf`).
- `AoeTracking` (`dodge/AoeTracking.h`) — telegraph/throwable landing zones.
- `EnemyTracker` (`features/combat/enemytracker/`) — self-refreshing enemy
  snapshot (pos, hp, maxHp, hasHealthBar).
- `DodgeRuntime` (`dodge/MovementRuntime.cpp`) — the ONLY sanctioned movement
  write (`CallMoveTo` → native `FKALGHJIADI::DGLCONCOIBO`, virtual-dispatch
  aware, plan-27-compliant `Il2CppHook::ResolveMethodCached`), plus
  `GetTilesPerSec` (server-authoritative SPD curve × live CalcMoveSpeed).
- `SteerInput` (`dodge/SteerInput.cpp`) — raw WASD reads (deliberately not the
  game's `Player_Moving`, which feedback-loops with planner-driven movement).
- `DangerPlanner` (`dodge/DangerPlanner.cpp:724-782`) — owns the
  `AppEngineManager::Update` detour that dispatches whichever engine is
  enabled, the BootGate degraded-offsets gate, `ResolveEnemyLock` and the
  shared external goal (`GetExternalGoal`).
- Walls/hazards: `TestTAB::IsWalkPositionBlocked`, `WorldTAB::IsTileDamagingLive`,
  `WorldTAB::GetTileSpeed`.

### RePP — what it does well / where it falls short
Files: `repp/RePP.cpp` (348), `ReppSensors.cpp` (319), `ReppPlanner.cpp`
(412), `ReppField.cpp` (125), `ReppCommit.cpp` (53), `ReppDebug.cpp` (129),
`ReppTypes.h` (167).

Strong (these pieces win the merge):
- **Field escape** (`ReppField.cpp:38-122`): allocation-free Dijkstra over a
  21×21 half-tile grid that routes AROUND walls to the nearest cell that is
  safe to stand on for a hold window, with hazard-cost penalties and a strict
  no-corner-cutting rule for diagonals (`ReppField.cpp:85-92`). This is the
  cure for "boxed in a confined room" — nothing in PJDodge can route around a
  wall to a pocket.
- **Hazard-ground semantics** (`ReppPlanner.cpp:162-181`, `238-248`,
  `340-346`, `352-357`): never STOP on damaging ground; transit over hazard is
  tolerated while escaping a hazard you stand on; when standing on a hazard
  the search radius extends past the assist cap so a fully-flooded room still
  steers toward the edge; the least-bad fallback strongly prefers off-hazard
  endpoints.
- **Autopilot goal layer** (`RePP.cpp:96-154`): boss lock chosen in the
  sensor's enemy pass (highest maxHp, sticky, not range-culled —
  `ReppSensors.cpp:217-238`), weapon-range orbit via
  `AutoAim::GetProjRangeTiles` (`RePP.cpp:96-107`), and the opt-in stand-on
  object scan (Moonlight Village lantern) over `WorldTAB::GetEntities`.
- Escaping-enemy semantics (`ReppPlanner.cpp:156-160`): a move that strictly
  reduces overlap with a body you are inside is allowed even though the
  endpoint still overlaps.

Weak (these pieces lose):
- **Collision timing is coarse**: threats are polylines checked point/segment
  vs a ±15 ms window (`ReppPlanner.cpp:70-119`); the path sweep is only 6
  lerp steps (`kSweepSteps`, `ReppPlanner.cpp:25`); there is no closed-form
  relative-motion CCD, no command-latency lead, and no per-shot clock
  calibration — dodges are mistimed against fast/curved shots.
- **Wrong hitbox**: projectile radius comes from `projHalfSize` with a 0.10
  tile fallback (`ReppSensors.cpp:49-54`, `203`), not the game's actual IsHit
  Chebyshev threshold. PJDodge reads `runtimeChebyshevHalf` (default 0.5)
  (`pjdodge/PJDodgeSensors.cpp:275-277`). RePP under-estimates hitboxes ~5×
  in the fallback case.
- **AoE model over-blocks**: an AoE is treated as dangerous over its entire
  remaining lifetime (`ReppSensors.cpp:151-188`), so RePP flees telegraphs it
  could safely stand in until just before landing.
- Per-tick hazard memo is a `std::unordered_map` (`ReppSensors.cpp:27`) —
  allocates; PJDodge's fixed open-addressing table
  (`PJDodgeSensors.cpp:26-70`) does not.

### PJDodge — what it does well / where it falls short
Files: `pjdodge/PJDodge.cpp` (300), `PJDodgeCore.cpp` (736),
`PJDodgeSensors.cpp` (332), `PJDodgeDebug.cpp` (152), `PJDodgeTypes.h` (203).

Strong (these pieces win the merge):
- **Exact CCD scoring** (`PJDodgeCore.cpp:187-241`, closed-form
  `MinChebOnSegment` in `PJDodgeTypes.h:54-68`): player-vs-projectile
  relative motion is piecewise linear, so minimum Chebyshev distance has a
  closed form — game-parity collision against the real
  `runtimeChebyshevHalf` hit threshold.
- **Prediction accuracy** (`PJDodgeSensors.cpp:159-197`, `249-261`):
  calibrated per-shot clock (`elapsedCalMs`), fresh dense resample of the
  game's own `positionAt` for curved shots, cached-path fallback.
- **Command-latency lead** (`leadMs`, `PJDodgeCore.cpp:71-74`): plans for
  where the player will be when the command lands.
- **Intent-preservation ladder + decisions** (`PJDodgeCore.cpp:662-733`):
  PreserveSafeIntent → GentleOverride/Blend → EmergencyOverride/Blend →
  UnavoidableManualBlend; speed matching for gentle overrides
  (`SelectAlignedSpeed`); hysteresis with a score-gain threshold
  (`PJDodgeCore.cpp:713-725`) — supersedes RePP's cruder commit-dwell
  (`RePP.cpp:38-43`, `158-178`).
- **Survival-lexicographic selection with corridor safety**
  (`PJDodgeCore.cpp:419-471`): impact time > corridor width > clearance >
  enemy clearance > intent alignment; the corridor term avoids threading into
  one-heading-wide gaps.
- **AoE-as-landing-event model** (`PJDodgeSensors.cpp:284-308`): danger is at
  the detonation instant; flight time is harmless (game-accurate).
- **Hazard-escape mode** (`SelectHazardEscape`, `PJDodgeCore.cpp:151-185`):
  leave damaging ground fastest-exit-first with survival tiebreaks.
- **Relevance gating** (`ClassifyProjectile`, `PJDodgeCore.cpp:86-128`):
  cheap early-out when nothing can matter this frame.

Weak (these pieces lose / get replaced):
- **Pure straight-ray world model**: all 34 candidates are constant-velocity
  rays (`PJDodgeCore.cpp:568-575`); walls only truncate rays
  (`ValidateCandidatePaths`, `PJDodgeCore.cpp:130-149`). Its layer-2 escape
  search (`PJDodgeCore.cpp:272-417`) re-decides headings mid-flight but still
  cannot discover a safe pocket behind a wall → cornered deaths in tight
  rooms. Replaced/augmented by RePP's field escape.
- **No goal layer**: no orbit, no boss lock, no stand-on; lock-follow just
  substitutes the external goal as intent (`PJDodge.cpp:133-141`). RePP's
  autopilot layer is grafted on top.
- Enemy bodies are score-only, never a veto (`PJDodgeCore.cpp:58-66`,
  `140-142`) — deliberate ("the only safe lane may run past an enemy") and
  KEPT in the merge, but documented as a decision (see Divergences).

### Other engines — reuse notes
- **XDodge** (`dodge/XDodge.cpp`, 2137 lines + `DODGE_OVERHAUL_PLAN.md`): the
  A*+BFS spacetime-grid program. Its plan doc's key insights are already
  embodied in the merge: arrival-time danger sampling (≈ PJDodge's CCD),
  CCD-exact commit (P6), walkability caching, hysteresis-on-mode (P3). Its
  grid machinery is NOT reused — the CCD candidate model plus the Dijkstra
  field is simpler and cheaper. XDodge stays untouched (it is the dashboard's
  current default mode) until the retirement decision.
- **GhostHit** (`features/combat/ghostHit/`): independent safety net, runs
  after whatever dodge engine ticks (`DangerPlanner.cpp:778-780`). Untouched.
- **ZDodge** (`zdodge/`): RePP is its direct successor (RePP's own comments
  say so, `repp/ReppTypes.h:54-55`); nothing unique left to salvage.
  Candidate for retirement in plan 35.
- **RolloutDodge/ThreatIndex/QuadtreeThreatIndex**: forward input simulation
  with broad-phase; superseded by the relevance pass + capped snapshot sizes.
  Untouched here; retirement candidate later (NOT in plan 35 — the dashboard
  still exposes it).

## The merged design (what UDodge is)

One sentence: **PJDodge's sensing/scoring/steering brain with RePP's
terrain-aware escape and goal layer bolted where PJDodge was blind.**

- **Sensors**: PJDodge pipeline (calibrated clock, dense curved resample,
  `runtimeChebyshevHalf`, landing-event AoEs, fixed-size hazard memo) + the
  RePP boss-lock computed in the same enemy pass + a new "lingering zone"
  extension: an AoE whose landing has passed but whose lifetime remains is
  kept as an always-active disc (covers persistent burn zones that RePP's
  whole-lifetime model caught and PJDodge's landing-only model dropped).
- **Core**: PJDodge's Evaluate verbatim in structure (relevance pass → path
  validation → exact CCD scoring → escape-search refinement → hazard escape →
  survival-lexicographic selection → intent ladder → hysteresis → speed
  match), extended with a **35th candidate**: the first step of a RePP-style
  Dijkstra **field escape**, computed only when no straight candidate
  survives the horizon (or hazard escape can't find an exit). The field
  candidate is swept by the same CCD as every other candidate, so it only
  wins when it genuinely survives longest. When the player is idle, the field
  direction also substitutes as intent so the ladder walks toward the pocket.
- **Goal layer** (in the feature shell, not the core): effective intent =
  WASD (always wins) → Autopilot goal (boss orbit at weapon range /
  stand-on object, RePP logic) → lock-follow external goal
  (`DangerPlanner::GetExternalGoal`) → none. Auto-walk of a safe intent uses
  PJDodge's wall-probe lockWalk pattern generalized to autopilot.
- **Steering**: PJDodge's velocity output → `moveTarget = player +
  velocity × frameMs` → `DodgeRuntime::CallMoveTo`. RePP's `Commit::Refine`
  and commit-dwell are subsumed (candidates are already horizon-CCD-validated;
  hysteresis already prevents flip-flop) and are NOT ported.
- **Registration**: `TestTAB::DodgeMode::UDodge = 7`, dispatched first in
  `DangerPlanner`; IPC keys `udodge*` via a new `ApplyUDodgeFeature` table;
  client plugin option `unified`.
- **Old engines**: stay untouched and selectable until the user validates
  UDodge in-game; plan 35 (explicitly gated on user sign-off) then retires
  RePP + PJDodge + ZDodge.

## Divergences resolved (behavior decisions of record)

1. **Projectile hit half**: game IsHit threshold `runtimeChebyshevHalf` →
   `projHalfSize` → 0.5 (PJDodge, `PJDodgeSensors.cpp:275-277`) WINS over
   RePP's `projHalfSize` → 0.10 (`ReppSensors.cpp:49-54`). Rationale: parity
   with the game's actual collision test.
2. **AoE danger window**: landing-instant (PJDodge) WINS over
   whole-lifetime (RePP), with the new lingering-zone extension so
   already-landed persistent zones are not lost.
3. **Enemy bodies**: scored, never a hard veto (PJDodge) WINS over RePP's
   no-go pad + escape rule. Rationale: a veto can eliminate the only
   surviving lane; enemy clearance stays a lexicographic tiebreak. If contact
   damage proves to be a problem in validation, revisit with an
   endpoint-dwell-only veto.
4. **Anti-flip-flop**: candidate hysteresis with score gain (PJDodge) WINS
   over commit-dwell + sharp-flip dot (RePP).
5. **Hazard memo**: fixed open-addressing table (PJDodge) WINS over
   `unordered_map` (RePP) — zero per-frame allocation.
6. **Walls during boxed-in escape**: RePP field's no-corner-cutting Dijkstra
   WINS (PJDodge had no equivalent).

## Plans and dependency graph

| Plan | File | Content | Depends on |
|---|---|---|---|
| 31 | `31-udodge-foundation.md` | Folder, `UDodgeTypes.h`, `UDodgeSensors.{h,cpp}`, vcxproj/filters registration | none |
| 32 | `32-udodge-core.md` | `UDodgeCore.{h,cpp}`, `UDodgeField.{h,cpp}` (Evaluate + Dijkstra field candidate) | 31 |
| 33 | `33-udodge-feature-and-wiring.md` | `UDodge.{h,cpp}`, `UDodgeDebug.{h,cpp}`, DodgeMode 7, DangerPlanner dispatch, FeatureCommandRegistry, FeatureState clamp, DiagBridge, TestTAB UI | 32 |
| 34 | `34-udodge-client.md` | client `contract.ts` keys, `auto-dodge.ts` mode + settings | 33 |
| 35 | `35-legacy-dodge-retirement.md` | delete RePP/PJDodge/ZDodge after user sign-off | 33, 34, **user in-game validation** |

```
31 ──► 32 ──► 33 ──► 34 ──► 35 (GATED: user validation)
```

Strictly sequential — every plan builds on files the previous one created.
Do not dispatch 32-35 in parallel with their dependency.

## Global verification

```bash
# Internal DLL (from WSL; Debug config — the verified path):
bash internal/tools/wsl-build.sh Debug
# → MSBuild reports 0 errors; output C:\rebuild\Debug\realm-engine.dll

# Raw-access guardrails:
bash internal/tools/check-raw-access.sh          # exit 0

# Client (plan 34 only):
cd client && npm run build                        # tsc clean
```
