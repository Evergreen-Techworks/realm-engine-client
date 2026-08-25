# 79 — Dodge Reliability Overhaul: Overview & Index

This is the **index and design-of-record** for a focused reliability/observability
pass over the RotMG auto-dodge subsystem's raw-offset dependencies. It is **not**
itself executable. Plans 80–83 are each self-contained and executable by a single
`abstraction-implementer` agent with no context beyond its own file.

This series (79+) **continues** the movement-safety consolidation of plans 70–78.
It is scoped strictly to dodge **reliability plumbing + observability** — it is
**behavior-preserving**: the same offsets are resolved, now verified, logged, and
fail-closed. It does **not** change dodge solver math, tightness, or the
"never get hit" geometry (that is a separate accuracy phase).

## Scope (strict)

IN SCOPE:
- The collider hitbox feature `internal/src/features/movement/collider/`
  (`PlayerCollider.{h,cpp}`) and the collision-multiplier offset it writes.
- The projectile-prediction dependencies the dodge trusts every frame:
  `internal/src/features/projectiles/` (ProjectileStore, ProjectileTrajectory,
  ProjectileRuntimeReader) and
  `internal/src/features/movement/dodge/ProjectileTracking.{h,cpp}` — specifically
  the raw offset/field-resolution sites (positionAt `GIBLKPDHLBG`, projRadius
  `HHFDCMIIIHF`, speed multiplier `KDAJOMOFMJB`).
- Integration with the existing self-healing offset registry
  `internal/src/core/runtime/RuntimeOffsets.{h,cpp}` — work ROUTES THROUGH / EXTENDS
  it, never a parallel system.

OUT OF SCOPE (do not touch): killaura/aimbot, outbound PLAYERSHOOT, autofire,
auto-break-walls, Disguise, dodge SOLVER MATH / tightness, and any change to
`udodge/` search or geometry. udodge is in scope ONLY as a passive consumer of the
offsets/predictions fixed here — this series does not edit `udodge/` files.

## How the dodge subsystem works today (offset-dependency model)

**Offset registry (the shared layer that already exists).**
`core/runtime/RuntimeOffsets.{h,cpp}` is a table-driven, self-healing IL2CPP
field-offset registry. `EnsureAll()` runs once per frame from `dPresent`. For each
table row it resolves the class by (BeeByte-obfuscated) name, then the field by name
up the class hierarchy (`FindFieldOnHierarchy`, `RuntimeOffsets.cpp:237`), and
overwrites a pre-initialised fallback constant with the live
`il2cpp_field_get_offset` value (`RuntimeOffsets.cpp:691`). The resolved value is the
**raw boxed** offset (header-inclusive; the engine does NOT subtract
`sizeof(Il2CppObject)`), which is exactly how our feature reads via `Mem::TryRead`
address it. Each row gets an `OffsetState` (`RuntimeOffsets.h:44`):
`ResolvedMatch` / `ResolvedShifted` (came from live metadata — trustworthy),
`FallbackFieldName` / `FallbackGaveUp` (name never resolved — STALE fallback in use),
`Suspect` (failed a live sanity check), `Pending`. These surface in the in-game
Test → OFFSET HEALTH panel. **This is metadata-first resolution with a constant only
as a declared fallback — the target discipline is already the house style; the gaps
below are places that escape it.**

**Collider.** `PlayerCollider::Tick(player)` (`PlayerCollider.cpp:197`) is driven
once per frame by `LocalPlayer::Tick()` (`LocalPlayer.cpp:218`), which is called from
`DirectX.cpp:184` (`dPresent`). It collects the player's `ObjectProperties` instances
(base / map-object / player-collision offsets) and forces their
`collisionRadiusMultiplier` float to `g_multiplier` (0), reading/writing through
`RuntimeOffsets::OP_CollRadiusMult` via `Mem::TryRead`/`Mem::TryWrite`
(`PlayerCollider.cpp:74`, `:79`). It already implements capture-original /
restore-on-disable correctly (`TrackedProperty`, `RestoreTrackedColliders`,
`ForgetTrackedColliders`; only a finite non-zero read is accepted as the genuine
original, `PlayerCollider.cpp:255`). TestTAB reads the same multiplier for a debug
readout via `RuntimeOffsets::OP_CollRadiusMult` (`TestTAB.cpp:244`, `:259`).

**Projectile prediction (trusted every frame by the dodge).**
- `positionAt` (`HBEAKBIHANL.GIBLKPDHLBG`): resolved once by IL2CPP-method scan in
  `ProjectileTrajectory.cpp:30` (`GetPosAtMethod`), cached, SEH-wrapped, and it
  **already logs its resolve path once** and falls back to straight-line on failure
  (fail-closed + self-witnessing — compliant).
- `projRadius` (`HBEAKBIHANL.HHFDCMIIIHF`): table row `Hbeak_ProjRadius`
  (`RuntimeOffsets.cpp:448`), read via `Mem::TryRead` with a range gate
  (`ProjectileRuntimeReader.cpp:71`, `ProjectileTracking.cpp:608`) — routed and
  range-checked (a bad read fails closed), but its stale-fallback state is not
  witnessed at the consumer.
- speed multiplier (`HBEAKBIHANL.KDAJOMOFMJB`): **resolved by a PARALLEL, private
  resolver inside feature code** — `EnsureHbeakSpeedMulFieldOffset()`
  (`ProjectileTracking.cpp:104`) calls `il2cpp_class_get_field_from_name` +
  `il2cpp_field_get_offset` into its own atomic `g_hbeakSpeedMulFieldOff`
  (`ProjectileTracking.cpp:102`), with its own `0 = unresolved` semantics and its own
  bounds. It is NOT in the RuntimeOffsets table, so it never appears in OFFSET HEALTH
  and never self-heals through the registry. This is the one true offset-resolution
  duplicate in scope.

## Reliability gaps found (against the 5 target patterns)

1. **Metadata-first, constant only as fallback.**
   - **DEFECT (known):** `OP_CollRadiusMult` fallback is `0x780`
     (`RuntimeOffsets.cpp:142`, `RuntimeOffsets.h:326`). In the generated layout
     `ObjectProperties` (`il2cpp-types.h:13539`) the field order is
     `questBarYOffset` (float) → `hasAnimationFrame` (bool + 3 pad = 8 bytes) →
     `collisionRadiusMultiplier` (float). `0x780` is `questBarYOffset` boxed;
     `collisionRadiusMultiplier` is `0x788` boxed. The live metadata path normally
     corrects this (the row currently reports `ResolvedShifted` 0x780→0x788), but on
     a give-up/rename the collider would write **0 onto a quest-bar UI float** and the
     before/after log would look perfect — the exact sibling-fork bug. Fix the
     fallback to the correct boxed value.
   - **DUPLICATE:** the `KDAJOMOFMJB` speed-mul resolver
     (`ProjectileTracking.cpp:104-115`) is a second, private metadata-first path
     outside the registry. Fold it into the table.

2. **Fail-closed; know which offsets fail OPEN.** The collision multiplier is a
   **float WRITE** — it fails OPEN (a wrong offset writes successfully onto some other
   valid, writable float → silent corruption). `PlayerCollider` writes via
   `Mem::TryWrite(OP_CollRadiusMult, 0)` with **no check that the offset was actually
   resolved from live metadata** (vs a stale fallback). Gap: refuse the write (and the
   original-capture) unless the offset is registry-trusted, with rate-limited logging.

3. **Self-witnessing / transition-only logging.** `PlayerCollider` has a `logFn`
   hook (`PlayerCollider.h:9`) but `Tick()` never passes one — nothing logs. "The
   collider works" and "the collider's code is never reached" look identical. Gap: add
   transition-only logs for the offset PATH, ARMED/disarmed edges, and
   `targets found=0`. projRadius stale-state is likewise unwitnessed at the consumer.

4. **Liveness stamp.** `PlayerCollider` owns no hook of its own; it is alive only
   because `LocalPlayer::Tick()` calls it. If that call were deleted it would keep
   compiling and its knobs would keep responding, but it would never apply. Gap: stamp
   `GetTickCount64()` at the top of `Tick()`, expose `LastTickMs()`, and surface
   "ticked recently" in the diag panel. (Precedent: `DangerPlanner::GetLastTickMs()`,
   `DangerPlanner.cpp:1073`.)

5. **Capture-original / restore-on-disable.** `PlayerCollider` **already implements
   this correctly** (per-object original keyed by pointer, restore on disable, forget
   on scene change, only-accept-finite-non-zero capture). The only residual risk is
   that capture reads the same possibly-stale offset — closed by the pattern-2 write/
   capture gate in plan 81. No standalone work.

## Target design (seams)

Everything routes through the existing registry plus one small **shared trust helper**
that lives in the sanctioned core home `core/runtime/RuntimeOffsets`. We do **not**
port the sibling fork's full `Ac2Bindings` uniqueness engine (YAGNI) — the registry's
existing name-resolution + state tracking already provides the equivalent signal.

New shared API (added in plan 80, in `RuntimeOffsets.{h,cpp}`):
```cpp
namespace RuntimeOffsets {
    // Health state for a specific offset variable (reverse lookup by address,
    // same mechanism MarkSuspect already uses). Pending if the var is not a
    // table entry.
    OffsetState GetOffsetStateFor(const uint32_t* offsetVar);

    // Fail-closed gate for FLOAT WRITES: true ONLY when the offset was resolved
    // from live IL2CPP metadata this session (ResolvedMatch or ResolvedShifted).
    // Fallback / Suspect / Pending -> false -> caller must REFUSE the write.
    bool IsFieldWriteTrusted(const uint32_t* offsetVar);
}
```

## Plans and dependency graph

| Plan | File | Content | Depends on |
|---|---|---|---|
| 80 | `80-runtimeoffsets-reliability-foundation.md` | Fix `OP_CollRadiusMult` fallback 0x780→0x788; add `Hbeak_SpeedMul` (KDAJOMOFMJB) table row; add `GetOffsetStateFor` + `IsFieldWriteTrusted` trust helper. Foundation. | none |
| 81 | `81-collider-reliability.md` | Route collider writes/captures through the write-trust gate (fail-closed float write); transition-only logging (offset path, ARMED edges, targets=0); liveness stamp `LastTickMs()` + Test panel surface. | 80 |
| 82 | `82-projectile-offset-routing.md` | Delete the private `KDAJOMOFMJB` resolver; read speed-mul through `RuntimeOffsets::Hbeak_SpeedMul`; add transition-only witness for a stale `projRadius`/speed-mul offset. | 80 |
| 83 | `83-field-resolution-guardrail.md` | Extend `check-raw-access.sh` to forbid `il2cpp_field_get_offset` in `features/`, closing the movement-dir exemption once the duplicate is gone. | 82 |

```
Wave A:        80
Wave B:     81    82     (parallel — disjoint files, both depend only on 80)
Wave C:           83     (after 82: the grep can only be zero once 82 removes the code)
```

- **80** is the foundation: it edits only `RuntimeOffsets.{h,cpp}` and is a hard
  dependency for 81 (needs the trust helper + corrected fallback) and 82 (needs the
  `Hbeak_SpeedMul` row). No behavior change on its own.
- **81** (touches `PlayerCollider.{h,cpp}` + `gui/tabs/TestTAB.cpp`) and **82**
  (touches only `features/movement/dodge/ProjectileTracking.cpp`) are file-disjoint
  and run in parallel after 80.
- **83** (touches only `internal/tools/check-raw-access.sh`) must land after 82,
  because its new grep must return zero and it only can once 82 deletes the private
  resolver.

## Behavior-preservation contract (every plan)

This is a reliability refactor. After every step the DLL must compile and behave
identically in the field:
- 80's fallback change is inert in the happy path — live metadata already resolves
  `collisionRadiusMultiplier` to 0x788 today (the row reports `ResolvedShifted`), so
  the running value is unchanged; only the give-up/rename failure mode is corrected.
  The new trust API is unused until 81 calls it.
- 82 resolves the same field (`KDAJOMOFMJB`) on the same class via the same
  `il2cpp_field_get_offset`, with the same `0 = unresolved → speed-mul 1.0` fallback
  behavior the consumer already applies — identical numeric output.
- 81's gate only ever REFUSES a write that today would land on an unverified offset;
  in the happy path (offset trusted) it writes exactly as before.

## Global verification (run after EVERY step of EVERY plan)

```bash
# From the repo root (/home/jesse/realm-engine-client):
# Build (Debug — fast compile check; must be 0 errors after every step):
bash internal/tools/wsl-build.sh Debug

# Raw-access guardrail (must stay exit 0 — no new raw IL2CPP in features/gui):
bash internal/tools/check-raw-access.sh
```

In-game verification (user's Release deploy via `dev-build.bat release`): open
Test → OFFSET HEALTH and confirm `ObjectProperties::collisionRadiusMultiplier` and
`HBEAKBIHANL::KDAJOMOFMJB` are green (ResolvedMatch/Shifted), and the collider/
projectile behavior (hitbox shrink, curved-shot prediction) is visually unchanged.

## Branch / files owned by concurrent work

All commits go on the current branch (`refactor/unified-gameapi`). The pre-existing
uncommitted edits to `client/build-tools/*.bat`, `client/scripts/build-prod.mjs`, and
the untracked `client/assets/*.exe`/`*.dll` are NOT part of this series — do not stage,
revert, or commit them.
