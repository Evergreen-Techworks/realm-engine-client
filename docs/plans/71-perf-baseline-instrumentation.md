# 71 — Performance Baseline: Per-Phase Instrumentation + Release Honesty

## Goal
After this plan, `UDodge::Tick` and the pathfinder worker emit a **per-phase
timing breakdown** (map sync, occupancy rasterize, snapshot publish, solve,
debug publish; and worker ComputeDodge / ComputeNav), so the real cost of each
stage is known separately instead of one lumped "Tick avg=…ms" number. The plan
also establishes and records a **Release-build baseline** so all later perf work
is judged against honest numbers, not Debug overhead. This plan changes NO
gameplay behavior — it only adds measurement.

## Dependencies
None — parallel-safe (Wave A). Touches `UDodge.cpp` (adds timing scopes around
existing phases) and `UDodgePathfinder.cpp` / `UDodgeWorker.cpp` (worker
timing). Plans 73/74 also edit `UDodge.cpp`; because this plan only *adds* a
timing helper and scope guards around already-existing calls, a later rebase is
mechanical, but if dispatched concurrently with 73, land 71 first.

## Current state
The only timing probe today is a single lumped RAII timer in `UDodge::Tick`
(`UDodge.cpp:263-276`):

```cpp
struct TickTimer {
    LARGE_INTEGER t0;
    TickTimer() { QueryPerformanceCounter(&t0); }
    ~TickTimer() { /* ... logs avg/max ms every 120 ticks */ }
} _tickTimer;
```

It reports total Tick cost but cannot attribute it to a phase, so the two
suspected costs (the 2401-cell `FillOccGrid` and any per-frame reflection)
cannot be separated from the solve or the debug publish. The worker
(`Path::Compute`, `UDodgePathfinder.cpp:708`) has NO timing at all, so
ComputeDodge vs ComputeNav cost is unknown. There is no recorded Release-vs-Debug
baseline; grievance (c) notes the whole session was built Debug.

The distinct phases already exist as contiguous blocks in `UDodge::Tick`:
- NewTick sync: `UDodge.cpp:298-313` (`ReanchorMap` / `BuildMap`).
- Occupancy rasterize + publish: `UDodge.cpp:417-452` (`FillOccGrid`,
  `FillNavGrid`, `Worker::PublishSnapshot`).
- Solve: `UDodge.cpp:487-488` (and the mid-tick re-solve `499-524`).
- Debug publish: `UDodge.cpp:574-645`.

## Target design
Add a tiny, self-contained scoped-timer utility used only for diagnostics.

**Location:** a new anonymous-namespace helper inside `UDodge.cpp` (do not add a
new header — this is diagnostics local to the feature). Signature sketch:

```cpp
// Accumulates wall-clock into a named bucket; logs all buckets every N ticks.
// Game-thread only (static accumulators, no synchronization). Compiled in all
// configs but effectively free when the phase is small; the log cadence matches
// the existing 120-tick throttle so log volume is unchanged.
struct PhaseAccum { double sum=0, max=0; };
class PhaseTimer {           // RAII: start in ctor, stop+accumulate in dtor
    LARGE_INTEGER t0; PhaseAccum& bucket;
public:
    explicit PhaseTimer(PhaseAccum& b);
    ~PhaseTimer();
};
```

Buckets (static `PhaseAccum` in the anon namespace): `sync`, `raster`,
`publish`, `solve`, `debug`, plus the existing `total`. Every 120 ticks, emit
ONE `DBG_FILE_LOG` line with avg+max for each bucket, then reset. Keep the
existing lumped total line or fold it into this line — either way, one throttled
line per 120 ticks (no new log spam).

**Worker timing:** in `Path::Compute` (`UDodgePathfinder.cpp:708`), wrap
`ComputeDodge` and `ComputeNav` in `QueryPerformanceCounter` deltas and store
the two millisecond values into two new **plain-data diagnostic fields** on
`PlanResult` (`UDodgePathfinder.h:91`): `float computeDodgeMs = 0.f;` and
`float computeNavMs = 0.f;`. The game thread already logs `PlanResult` fields
every 120 ticks (`UDodge.cpp:460-471`) — add these two to that existing line.
This keeps all worker→game data flowing through the established plain-data
handoff (no shared clock, no lock).

**Release requirement (record, do not code):** the plan's verification step
requires building Release and recording the numbers. State in the code comment
on `PhaseTimer` that these numbers are only meaningful in Release.

Divergence warning: none — this is additive instrumentation. Do not delete the
existing behavior; if you replace the `TickTimer` struct, the replacement must
still emit a total.

## Steps

1. In `UDodge.cpp`, add the `PhaseAccum` / `PhaseTimer` helper to the anonymous
   namespace (near the top, by `Clamp`). Add static `PhaseAccum` buckets:
   `g_tSync, g_tRaster, g_tPublish, g_tSolve, g_tDebug, g_tTotal`. In
   `PhaseTimer::~PhaseTimer`, accumulate into the referenced bucket. Add a
   free function `LogPhasesEvery120()` that, on every 120th call, logs one line
   `"[UDodge] phase avg/max ms sync=.. raster=.. publish=.. solve=.. debug=.. total=.."`
   and resets all buckets.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

2. Replace the existing `TickTimer` (`UDodge.cpp:263-276`) with a
   `PhaseTimer total(g_tTotal);` at the top of `Tick`, and call
   `LogPhasesEvery120()` at the very end of `Tick` (or from `total`'s dtor
   sequencing — simplest: an explicit call as the last statement). Ensure early
   returns still record total (keep the RAII guard for total).
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

3. Wrap the NewTick sync block (`UDodge.cpp:298-313`) in
   `{ PhaseTimer _p(g_tSync); ... }`. Wrap the rasterize+publish block
   (`417-452`) in `PhaseTimer _p(g_tRaster);` for the two `Fill*` calls and a
   separate `PhaseTimer _p(g_tPublish);` around `Worker::PublishSnapshot`
   (split so the mutex-contended publish is separated from the rasterize CPU
   cost). Wrap the solve (`487-488` and the re-solve at `522`) in
   `g_tSolve`. Wrap the debug publish (`574-645`) in `g_tDebug`.
   Keep the scopes minimal — do not reorder any logic.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

4. In `UDodgePathfinder.h`, add `float computeDodgeMs = 0.f;` and
   `float computeNavMs = 0.f;` to `PlanResult` (diagnostics group, near
   `navPops`). In `UDodgePathfinder.cpp:708` `Compute`, time `ComputeDodge`
   and `ComputeNav` with `QueryPerformanceCounter` and store into those fields.
   (`<windows.h>` is available via the PCH; if not, include it.)
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

5. In `UDodge.cpp`, extend the existing worker-route log line
   (`UDodge.cpp:460-471`) with `" cDodgeMs=" << g_route.computeDodgeMs`
   and `" cNavMs=" << g_route.computeNavMs`.
   Build: `bash internal/tools/wsl-build.sh Debug` → 0 errors.

6. Build Release and record the baseline (this is the deliverable — write the
   numbers into the commit message or a scratch note, NOT a new source file):
   `bash internal/tools/wsl-build.sh Release`, copy
   `C:\rebuild\Release\bin\realm-engine.dll` → `client/assets/`, run the game
   with udodge on + a boss locked, and read the per-phase line from the DLL log.
   Record: sync / raster / publish / solve / debug / total avg+max, and
   cDodgeMs / cNavMs, with heatmap OFF and again with heatmap ON.

## Verification
- `bash internal/tools/wsl-build.sh Debug` → 0 errors after every step.
- `bash internal/tools/wsl-build.sh Release` → 0 errors.
- `bash internal/tools/check-raw-access.sh` → exit 0 (no new raw access; this
  plan adds only `QueryPerformanceCounter` timing and logging).
- In-game (Release): the DLL log shows one per-phase line per 120 ticks with
  all buckets populated and non-negative, and the worker line shows cDodgeMs /
  cNavMs. Total ≈ sum of phases (within measurement noise).
- Behavior parity: dodge behaves identically to before (this plan adds no
  gameplay logic). No new grep target — this is additive.

## Out of scope
- Do NOT change any dodge/solve/pathfinder logic, grid sizes, or heatmap draw.
- Do NOT remove the heatmap (that on-cost reduction is plan 74).
- Do NOT consolidate the grids (plan 73).
- Do NOT add a new shared header or a public timing API — keep the timer local
  to `UDodge.cpp` diagnostics.
