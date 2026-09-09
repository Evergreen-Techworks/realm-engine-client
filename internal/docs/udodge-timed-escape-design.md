# UDodge timed escape — integrating the Spacetime planner

Design for stages 2 and 3 of the PR 60 adoption (see `udodge-safety-audit.md`
for the record of what shipped). Stage 1 folded the fork's sensor and capture
fixes into the shared UDodge sensors. The body below specifies stage 2, the
timed escape; the implementation record at the end covers stage 3, the per-update
movement allowance, and the two places the result deviates from the fork.

## Goal

Give UDodge the one capability its solver structurally lacks — a route that can
**wait, turn, and depart late** through moving projectiles — without giving up
any of the safety floors that make UDodge trustworthy.

## What UDodge cannot currently do

The immediate reflex evaluates ~131 candidate positions at one move budget and
picks the best that survives a temporal march. The grid pathfinder adds a
multi-tick lookahead, but it is a Dijkstra over static-ish cells: it routes
*around* obstacles toward a durable-safe area. Neither can express "stand still
for 180 ms, then move left as the gap opens, then turn". In a dense volley the
candidate set is empty and the solver drops to the least-bad fallback, which
minimises exposure but concedes hits.

## What the Spacetime planner is

A bounded search in control space over (position, time-layer) with continuous
coordinates, from the fork. Each expansion picks a velocity for a slice of the
step and checks the swept relative motion against every lane, enemy body, zone
and terrain edge. It optimises **latest departure** first, then least deviation,
then fewest turns — so it prefers plans that keep the player where they are for
as long as that is provably safe. It is pure math over UDodge's own plain-data
`MapInput`/`DangerMap`; it touches no game memory.

## Integration: an advisor, never an authority

The planner runs on the **existing UDodge worker thread**, on the same
plain-data snapshot the grid pathfinder already consumes. It publishes a
`Solver::TimedAdvice` alongside the grid plan. Nothing about the handoff is new:
the game thread never blocks, and a stale or missing advice degrades to today's
behaviour.

Inside `Solver::Solve` the advice is consumed in exactly one place — a new stage
between the grid pre-position step and the conservative reflex:

```
1  locked / no speed              → Surrounded
2  build temporal context
3  stand-durability test
4  walk-to direct step            → return if safe
5  HOLD                           → return if the stand is durable
6  pre-position along grid route  → return if its step passes every floor
6b TIMED ESCAPE (new)             → return if its step passes every floor
7  conservative reflex            → return if any candidate is admitted
8  fallback (least-bad)
```

Stage 6b runs only when the stand is not durable **and** stage 6 did not return
— that is, precisely the situations where UDodge previously fell through to the
reflex or the fallback. It can therefore only replace an outcome that was
already conceding ground.

The advice is withheld entirely during a commanded walk-to: that path owns
direction, and it already defers to the reflex for dodging. It is also subject to
the same publish-sequence freshness rule as the grid route, so an advice computed
for a snapshot too many publishes back is dropped rather than steered by.

### The gate

The advice contributes a **step target and nothing else**. Before it can be
driven it must pass, unchanged, the same hard floors the grid route step passes:

- `CanOccupyAt` — walls and (when safe-walk is on) damaging ground
- `OccupancyPathClear` — the swept version of the above
- `!Core::EnemyPathBlocked` — enemy bodies, swept
- `Core::ZonePathClear` — active blast discs, swept
- `Core::Temporal::PathClear` — UDodge's own temporal march

If any floor rejects it, the advice is discarded and control falls through to
stage 7 exactly as today. The planner cannot widen admission, cannot cross a
wall, and cannot authorise a step UDodge's own march calls unsafe.

### Waiting

A plan whose first slice deliberately waits is honoured **only** when UDodge's
own dwell test says the current stand survives its dwell window
(`Temporal::DwellClear` at `kUDwellMs`). That is the identical admission test
every candidate must pass, so honouring a wait never holds the player somewhere
the solver would refuse to send them. If the stand fails that test the advice is
dropped and the reflex runs, because moving now is mandatory.

### Consistency of the contact model

`SpacetimeDodge::ProjectileRadius` is fed from `Core::ProjectilePlayerHalf` and
the position-uncertainty setting, so the planner and the authoritative floors
agree on the hit box by construction. A planner that were more permissive than
the floor would merely waste work (its plans get rejected at the gate); one more
conservative would find fewer routes. Neither is unsafe, but agreeing avoids
both.

### Zones

The planner accepts explicitly timed blast discs. UDodge's `DangerMap` carries
active/pending discs without arm timing, so the integration passes **no** timed
zones and lets the planner fall back to its active-zone rule, which matches
`Core::ZonePathClear`. Pending telegraphs stay UDodge's soft score, unchanged.
Timed-zone escape is a later increment, not part of this stage.

### Nominal intent

The planner models movement the host would perform anyway as `nominal`. UDodge
owns movement outright — it drives `MoveTo` toward its own target every frame —
so `nominal` is zero. That makes the planner's "tail" test ("is standing here
safe to the horizon?") identical in meaning to UDodge's stand-durability test,
and makes every plan a pure deviation from standing still.

## Shared type additions

The planner needs three facts the fork added to the shared sensor output. All
are additive and default to today's behaviour:

| Field | Meaning | Default |
|---|---|---|
| `LaneThreat::damageEstimate` | per-shot damage, for least-damage recovery ranking | `-1` (unknown) |
| `LaneThreat::hasLinearMotion` / `linearVelocity` | runtime-verified constant motion, so a straight shot may be projected past its traced samples | `false` |
| `EnemyBlocker::passiveScenery` | static scenery, distinguished from a live mob | `false` |
| `Settings::enemyAvoidanceScale` | scales the enemy keep-out radius | `1.0` (identical to today) |

`hasLinearMotion` is deliberately conservative: it is set only when the traced
polyline is verifiably a straight constant-velocity line, so packet guesses and
curved models can never authorise extrapolation beyond what was observed.

## Testing

A new host suite (`udodge_timed_tests.cpp`) drives the production solver and the
production planner:

- verified-linear-motion detection accepts a straight constant-speed polyline and
  rejects a bend, an acceleration, a stalled clock and a non-finite sample
- the enemy keep-out radius scales for live mobs and never for scenery
- the planner input agrees with UDodge's horizon and dwell, models the player as
  standing still, and invents no timed zones
- an empty map leaves the stand clear and produces no advice
- advice conversion covers every planner status, including the ones that must
  advise nothing (`Clear`, `Recovery`, `NoPlan`, `Incomplete`, `Locked`)
- against a swept stand, a safe advice is driven and clamped to one move budget,
  while a wall, an enemy body, an active blast and a temporally unsafe step are
  each rejected independently
- a wait is honoured while the stand survives its dwell window and refused once
  it does not
- an absent or invalid advice leaves the solve bit-identical to today's

The existing six suites must stay green, since stage 6b is unreachable in every
scenario they cover that already returns at stages 4 through 6.

## Risks

The planner allocates (`std::vector`, `unordered_map`, `priority_queue`) inside
its search. That is acceptable on the worker thread and unacceptable on the game
thread, which is why the integration is worker-only. Its search is bounded by
both an expansion count and a wall-clock budget, and a budget-exhausted search
publishes no advice rather than a partial one.

The honest limit is unchanged from UDodge's own: when the reachable disk is
fully covered, no planner can promise zero hits. This stage widens the set of
situations where a covered disk still has a timed way out; it does not remove
the bound.

---

## Implementation record

Stages 2 and 3 are implemented as described above, with two deliberate
deviations from the fork.

**Contact model.** The fork gates its point-player hit box behind a
`projectileCollisionThreshold` capture flag used only by its own mode. UDodge
had already adopted the point-player model outright (`Settings::pointPlayer`),
so `SpacetimeDodge::ProjectileRadius` is fed from `Core::ProjectilePlayerHalf`
instead. Planner and floors share one definition of the hit box.

**Stage 3 actuation.** The fork installs a MinHook on the game's `MoveTo` so
automated movement can *replace* manual input. UDodge overrides movement
outright, so the half that matters here is the accounting, not the replacement:
without it the game's own input step and UDodge's step both land in the same
update and the player travels up to twice the validated distance.

That accounting is implemented **observationally** in `MovementRuntime`
(`BeginMovementFrame` / `EndMovementFrame`) rather than through a new hook. It
records the position after each command and measures the displacement before the
next one, charging that travel against the update's allowance
(`MovementFrameBudget.h`). The measurement is equivalent for this purpose, costs
no new detour on a hot virtual method, and fails safe: when the position or
speed cannot be read the caller keeps its previous per-frame clamp, so the change
can only ever tighten a step, never widen one.

Charging is **partial**, not all-or-nothing. A player holding a direction
consumes part of the allowance and UDodge spends what is left — zeroing it would
disable steering exactly when it is most needed. A displacement larger than two
maximum frames is treated as a discontinuity (teleport, portal, or ticks where
the dodge did not run) and charged as nothing.

The input-replacement filter itself is **not** adopted. It exists to preserve
safe manual movement, which is the fork mode's design goal and not UDodge's.

## Verification

Seven host suites pass (235 checks). Windows Debug and Release both build with
zero warnings and zero errors, and the raw-access lint is clean.

Not verified: live behaviour. Synthetic regressions and a clean compile say
nothing about collision timing against a real server. The timed stage and the
movement allowance both need in-game testing before they can be called good.
