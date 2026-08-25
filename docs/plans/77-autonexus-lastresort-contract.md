# 77 — AutoNexus ↔ UDodge Last-Resort Contract

## Goal
After this plan, AutoNexus behaves as a **true last resort** that fires only when
udodge has genuinely FAILED to keep the player safe — not as a parallel predictor
that false-fires while udodge is actively re-steering. UDodge exposes an explicit
"is the player currently in danger the dodge could not resolve" signal, and
AutoNexus consumes it instead of dead-reckoning the player into shots udodge will
dodge.

## Dependencies
None structurally — parallel-safe (Wave A). It adds a public query to
`UDodge.{h,cpp}` and rewires `AutoNexus.cpp`. It does not depend on the refactors,
but if the annulus/commitment plans change the SolveKind semantics, this plan's
"failed" definition (below) still holds because it is expressed in terms of the
stable `SolveKind` enum and the stand clearance. Files touched: `UDodge.h`,
`UDodge.cpp`, `AutoNexus.cpp`.

## Current state — the parallel-predictor problem
AutoNexus (`AutoNexus.cpp:477` `RunAutoNexus`) independently:
- reads player motion and an observed velocity (`ObserveVelocity`,
  `AutoNexus.cpp:124`),
- dead-reckons the player along that velocity over a horizon
  (`FindHitMsUntil`, `AutoNexus.cpp:299`), and
- publishes threats to the client, which fires the nexus.

The current coupling is a single blunt line (`AutoNexus.cpp:504-506`):
```cpp
// When udodge is driving, ... predict at the CURRENT position (velocity 0).
if (UDodge::IsEnabled()) { pm.vx = 0.f; pm.vy = 0.f; }
```
This helps (it stops mispredicting a coast into a shot udodge will dodge), but it
is still a **parallel predictor**: it predicts hits at the player's *current*
position every 16 ms regardless of whether udodge is successfully dodging. A shot
whose lane currently covers the stand — which udodge is ONE tick from stepping
out of — still reads as an incoming hit and can false-fire. Conversely, it has no
notion of udodge having actually given up (Fallback/Surrounded), which is exactly
when the nexus SHOULD be trusted.

The only udodge signal AutoNexus can see is `IsEnabled()`. It cannot see the
solve outcome. UDodge already computes everything needed: `g_solve.kind`
(Hold/Safe/Fallback/Surrounded), `g_solve.clearance`, and the stand clearance
`Core::PointSafety(in, in.player)` (published as `d.standClearance`,
`UDodge.cpp:594`).

## Target design

### UDodge exposes a failure/exposure signal
Add a small public query to `UDodge.h`:
```cpp
namespace UDodge {
// Last-resort signal for AutoNexus. Reflects the most recent solve on the game
// thread. "Exposed" = udodge could NOT place the player fully safe this tick:
// the stand is covered (clearance <= 0) AND the solve did not find a safe
// reachable cell (kind is Fallback or Surrounded). When enabled and NOT exposed,
// udodge is handling it — AutoNexus should defer. Thread: written on the game
// thread each Tick, read from AutoNexus's poll thread; a plain atomic snapshot.
struct SafetyState {
    bool  enabled   = false;   // udodge active
    bool  exposed    = false;  // udodge failed to fully cover the player this tick
    float standClearance = 1e9f; // server-accurate clearance at the player (tiles)
    uint32_t tickId  = 0;      // freshness / staleness guard for the consumer
};
SafetyState GetSafetyState();
}
```
Back it with atomics in the `UDodge` anon namespace (mirror the existing atomic
setters), updated at the end of `Tick` from `g_solve` and the computed stand
clearance:
```cpp
// exposed when the stand is actually covered and no safe cell was reachable.
const float standClr = Core::PointSafety(in, in.player);
const bool exposed = (g_solve.kind == Solver::SolveKind::Fallback ||
                      g_solve.kind == Solver::SolveKind::Surrounded)
                     && standClr <= kULatencyPad;
```
Store `enabled/exposed/standClr/tickId` into the atomics. (Use a small struct of
atomics or four atomics; a `std::atomic<uint32_t>` tick + three atomics is
enough — no lock needed, this is a hint consumed conservatively.)

Rationale for the definition: `Safe`/`Hold` mean udodge placed or kept the player
on a provably-safe cell — the nexus must NOT fire on udodge's own transient
re-steer. `Fallback`/`Surrounded` with the stand covered mean the reachable disk
is fully dangerous (the honest "can be hit" case from `UDodgeSolver.h:53-58`) —
exactly when the nexus is the correct backstop.

### AutoNexus consumes it
Replace the blunt velocity-zeroing (`AutoNexus.cpp:504-506`) with the contract:
```cpp
const UDodge::SafetyState ud = UDodge::GetSafetyState();
if (ud.enabled) {
    // Predict at the current position (defer to udodge's re-steer).
    pm.vx = 0.f; pm.vy = 0.f;
    // Last-resort gate: while udodge is enabled and NOT exposed, it is handling
    // the shots — suppress nexus firing so the transient "shot covers the stand
    // for one tick before udodge steps out" never false-fires. Only when udodge
    // reports EXPOSED (Fallback/Surrounded + stand covered) do we let the normal
    // predictive nexus run as the backstop.
    if (!ud.exposed) {
        // Publish an empty/negative threat list (or set a suppression flag the
        // client honors) so the nexus does not fire this scan.
        PublishThreats({}, GroundThreat{});   // or a dedicated suppressed publish
        return;
    }
}
```
Important nuances:
- **Ground damage is NOT suppressed.** Standing on damaging ground is a distinct
  hazard udodge's `safeWalk` may or may not be avoiding; keep the ground-threat
  path (`PredictGroundDamage`) running even when udodge is enabled and not
  exposed. Only the PROJECTILE threat list is gated by the exposure signal.
  Restructure so ground threats still publish while projectile threats are gated.
- **Staleness guard.** If `ud.tickId` has not advanced for several AutoNexus
  polls (udodge stalled / game thread hitched), treat udodge as NOT reliably
  handling it and fall back to the normal predictive nexus (do not suppress).
  Compare `ud.tickId` against a locally-remembered last value + a time budget.
- **udodge disabled** → unchanged behavior (full predictive nexus with real
  velocity — do not zero it).

### Divergence warning
The current code zeroes velocity for ALL udodge-enabled cases. The new contract
keeps velocity-zeroing (still correct — udodge re-steers so observed velocity is
not predictive) but ADDS suppression of projectile firing while udodge is
handling it. Do not remove the velocity-zeroing; the two work together.

## Steps

1. Add `UDodge::SafetyState` + `GetSafetyState()` to `UDodge.h`; back it with
   atomics in `UDodge.cpp` and populate them at the end of `Tick` (compute
   `standClr` once — it is already computed for the debug snapshot at
   `UDodge.cpp:594`; reuse it). On disable/reset, clear `exposed` and set
   `enabled=false`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. In `AutoNexus.cpp` `RunAutoNexus`, replace the blunt block
   (`AutoNexus.cpp:504-506`) with the contract: fetch `GetSafetyState`, keep
   velocity-zeroing when enabled, and gate the PROJECTILE threat scan/publish on
   `ud.exposed` (with the staleness guard). Keep the ground-threat path always
   running.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Restructure `RunAutoNexus` so a suppressed projectile scan still publishes
   ground threats (do not early-`return` before `PredictGroundDamage` +
   `PublishThreats`). Ensure the truncation/`s_prevPlayerX/Y` bookkeeping stays
   consistent when projectiles are skipped.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. In-game test (Release): with udodge ON dodging a stream, the nexus must NOT
   fire (no unwanted nexus while you visibly dodge). Then force a genuine failure
   (surround the player so udodge reports Surrounded / stand covered) — the nexus
   MUST fire. With udodge OFF, the nexus fires exactly as before this plan.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after each step.
- `bash internal/tools/check-raw-access.sh` → exit 0.
- In-game matrix: (a) udodge ON + dodging → no false nexus; (b) udodge ON +
  genuinely surrounded → nexus fires; (c) udodge OFF → unchanged nexus; (d)
  standing on damaging ground with udodge ON → ground nexus still works.
- `command grep -n "UDodge::GetSafetyState" internal/src/features/combat/autonexus/AutoNexus.cpp`
  returns the single consumption site; the old bare `UDodge::IsEnabled()`
  velocity-zero comment block is replaced.

## Out of scope
- Do NOT change the projectile hit-prediction math (`FindHitMsUntil`,
  `DodgeHit`) — only the FIRING GATE changes.
- Do NOT change udodge's solve logic — this plan only READS its outcome.
- Do NOT suppress ground-damage nexus.
- Do NOT add a new IPC channel; reuse the existing threat publish (an empty /
  suppressed publish is sufficient to prevent firing).
