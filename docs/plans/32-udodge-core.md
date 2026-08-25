# 32 — UDodge Core: Predictive Controller + Field Escape

## Goal
After this plan, `internal/src/features/movement/udodge/` contains the full
decision engine: `UDodgeCore.{h,cpp}` (a port of PJDodge's exact-CCD
predictive controller, extended for lingering AoE zones and a 35th
"field escape" candidate) and `UDodgeField.{h,cpp}` (a port of RePP's
wall-aware Dijkstra pocket search). Everything compiles and is exercised by
nothing yet — the feature shell that calls `Core::Evaluate` arrives in plan
33. No existing behavior changes.

Context (read `docs/plans/30-unified-dodge-overview.md` if present, but this
plan is self-contained): the unified dodge keeps PJDodge's brain — relevance
gating, closed-form Chebyshev CCD per candidate, survival-lexicographic
selection, intent-preservation ladder, hysteresis, speed matching, hazard
escape — and adds the one thing PJDodge could not do: when every straight
heading dies inside the horizon (boxed in / wall between player and safety),
a Dijkstra search over a 21×21 half-tile grid finds a pocket that is safe to
stand in, routes around walls (no corner-cutting) to it, and feeds the first
step back into the candidate set, where the same CCD scoring must confirm it
before it can win.

## Dependencies
- **Plan 31 must be merged first** — this plan includes `UDodgeTypes.h` and
  `UDodgeSensors.h` and adds files to the same vcxproj ItemGroups.

Files this plan touches that other plans also touch:
- `internal/il2cpp-dll-injection.vcxproj` / `.filters` (plan 33 adds more).

## Current state
The logic being unified lives in two places (neither is modified here):
- `internal/src/features/movement/pjdodge/PJDodgeCore.cpp` (736 lines) — the
  controller being ported. Structure: Ctx + env probes (lines 19-66),
  `PlayerAt`/`ThreatLerp` (68-84), relevance pass `ClassifyProjectile`
  (86-128), `ValidateCandidatePaths` (130-149), `SelectHazardEscape`
  (151-185), `ScoreProjectile` exact CCD (187-241), `ScoreAoes` (243-270),
  layer-2 escape search `SweepSegment`/`SearchSurvival`/
  `RefineWithEscapeSearch` (272-417), `CorridorSafety`/
  `SelectProposedCandidate` (419-471), `IsVelocitySafe`/`SelectAlignedSpeed`
  (473-531), `Finish` (533-551), `Evaluate` (555-734).
- `internal/src/features/movement/repp/ReppField.cpp` (125 lines) — the
  Dijkstra field being ported: 21×21 half-tile grid, static scratch arrays,
  linear-scan pop with first-goal early exit, wall veto + diagonal
  corner-cut veto (lines 85-92), hazard cost (line 95), first-step
  reconstruction + immediate-step safety guard (lines 106-121). Its safety
  probe (`Planner::CellSafeToStand`, `ReppPlanner.cpp:399-404` →
  `RejectAt`/`ThreatHitsAt`, `ReppPlanner.cpp:70-181`) is reimplemented here
  against the unified snapshot.

## Target design

### `UDodgeCore.h`
```cpp
#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Core {

// Pure decision function (game-update thread). Reads the snapshot + env
// probes in `in`, updates hysteresis state, writes the full output.
void Evaluate(const CoreInput& in, CoreState& state, CoreOutput& out);

// "Could the player stand at `pos`, arriving at arrivalMs, for holdMs, and
// not be hit / be on a wall or hazard?" Used by the field search as its goal
// probe. Walls+hazard via in.env (hazard always blocks — a pocket endpoint
// must be clean ground); projectiles via point-vs-polyline within the
// [arrivalMs - pad, arrivalMs + holdMs + pad] window; AoE landings and
// active zones inside that window. Enemy bodies deliberately NOT checked
// (they are score-only in this engine).
bool PointDwellClear(const CoreInput& in, Vec2 pos, float arrivalMs, float holdMs);

} } // namespace UDodge::Core
```

### `UDodgeField.h`
```cpp
#pragma once
#include "UDodgeTypes.h"

namespace UDodge { namespace Field {

struct EscapeResult {
    bool found = false;
    Vec2 target{};     // pocket cell (world)
    Vec2 firstDir{};   // unit direction of the first step
};

// Dijkstra over a 21x21 half-tile grid centered on the player. Goal = first
// popped non-start cell where Core::PointDwellClear(in, cell, arrivalMs,
// kHoldMs) holds. Walls block; diagonal steps require both orthogonal
// neighbors open (no corner-cutting); hazard cells cost extra but are
// traversable. speedTilesPerMs converts accumulated distance to arrival time.
// Game-update thread only (static scratch).
EscapeResult FindEscape(const CoreInput& in, float speedTilesPerMs);

} } // namespace UDodge::Field
```

### `UDodgeField.cpp` — port of `ReppField.cpp`
Verbatim port with these substitutions:
- namespace `RePP::Field` → `UDodge::Field`; include `"UDodgeField.h"` and
  `"UDodgeCore.h"`.
- `Planner::CellSafeToStand(cell, player, arrivalMs, kHoldMs, s, sn)` →
  `Core::PointDwellClear(in, cell, arrivalMs, kHoldMs)` (goal test, line 73
  of the source) and the first-step guard (line 116) →
  `Core::PointDwellClear(in, stepWorld, stepArrMs, 0.f)`.
- `Sensors::IsWallAt(x, y)` → `!in.env.canOccupy || !in.env.canOccupy(x, y, false)`
  (walls only — pass `safeWalk=false` so hazard does not read as a wall;
  hazard keeps its cost-penalty role on the next line).
- `Sensors::IsHazardAt(x, y)` → `in.env.isHazard && in.env.isHazard(x, y)`;
  the `s.avoidHazards` gate becomes `in.settings.safeWalk`.
- `Planner::ArrivalSpeed(...)` → the `speedTilesPerMs` parameter.
- Constants stay exactly as in the source (`kRad=10`, `kCellTiles=0.5f`,
  `kHazardCost=40.f`, `kHoldMs=250.f`).

### `UDodgeCore.cpp` — port of `PJDodgeCore.cpp` with four deltas

Copy `PJDodgeCore.cpp`, rename namespace `PJDodge` → `UDodge`, include
`"UDodgeCore.h"` and `"UDodgeField.h"`, then apply:

**Delta A — lingering AoE zones (`activeNow`).** Wherever the source
evaluates an `AoeThreat` at its single `landingMs` instant, an active zone
must instead block its disc for `t ∈ [0, min(remainMs, horizon)]`. Because
every candidate path is a straight segment over that interval, the exact
check is point-to-segment distance (Euclidean, AoEs are circles). Add one
helper next to `ThreatLerp`:
```cpp
// Min Euclidean distance from point q to segment a→b.
float DistPointSeg(Vec2 q, Vec2 a, Vec2 b)
{
    const Vec2 ab = Sub(b, a);
    const float d = LenSq(ab);
    const float t = d > 1e-6f ? std::clamp(Dot(Sub(q, a), ab) / d, 0.f, 1.f) : 0.f;
    return Len(Sub(q, Add(a, Mul(ab, t))));
}
```
Then in each of the four AoE consumers:
1. `ScoreAoes` (source lines 243-270): for `a.activeNow`, compute
   `const float endT = std::min(a.remainMs, c.horizon);` and per candidate
   `clearance = DistPointSeg(a.pos, PlayerAt(c, dir, 0), PlayerAt(c, dir, endT)) - a.radius;`
   with impact time approximated as `0.f` when `clearance <= 0` (we are, or
   will be, inside a live zone — maximum urgency). Non-active zones keep the
   existing landing-instant logic unchanged.
2. The relevance pass in `Evaluate` (source lines 600-611): an active zone is
   a direct threat when
   `Len(Sub(a.pos, in.player)) - a.radius <= kRelevanceClearance` (skip the
   landing-window gate for active zones).
3. `SweepSegment` (source lines 326-333): for active zones whose
   `[0, remainMs]` overlaps `[t0, endMs]`, clearance =
   `DistPointSeg(a.pos, posAt(max(t0,0)), posAt(min(e.endMs, a.remainMs))) - a.radius`,
   and on `<= 0` set `e.endMs = t0` (the segment enters a live zone).
4. `IsVelocitySafe` (source lines 480-485): for active zones, check
   `DistPointSeg(a.pos, playerAt(0), playerAt(min(horizon, remainMs))) - a.radius >= kIntentSafeClearance`.

**Delta B — 35th candidate is invalid by default.** After the init loop
(source lines 578-585 set `valid[i] = true` for all), add:
```cpp
    c.valid[kFieldCandidate] = false;   // only real when the field produces a step
    c.dirs[kFieldCandidate] = {};
```
`ValidateCandidatePaths` (source 130-149) loops `cand = 1 ..
kCandidateCount-1`; guard its body with `if (!c.valid[cand]) continue;` so
the not-yet-set field candidate is skipped. (`ScoreProjectile`/`ScoreAoes`
already skip `!valid`.)

**Delta C — run the field and score its candidate.** Insert after
`RefineWithEscapeSearch(c);` (source line 648) and BEFORE the hazard-escape
block (source line 651):
```cpp
    // ── Field escape: Dijkstra pocket search when nothing straight survives ──
    out.fieldActive = false;
    if (in.settings.fieldEscape && c.speed > 0.f) {
        bool boxedIn = true;   // no non-stand/intent candidate survives the horizon
        for (int cand = 1; cand <= kDirectionCount; ++cand)
            if (c.valid[cand] && c.impactMs[cand] >= c.horizon - 0.5f) { boxedIn = false; break; }
        bool hazardStuck = c.hazardEscape;
        if (hazardStuck)
            for (int cand = 0; cand < kCandidateCount; ++cand)
                if (c.valid[cand] && c.hazardExitMs[cand] < kMaxTimeMs) { hazardStuck = false; break; }
        if (boxedIn || hazardStuck) {
            const Field::EscapeResult esc = Field::FindEscape(in, c.speed);
            if (esc.found && LenSq(esc.firstDir) > 1e-6f) {
                const int fc = kFieldCandidate;
                c.dirs[fc] = esc.firstDir;
                c.valid[fc] = true;
                c.score[fc] = kMaxTimeMs; c.impactMs[fc] = kMaxTimeMs;
                c.blockMs[fc] = kMaxTimeMs; c.enemyClear[fc] = kMaxTimeMs;
                c.hazardExitMs[fc] = kMaxTimeMs;
                // Validate exactly like ValidateCandidatePaths does for one cand:
                for (float t = 0.f; t <= c.horizon; t += kSampleMs) {
                    const Vec2 p = PlayerAt(c, c.dirs[fc], t);
                    c.enemyClear[fc] = std::min(c.enemyClear[fc], EnemyClearanceAt(c, p));
                    if (c.hazardEscape && c.hazardExitMs[fc] >= kMaxTimeMs && !IsHazard(c, p.x, p.y))
                        c.hazardExitMs[fc] = t;
                    if (CanOccupy(c, p.x, p.y)) continue;
                    c.blockMs[fc] = t; c.impactMs[fc] = t;
                    if (t <= 0.f) c.valid[fc] = false;
                    break;
                }
                if (c.valid[fc]) {
                    const SegEval e = SweepSegment(c, in.player, 0.f, c.dirs[fc], c.lead);
                    c.impactMs[fc] = std::min(c.impactMs[fc], e.endMs);
                    c.score[fc] = std::min(c.score[fc], e.minClearance);
                    if (c.impactMs[fc] >= c.horizon - 0.5f)
                        c.score[fc] = std::max(c.score[fc], kIntentSafeClearance + 0.01f);
                    out.fieldActive = true;
                    out.fieldTarget = esc.target;
                }
            }
        }
    }
```
(`SegEval`/`SweepSegment` must therefore be declared above this point —
they already are in the source layout. `out.fieldActive`/`fieldTarget` must
also be copied by `Finish` — add the two assignments there instead if you
prefer one write path; either way every `Finish` exit must leave them
consistent, so initialize them at the top of `Evaluate` right after
`out = CoreOutput{};`.)

**Delta D — let the field candidate compete.**
1. `SelectProposedCandidate` (source 437-471): change the loop bound so it
   also considers the field candidate but still skips the intent candidate:
```cpp
    for (int cand = 1; cand < kCandidateCount; ++cand) {
        if (cand == kIntentCandidate) continue;
        ...
```
2. `CorridorSafety` (source 420-435): the field candidate has no compass
   index; map it to the nearest one:
```cpp
    if (cand == kFieldCandidate) {
        const Vec2 d = c.dirs[kFieldCandidate];
        const float ang = std::atan2(d.y, d.x);
        int idx = static_cast<int>(std::lround(ang / kTwoPi * kDirectionCount));
        idx = ((idx % kDirectionCount) + kDirectionCount) % kDirectionCount;
        cand = idx + 1;   // fall through to the compass-corridor math below
    }
```
   (place before the existing `if (cand == kStandCandidate)` early-out; keep
   the rest untouched — the neighbor window then uses the mapped index while
   `cappedImpact(cand)` for the center uses the mapped compass candidate,
   which is the conservative choice).
3. `SelectHazardEscape` (source 155-185) and the gentle/emergency/unavoidable
   intent-blend loops (source 675-709) already iterate
   `cand < kCandidateCount` and skip `!valid` — no change needed; note this
   in a comment. `RefineWithEscapeSearch` runs BEFORE the field exists, so it
   never touches the field candidate — also fine.
4. Set `out.decision = Decision::FieldEscape` when the final `choice ==
   kFieldCandidate` and the decision would otherwise be
   `GentleOverride`/`EmergencyOverride` (a blend that happens to pick the
   field candidate keeps its blend decision). Concretely, just before the
   final `Finish(...)` call (source line 732):
```cpp
    if (choice == kFieldCandidate &&
        (decision == Decision::GentleOverride || decision == Decision::EmergencyOverride))
        decision = Decision::FieldEscape;
```

**Deliberate non-changes** (document with comments, do not "fix"):
- The intent candidate is never substituted with the field direction; the
  field competes purely on survival lexicographics.
- Enemy bodies remain score-only (`EnemyClearanceAt` as tiebreak), including
  inside `PointDwellClear` — no contact-damage veto.
- Hysteresis (source 713-725), speed matching (727-731), and the
  intent-preservation ladder are byte-identical ports.

### `PointDwellClear` implementation (in `UDodgeCore.cpp`)
Port of RePP's endpoint test (`ReppPlanner.cpp:70-135`, `162-181`) against
the unified snapshot. Constants: `kTimingPadMs = 15.f` (RePP value).
```cpp
bool PointDwellClear(const CoreInput& in, Vec2 pos, float arrivalMs, float holdMs)
{
    if (!in.sensors) return false;
    if (in.env.canOccupy && !in.env.canOccupy(pos.x, pos.y, in.settings.safeWalk))
        return false;   // wall, or hazard endpoint when safeWalk is on
    const float lo = std::max(0.f, arrivalMs - kTimingPadMs);
    const float hi = arrivalMs + std::max(holdMs, 0.f) + kTimingPadMs;
    const float hitScale = std::clamp(in.settings.hitScale, 0.25f, 2.5f);
    for (int i = 0; i < in.sensors->projectileCount; ++i) {
        const ProjectileThreat& p = in.sensors->projectiles[i];
        const float half = std::clamp(p.hitHalf, 0.05f, 2.5f) * hitScale;
        for (int j = 0; j < p.sampleCount; ++j) {
            const float tB = p.sampleTimesMs[j];
            if (j == 0) {
                if (tB >= lo && tB <= hi &&
                    Cheb(p.samples[0].x - pos.x, p.samples[0].y - pos.y) <= half) return false;
                continue;
            }
            const float tA = p.sampleTimesMs[j - 1];
            if (tA > hi) break;
            if (tB < lo || tB < tA) continue;
            // Clip the segment to [lo, hi], then point-vs-segment Chebyshev.
            const float denom = std::max(tB - tA, 1e-4f);
            const float fA = std::clamp((std::max(tA, lo) - tA) / denom, 0.f, 1.f);
            const float fB = std::clamp((std::min(tB, hi) - tA) / denom, 0.f, 1.f);
            const Vec2 a = Add(p.samples[j-1], Mul(Sub(p.samples[j], p.samples[j-1]), fA));
            const Vec2 b = Add(p.samples[j-1], Mul(Sub(p.samples[j], p.samples[j-1]), fB));
            if (MinChebOnSegment(a.x - pos.x, a.y - pos.y, b.x - pos.x, b.y - pos.y) <= half)
                return false;
        }
    }
    for (int i = 0; i < in.sensors->aoeCount; ++i) {
        const AoeThreat& a = in.sensors->aoes[i];
        const bool inWindow = a.activeNow ? (lo <= a.remainMs)
                                          : (a.landingMs >= lo && a.landingMs <= hi);
        if (inWindow && Len(Sub(a.pos, pos)) <= a.radius) return false;
    }
    return true;
}
```

### Threading / cost
Game-update thread only, like everything above it. The field runs at most
once per `Evaluate`, only in boxed-in/hazard-stuck frames; the Dijkstra is
the same 441-cell linear-scan search RePP already runs per-frame in its
fallback path, with first-goal early exit. All scratch is static or
stack-fixed — zero per-frame heap allocation.

## Steps

1. Create `internal/src/features/movement/udodge/UDodgeCore.h` per the
   Target design.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Create `internal/src/features/movement/udodge/UDodgeCore.cpp` as the
   ported controller with Delta A (lingering AoE) and Delta B (field
   candidate invalid by default) and the `PointDwellClear` implementation.
   Leave Deltas C/D for step 4 (the file must compile without
   `UDodgeField.h` first). Register in
   `internal/il2cpp-dll-injection.vcxproj` (`<ClCompile>` next to the
   udodge sensors entry, `<ClInclude>` for the header) and mirror in
   `.filters`.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Create `internal/src/features/movement/udodge/UDodgeField.{h,cpp}` per
   the Target design (port of `ReppField.cpp` with the listed
   substitutions). Register both in the vcxproj + filters.
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. Apply Delta C (field invocation + candidate scoring block in `Evaluate`)
   and Delta D (selection-loop extensions, corridor mapping,
   `Decision::FieldEscape`).
   **Verify:** `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. Guardrails.
   **Verify:** `bash internal/tools/check-raw-access.sh` → exit 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors
bash internal/tools/check-raw-access.sh       # exit 0
ls internal/src/features/movement/udodge
# UDodgeTypes.h UDodgeSensors.h UDodgeSensors.cpp UDodgeCore.h UDodgeCore.cpp UDodgeField.h UDodgeField.cpp
grep -rn 'namespace PJDodge\|namespace RePP' internal/src/features/movement/udodge/  # → empty
grep -n 'kFieldCandidate' internal/src/features/movement/udodge/UDodgeCore.cpp | head  # ≥ 5 hits
grep -rn 'il2cpp_' internal/src/features/movement/udodge/   # → empty (no raw IL2CPP access)
```

## Out of scope
- Do NOT modify `pjdodge/`, `repp/`, `zdodge/`, `dodge/` sources.
- Do NOT create `UDodge.{h,cpp}` / `UDodgeDebug.{h,cpp}` or wire anything
  into TestTAB / DangerPlanner / FeatureCommandRegistry (plan 33).
- Do NOT touch the client.
- Do NOT "improve" ported logic beyond the four deltas — behavior parity with
  the sources is the review baseline.
