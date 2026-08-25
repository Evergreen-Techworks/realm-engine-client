# 63 — UDodge Smart Dodge: threat-flow sidestep, directional commitment, and lock-driven engagement

## Goal
After this plan, UDodge is one lock-driven behavior with a much better dodge:

1. **Smart dodge (fixes the quality bug).** The moment-to-moment selection no
   longer flees straight away from bullets and no longer jitters/oscillates. It
   computes a **threat flow** (aggregate travel direction of the relevant danger
   lanes near the player, with a coherence measure) and replaces the pure
   clearance-lexicographic pick with a **weighted score** that rewards moving
   *perpendicular* to the flow (a lateral sidestep), rewards *continuing the
   current heading* (directional commitment — kills the flip-flop), and still
   rewards clearance and goal/intent alignment. All hard safety guarantees from
   plans 56/57 are preserved unchanged.

2. **Lock-driven unification (removes the Assist/Autopilot mode split).** There is
   now effectively ONE behavior, driven by the user's enemy lock:
   - **No enemy lock → pure assist.** WASD always wins; UDodge only sidesteps
     bullets and otherwise holds. It never wanders and never pursues anything.
   - **Enemy locked → engage that target** like the old autopilot: orbit it at
     weapon range through the whole-window planner, route paths, dodge — until the
     locked target is **dead / despawns / the lock is cleared**, at which point it
     automatically reverts to pure assist.
   The explicit `udodgeMode` Assist/Autopilot setting is **retired** (fewer settings
   is the goal). Lock state is the real driver.

**No new user settings are added.** Score weights and commitment strength are tuned
baked-in constants in `UDodgeTypes.h`. The only tuning slider kept is
`udodgeReactMargin` (shipped in plan 51). This plan *removes* `udodgeMode`; it adds
nothing.

## Dependencies
Builds on merged plans 56–62 on branch `refactor/unified-gameapi`. The whole UDodge
workstream is strictly sequential — no other plan may touch `udodge/` concurrently
(`55-udodge-autopilot-overview.md`). Assumes the current tree where
`UDodgeCore.cpp::Evaluate` picks by clearance-lexicographic `BetterCandidate`,
`UDodgeSensors.cpp::BuildMap` sets `hasLock` from the biggest-maxHp boss, and
`UDodge.cpp::Tick` branches on `settings.mode == 1` for autopilot.

Files touched:
- `internal/src/features/movement/udodge/`: `UDodgeTypes.h`, `UDodgeCore.cpp`,
  `UDodgeSensors.cpp`, `UDodge.cpp`, `UDodge.h`, `UDodgeWorker.h`,
  `UDodgeWorker.cpp`, `UDodgeDebug.cpp`.
- Shared dodge infra (read-only call): `DangerPlanner::GetEnemyLock()` (declared
  `internal/src/features/movement/dodge/DangerPlanner.h:56`) — no edit to
  DangerPlanner.
- Client + registry, **only to delete the retired `udodgeMode`**:
  `internal/src/features/control/FeatureCommandRegistry.cpp`,
  `client/src/bridge/contract.ts`, `client/plugins/auto-dodge.ts`.

## Current state

### A. Fleeing / jittering selection (quality bug)
`UDodgeCore.cpp::Evaluate` scores 35 candidates (stand, 32 compass, intent, field)
purely by clearance and picks lexicographically:
- `struct CandKey` + `BetterCandidate` — `UDodgeCore.cpp:199-228`; primary key is
  bucketed hard clearance, intent alignment (`dot`) is only the LAST tiebreak.
- `SelectProposed` — `UDodgeCore.cpp:230-248` — argmax by `BetterCandidate`. Max
  clearance ≈ heading straight AWAY from the nearest threat (retreat); with two
  threats, "away from A" vs "away from B" swaps the winner frame-to-frame.
- `proposed = SelectProposed(c);` — `UDodgeCore.cpp:553`.
- Blend loops re-pick "most intent-aligned among clearance-floored candidates" by
  maximizing `Dot(dir, intentDir)`: gentle `571-581`, emergency band `582-593`,
  unavoidable band `594-605`.
- Tick-locked hysteresis (the only anti-jitter): `UDodgeCore.cpp:607-619` — keyed on
  `state.selectedTick == in.tickId`, so it **resets every server tick (~5 Hz)** and
  does nothing for cross-tick oscillation.
- Degenerate-move re-pick (safety): `UDodgeCore.cpp:632-650`, argmax by
  `BetterCandidate`.

No perpendicular-sidestep term and no directional-commitment term exist.

### B. Reference to port (READ-ONLY — do NOT modify repp/ or zdodge/)
`internal/src/features/movement/repp/ReppPlanner.cpp`:
- `struct Flow` + `ComputeFlow` — `ReppPlanner.cpp:184-207`: sums each threat's
  travel direction `Normalize(samples[n-1]-samples[0])`, sets
  `coherence = |sum|/totalWeight` and `dir = sum/|sum|`.
- perp term — `ReppPlanner.cpp:325-332`:
  `perp = (1 - 2*|Dot(dir, flow.dir)|) * flow.coherence;` combined as
  `clamp(clr,-2,4)*kClearanceW + intentDot*kIntentW + perp*kPerpW + ...`
  Weights `kClearanceW=1.5, kPerpW=5.0, kIntentW=2.5` (`ReppPlanner.cpp:21-24`).
  `perp` is **+coherence** for a sidestep (`Dot==0`) and **−coherence** for moving
  along the stream (`|Dot|==1`, which includes fleeing straight away).
ZDodge confirms the idea: `ComputeThreatFlow` (`zdodge/ZDodgePlanner.cpp:263-285`),
`perpScore` (`ZDodgePlanner.cpp:357-368`, which also penalizes standing still under
a coherent flow).

Mapping to UDodge: `LaneThreat` (`UDodgeTypes.h:125-132`) stores a polyline where
`points[0]` = live bullet position and later points trace future travel. So a lane's
travel direction is `Normalize(points[pointCount-1]-points[0])` — the analog of
RePP's `samples[n-1]-samples[0]`. UDodge has no per-threat damage; weight by
proximity instead.

### C. Autopilot / lock split (the behavior to unify)
- `UDodge::Settings::mode` (`UDodgeTypes.h:87`) 0=Assist, 1=Autopilot. Consumed ONLY
  in `UDodge.cpp`: `ReadSettings` (`88`), the autopilot branch (`257`), the UI combo
  (`451-453`), `Set/GetMode` (`522-523`). Registry: `FeatureCommandRegistry.cpp:249`
  (`FH_INT("udodgeMode", UDodge::SetMode)`). Client: `contract.ts:77` KNOWN_SETTINGS
  entry, `auto-dodge.ts:303-311` `registerModeSetting` + `auto-dodge.ts:502` reset.
  `RePP::SetMode`/`reppMode` are separate and untouched.
- `UDodgeSensors.cpp::BuildMap` sets the lock to the **biggest-maxHp live enemy**,
  range-uncapped: `BuildMap:300-319`
  ```cpp
  int32_t lockId = 0, lockMaxHp = -1; float lockX=0, lockY=0;
  for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
      ...
      if (e.hasHealthBar && e.hp > 0 && e.maxHp > 0 &&
          (e.maxHp > lockMaxHp || (e.maxHp == lockMaxHp && e.id < lockId))) {
          lockMaxHp = e.maxHp; lockId = e.id; lockX = e.x; lockY = e.y;
      }
  }
  if (lockMaxHp >= 0) { out.hasLock = true; out.lockId = lockId; out.lockPos = {lockX,lockY}; }
  ```
  This auto-engages any boss on screen with no user intent — the opposite of the
  desired "no lock → assist".
- `UDodge.cpp::Tick` autopilot branch (`257-306`) feeds the worker plan's `firstDir`
  as intent **unconditionally** (`in.intentDir = g_lastPlan.firstDir;` at `303`).
  `g_lastPlan` is a game-thread cache kept across frames (`UDodge.cpp:50-53`): on
  worker contention it is reused, so a **stale** `firstDir` toward a phantom goal
  drives movement → the "walks in a random direction" bug. `PublishSnapshot` returns
  `void` (`UDodgeWorker.h:20`, `UDodgeWorker.cpp:93-103`), giving no freshness signal.

### D. The user's explicit lock signal
`DangerPlanner::GetEnemyLock()` returns the user's manual (Shift+Click) enemy-lock
object id, or 0 (`DangerPlanner.h:56`; toggled by `SetEnemyLock`/`ClearEnemyLock` at
`gui/tabs/TestTAB.cpp:875-877`). It is an atomic load — safe on the game thread.
`EnemyTracker` entries expose `id`, `x`, `y`, `hp`, `maxHp`, already iterated in
`BuildMap`. `ReanchorMap` leaves `hasLock` untouched and `BuildMap` re-runs on every
server-tick change (`UDodge.cpp:232-241`), so a lock recompute costs ≤1 server tick
(~200 ms) of latency — fine for "revert to assist when the target dies".

## Target design

### D1. Threat flow (game thread, in `Core::Evaluate`) — anti-flee
Pure math over the plain-data `DangerMap`, once per frame after the relevance pass
(`UDodgeCore.cpp:423-440` fills `c.relevant[]`). O(relevantCount) ≤ 96 — negligible,
no hot-path regression. Add to the anonymous namespace of `UDodgeCore.cpp`:
```cpp
struct ThreatFlow { Vec2 dir{}; float coherence = 0.f; bool has = false; };

ThreatFlow ComputeThreatFlow(const MapCtx& c)
{
    Vec2 sum{}; float total = 0.f;
    for (int r = 0; r < c.relevantCount; ++r) {
        const LaneThreat& L = c.m->lanes[c.relevant[r]];
        if (L.pointCount < 2) continue;
        const Vec2 travel = Normalize(Sub(L.points[L.pointCount - 1], L.points[0]));
        if (LenSq(travel) <= 1e-4f) continue;
        const float standDist = LaneDistCheb(L, c.in->player);   // near lanes dominate
        const float w = 1.f / (1.f + std::max(0.f, standDist));
        sum = Add(sum, Mul(travel, w));
        total += w;
    }
    ThreatFlow f{};
    if (total <= 0.f) return f;
    const float mag = Len(sum);
    f.coherence = std::clamp(mag / total, 0.f, 1.f);
    f.has = mag > 1e-4f;
    f.dir = f.has ? Mul(sum, 1.f / mag) : Vec2{};
    return f;
}
```
Zones (static discs) have no travel direction and are omitted (they are already
handled by clearance + soft cost), matching RePP.

### D2. Weighted candidate score (replaces the lexicographic *ranking*)
Add to the anonymous namespace of `UDodgeCore.cpp`:
```cpp
float ScoreOf(const MapCtx& c, int cand, Vec2 intent,
              const ThreatFlow& flow, Vec2 prevDir)
{
    if (!c.valid[cand]) return -kHugeClearance;
    const Vec2 d = c.dirs[cand];
    const bool moving = LenSq(d) > 1e-6f;

    float score = std::clamp(c.clearance[cand], -2.f, 4.f) * kUScoreClearW;  // safety
    if (LenSq(intent) > 1e-6f)
        score += Dot(d, intent) * kUScoreIntentW;                            // goal/WASD
    if (flow.has && moving) {                                                // sidestep
        const float parallel = std::fabs(Dot(d, flow.dir));
        score += (1.f - 2.f * parallel) * flow.coherence * kUScorePerpW;
    }
    if (moving && LenSq(prevDir) > 1e-6f)                                     // commitment
        score += Dot(d, prevDir) * kUScoreCommitW;
    score -= c.softCost[cand] * kUScoreSoftW;                                 // pending zones
    return score;
}
```
Baked constants in `UDodgeTypes.h` (tuned; change here + recompile if feel needs it):
```cpp
constexpr float kUScoreClearW   = 1.5f;
constexpr float kUScorePerpW    = 3.0f;
constexpr float kUScoreIntentW  = 2.0f;
constexpr float kUScoreCommitW  = 2.5f;
constexpr float kUScoreSoftW    = 1.0f;
constexpr float kUScoreDeadband = 0.4f;  // hysteresis flip deadband (score units)
```
Ratios mirror RePP (`1.5 / 5.0 / 2.5`) with perp scaled to 3.0 because UDodge
re-ranks only within the safety-floored set (below), so a smaller perp already
sidesteps without over-steering. Clearance dominates at its top end (+4×1.5 = +6) so
a genuinely safer candidate still wins; perp (±3) and commit (±2.5) convert a
straight retreat into a committed lateral sidestep among candidates that are already
safe; intent (±2) keeps the orbit/goal honored.

### D3. Where `ScoreOf` is used — SAFETY PRESERVED
`ScoreOf` replaces only the ranking metric; every hard-safety filter is byte-for-byte:
- `SelectProposed` → argmax of `ScoreOf` over valid candidates (still skips
  `kIntentCandidate`).
- The three blend loops keep their exact clearance-floor gates (`< c.reactMargin` /
  `< acceptable` / `< acceptableClearance`); only the inner ranking swaps from
  `Dot(dir,intentDir)` to `ScoreOf`. A candidate failing the floor stays excluded, so
  perp/commit can **never** pick into a wall (`!valid`) or a second bullet
  (fails floor).
- Degenerate re-pick (`LenSq(dirs[choice]) < 1e-6`) still runs, still biases to the
  field escape; ranking swaps `BetterCandidate` → `ScoreOf` over moving candidates.
- `CandKey` / `BetterCandidate` / `CorridorClearance` / `KeyOf` are **kept** — they
  still serve `SelectHazardEscapeMap` (`UDodgeCore.cpp:254-277`), out of scope here.

### D4. Directional-commitment hysteresis (replaces tick-locked) — anti-jitter
Add `Vec2 lastMoveDir{}` to `CoreState` (`UDodgeTypes.h:209-219`; reset in `Reset()`).
Capture `const Vec2 prevDir = state.lastMoveDir;` before the override selection.
Replace the tick-locked hysteresis (`UDodgeCore.cpp:607-619`) with a persistent
score-deadband hold:
```cpp
const int held = state.selectedCandidate;
if (held != choice && c.valid[held] &&
    LenSq(c.dirs[held]) > 1e-6f &&
    c.clearance[held] >= c.reactMargin &&
    ScoreOf(c, held, intentDir, flow, prevDir)
        >= ScoreOf(c, choice, intentDir, flow, prevDir) - kUScoreDeadband) {
    choice = held;
} else {
    state.selectedCandidate = choice;
}
state.selectedTick = in.tickId; state.haveTick = true;
```
Dropping the `selectedTick == in.tickId` gate makes commitment persist across ticks;
the `clearance[held] >= reactMargin` guard still forces an immediate switch when the
held heading becomes unsafe. After the final `choice` (post degenerate re-pick), set
`state.lastMoveDir = Normalize(c.dirs[choice]);`, and set
`state.lastMoveDir = intentDir;` in the `PreserveSafeIntent` early-return
(`UDodgeCore.cpp:558-564`) so orbit continuity is remembered.

### D5. Lock-driven target selection (BuildMap) — the unification core
Replace the biggest-maxHp boss selection in `UDodgeSensors.cpp::BuildMap:300-319`
with "the user's explicitly-locked LIVE enemy". Add `#include
"movement/dodge/DangerPlanner.h"` to `UDodgeSensors.cpp`. Inside the existing
`EnemyTracker::GetSnapshot()` loop (which already reads `e.id/e.hp/e.x/e.y`), match
the locked id:
```cpp
const int32_t userLockId = DangerPlanner::GetEnemyLock();   // 0 = no lock
...
for (const EnemyTracker::Entry& e : EnemyTracker::GetSnapshot()) {
    ... (existing blocker cull unchanged) ...
    // Lock the enemy the USER locked on, only while it is ALIVE. Not range-culled,
    // so we keep orbit range to a far locked boss. Dead (hp<=0) / despawned (absent)
    // / unlocked (userLockId==0) ⇒ never matched ⇒ hasLock stays false ⇒ assist.
    if (userLockId != 0 && e.id == userLockId && e.hp > 0 && IsFinitePoint(e.x, e.y)) {
        out.hasLock = true; out.lockId = e.id; out.lockPos = { e.x, e.y };
    }
}
```
Delete the `lockId/lockMaxHp/lockX/lockY` locals and the trailing `if (lockMaxHp>=0)`
block. `out.hasLock/lockId/lockPos` are already zeroed at `BuildMap:280-282`.

Downstream is unchanged and now naturally lock-driven: `Planner::Compute` returns
`hasGoal=false` when `!in.hasLock` (`UDodgePlanner.cpp:173`), so no lock ⇒ no goal ⇒
no intent ⇒ pure dodge; a locked live enemy ⇒ orbit *that enemy* at weapon range.
**"Revert to assist when dead" detection:** the locked id must reappear each server
tick in `EnemyTracker` with `hp>0`; when it dies or despawns it fails this match and
the next `BuildMap` clears `hasLock` (≤1 tick).

Decision on which lock: the user's **explicit manual lock** (`GetEnemyLock()`) is the
single driver — it is the only signal that means "the user chose to engage THIS
enemy". The biggest-boss auto-select is intentionally dropped (it engaged without
consent). If later the product wants the AutoAim-locked target to also count, the one
resolution point is `userLockId` here (a future `|| AutoAim::…`); do not add it now.

### D6. Unified lock-driven intent (UDodge.cpp) + retire the mode branch
Replace the mode-branch intent block (`UDodge.cpp:251-313`) with one priority chain
(no `settings.mode`):
```cpp
bool intentIsAuto = false, apHasTarget = false; Vec2 apTarget{};
if (steer.active) {
    in.intentDir = { steer.dirX, steer.dirY };            // WASD always wins
} else if (LanternIntent(in.player, settings, apTarget, in.intentDir)) {
    intentIsAuto = true; apHasTarget = true;              // opt-in stand-on object
} else if (g_map.hasLock) {
    // ENGAGE the user-locked enemy through the background orbit planner.
    intentIsAuto = true;
    static Planner::PlannerSnapshot snap;
    ... (fill snap exactly as today: tickId/player/settings/hasLock/lockPos/
         rangeResolved/weaponRangeTiles/FillOccGrid/map) ...
    const uint32_t pub = Worker::PublishSnapshot(snap);
    if (pub) g_lastPubSeq = pub;
    Planner::PlanResult fresh{};
    if (Worker::TryGetLatestPlan(fresh)) g_lastPlan = fresh;
    // Strict freshness: a stale/absent plan NEVER drives movement (no wander).
    const bool planFresh = g_lastPlan.hasGoal &&
                           g_lastPubSeq >= g_lastPlan.forSeq &&
                           (g_lastPubSeq - g_lastPlan.forSeq) <= kUPlanMaxStaleSeq;
    if (planFresh && LenSq(g_lastPlan.firstDir) > 1e-6f) {
        in.intentDir = g_lastPlan.firstDir; apHasTarget = true; apTarget = g_lastPlan.goalPos;
    } else {
        in.intentDir = {}; apHasTarget = false;           // no route yet → dodge + hold
    }
}
// else (no WASD, no lantern, no lock): in.intentDir stays {} → pure assist + dodge.
```
Add `uint32_t g_lastPubSeq = 0;` next to `g_lastPlan` (`UDodge.cpp:53`) and
`constexpr uint32_t kUPlanMaxStaleSeq = 8;` to `UDodgeTypes.h`. Keep the existing
`settings.lockFollow` external-goal branch as a lower-priority fallback only when
`!g_map.hasLock` (unchanged behavior for that opt-in). Because `hasLock` is only true
when locked, and `intentIsAuto` stays false with a zero intent, the auto-walk guard
(`UDodge.cpp:338` `LenSq(in.intentDir) > 1e-6`) already keeps assist from moving on
its own.

**Retire `udodgeMode`:** delete `Settings::mode` (`UDodgeTypes.h:87`); the `g_mode`
atomic, `ReadSettings` line `88`, the UI combo `451-453` (and `modeLabels`), and
`Set/GetMode` (`522-523`) in `UDodge.cpp`; `SetMode/GetMode` in `UDodge.h:49`;
`FH_INT("udodgeMode", …)` at `FeatureCommandRegistry.cpp:249`; the `udodgeMode` entry
in `contract.ts:77`; and the `registerModeSetting('unified','udodgeMode',…)` block
(`auto-dodge.ts:303-311`) plus its reset send (`auto-dodge.ts:502`).

### D7. Worker seq return (freshness plumbing)
`UDodgeWorker.h:20` → `uint32_t PublishSnapshot(const Planner::PlannerSnapshot&);`.
`UDodgeWorker.cpp:93-103` → return `0` on the contention drop, else return
`g_pendingSnap.seq` (the freshly assigned `++g_seq`).

### D8. Debug overlay (no decision impact)
Add `Vec2 flowDir{}; float flowCoherence = 0.f;` to `CoreOutput`
(`UDodgeTypes.h:194-205`) and `DebugSnapshot` (`UDodgeTypes.h:222-249`); set them from
the flow in `Evaluate`; copy into the published `DebugSnapshot` in `Tick`; draw a
short orange arrow along `flowDir` scaled by `flowCoherence` in `UDodgeDebug.cpp`
(reuse `DrawLine`, `UDodgeDebug.cpp:54-59`).

## Steps
Run all three verification commands after EVERY step. Steps 1, 2, 6, 9 are
behavior-preserving scaffolding/plumbing; steps 3, 4, 5, 7, 8 are the intended
behavior changes (never mixed with a refactor in the same step).

1. **Baked constants + data fields.** `UDodgeTypes.h`: add the six `kUScore*`
   constants and `kUPlanMaxStaleSeq`; add `Vec2 lastMoveDir{}` to `CoreState`
   (+ `Reset()`); add `Vec2 flowDir{}; float flowCoherence = 0.f;` to `CoreOutput`
   and `DebugSnapshot`. Nothing reads them yet. Verify: build clean, behavior
   unchanged.

2. **Threat flow + `ScoreOf` (computed, unused for selection).** `UDodgeCore.cpp`:
   add `ThreatFlow`, `ComputeThreatFlow`, `ScoreOf` (D1/D2); compute the flow after
   the relevance pass and set `out.flowDir/out.flowCoherence`. Copy those into the
   published `DebugSnapshot` in `UDodge.cpp::Tick`. Do NOT change any selection call.
   Verify: build clean; behavior identical (only debug fields populated).

3. **Swap selection ranking to `ScoreOf` + commitment hysteresis (dodge fix).**
   `UDodgeCore.cpp` only: change `SelectProposed` to argmax `ScoreOf` (new signature
   `(c, intent, flow, prevDir)`); capture `prevDir = state.lastMoveDir` before it;
   swap the inner ranking in the gentle/emergency/unavoidable loops from
   `Dot(dir,intentDir)` to `ScoreOf` (keep every clearance-floor gate); replace the
   hysteresis with the D4 deadband hold and set `state.lastMoveDir`; swap the
   degenerate re-pick ranking to `ScoreOf`. Leave `KeyOf`/`BetterCandidate`/
   `CorridorClearance`/`SelectHazardEscapeMap` untouched. Verify: build clean.
   **In-game:** in a bullet stream the dodge makes committed lateral sidesteps, does
   not retreat, does not flip-flop; emergency (surrounded) still escapes, never freezes.

4. **Worker seq return.** `UDodgeWorker.h`/`.cpp`: `PublishSnapshot` returns
   `uint32_t` (D7). Verify: build clean; behavior unchanged (return value unused yet).

5. **Lock-driven target in BuildMap.** `UDodgeSensors.cpp`: add the DangerPlanner
   include; replace the biggest-boss lock selection with the user-lock match (D5).
   Verify: build clean. **In-game:** with no lock, autopilot/orbit does NOT engage a
   boss; locking an enemy makes `hasLock` true (check the overlay lock cross / diag).

6. **Unified lock-driven intent in Tick.** `UDodge.cpp`: add `g_lastPubSeq`; replace
   the mode-branch intent block with the D6 priority chain (WASD → lantern → hasLock
   engagement w/ freshness gate → lockFollow fallback → pure dodge). Capture the
   `PublishSnapshot` return. Do NOT yet delete the mode getters/UI. Verify: build
   clean. **In-game:** no lock ⇒ pure dodge + hold, never wanders; locked live enemy
   ⇒ orbit at weapon range; kill/despawn/unlock ⇒ reverts to assist within a tick.

7. **Retire `udodgeMode` (DLL side).** `UDodge.cpp`: delete `g_mode`, the
   `ReadSettings` mode line, the UI combo + `modeLabels`, `Set/GetMode`.
   `UDodge.h`: delete the `SetMode/GetMode` decls. `UDodgeTypes.h`: delete
   `Settings::mode`. `FeatureCommandRegistry.cpp`: delete the `udodgeMode` handler
   row. Verify: build clean; raw-access exit 0.

8. **Retire `udodgeMode` (client side).** `contract.ts`: remove the `udodgeMode`
   KNOWN_SETTINGS entry. `auto-dodge.ts`: remove the `udodgeMode` `registerModeSetting`
   block and its reset send. Verify: `cd client && npm run build` clean.

9. **Debug flow arrow (optional, no decision impact).** `UDodge.cpp`: publish
   `flowDir/flowCoherence` into `DebugSnapshot` (already wired in step 2 — confirm).
   `UDodgeDebug.cpp`: after the intent arrow (`178-180`), draw
   `DrawLine(d, cam, snap.player, Add(snap.player, Mul(snap.flowDir,
   1.5f*std::clamp(snap.flowCoherence,0.f,1.f))), IM_COL32(255,120,0,200), 2.f)` when
   `snap.flowCoherence > 0.05f`. Verify: build clean; orange flow arrow visible.

## Verification
After every step (repo root):
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors, 0 warnings
bash internal/tools/check-raw-access.sh       # exit 0
cd client && npm run build                     # tsc clean
```
Completion greps:
```bash
command grep -rn "ComputeThreatFlow\|ScoreOf" internal/src/features/movement/udodge/UDodgeCore.cpp   # non-empty
command grep -rn "kUScorePerpW\|kUScoreCommitW" internal/src/features/movement/udodge/UDodgeTypes.h   # non-empty
command grep -rn "GetEnemyLock\|g_lastPubSeq\|planFresh" internal/src/features/movement/udodge/       # non-empty
command grep -rn "udodgeMode\|SetMode\|GetMode\|settings.mode\|\.mode" internal/src/features/movement/udodge/  # EMPTY
command grep -rn "udodgeMode" client internal                                                          # EMPTY (retired)
command grep -rn "udodgePerp\|udodgeCommit\|udodgeClearW\|udodgeIntentW" client internal               # EMPTY (no new settings)
```
Success: Debug DLL 0/0, raw-access exit 0, client tsc clean, and the in-game checks
in steps 3, 5, 6.

## Out of scope
- Do NOT add any new setting/slider/atomic. The ONLY client/registry edits allowed
  are DELETING the retired `udodgeMode` (steps 7–8). Keep `udodgeReactMargin`.
- Do NOT modify `repp/`, `pjdodge/`, `zdodge/` (read-only reference; plan 35 owns
  their retirement) or `DangerPlanner.cpp` (only *call* `GetEnemyLock()`).
- Do NOT touch the cleanup-wave files (`gui/tabs/WorldTAB.cpp`, `gui/CamState.cpp`,
  `gui/tabs/PlayerTAB.cpp`, `gui/tabs/CameraTAB.cpp`, `internal/tools/check-raw-access.sh`,
  `gui/tabs/TestTAB.cpp`), the `DBG_FILE_LOG` diagnostics in `udodge/` (plan 62), or
  the uncommitted `client/build-tools/dev-build.bat`.
- Do NOT change `SelectHazardEscapeMap`, the field-escape routing, the whole-window
  Dijkstra (`UDodgePlanner.cpp`), the worker threading model, or the rasterization.
- Do NOT remove `udodgeLockFollow` in this plan (leave the legacy external-goal
  fallback as-is; note it as a later folding candidate). Do NOT reconcile the
  AutoAim-locked target into the lock driver now (documented one-line future hook in
  D5).
</content>
