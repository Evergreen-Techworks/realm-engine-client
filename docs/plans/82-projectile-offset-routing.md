# 82 — Projectile Offset Routing: Fold the Private Speed-Mul Resolver into the Registry

## Goal
After this plan, `features/movement/dodge/ProjectileTracking.cpp` no longer contains a
private, parallel offset resolver for the projectile speed multiplier
(`HBEAKBIHANL::KDAJOMOFMJB`). The speed-mul offset is read through the self-healing
registry (`RuntimeOffsets::Hbeak_SpeedMul`), so it appears in OFFSET HEALTH and heals
after a game patch like every other offset. The two per-frame projectile offsets the
dodge trusts (speed-mul and `projRadius`) also gain a transition-only witness so a
stale/unresolved offset — which silently degrades prediction — becomes visible in the
log instead of invisible. Numeric output is unchanged: same field, same class, same
`il2cpp_field_get_offset`, same `0 = unresolved → speed-mul 1.0` behavior.

## Dependencies
- **Plan 80 must be merged first** — this plan reads `RuntimeOffsets::Hbeak_SpeedMul`,
  the table row 80 adds.
- Files touched: `features/movement/dodge/ProjectileTracking.cpp` **only**. Disjoint
  from plan 81, so the two run in parallel after 80. This plan's deletion of the
  private resolver is the precondition for plan 83's guardrail.

## Current state

`features/movement/dodge/ProjectileTracking.cpp`:
- `:40` `static const char* kHbeakSpeedMulFieldName = "KDAJOMOFMJB";`
- `:102` `std::atomic<uint32_t> g_hbeakSpeedMulFieldOff{ 0 }; // 0 = unresolved`
- `:104-115` the private resolver — the duplicate of the registry:
  ```cpp
  static void EnsureHbeakSpeedMulFieldOffset() {
      uint32_t cur = g_hbeakSpeedMulFieldOff.load(std::memory_order_relaxed);
      if (cur != 0) return;
      Il2CppClass* klass = ResolveProjClass();
      if (!klass) return;
      FieldInfo* fi = il2cpp_class_get_field_from_name(klass, kHbeakSpeedMulFieldName);
      if (!fi) return;
      const size_t off = il2cpp_field_get_offset(fi);
      if (off > 0u && off < 0x10000u)
          g_hbeakSpeedMulFieldOff.store(static_cast<uint32_t>(off), std::memory_order_relaxed);
  }
  ```
- `:117-136` `ComputeEffectiveSpeedMulFromInstance` calls
  `EnsureHbeakSpeedMulFieldOffset()` then reads
  `off = g_hbeakSpeedMulFieldOff.load(...)`, guards `off != 0u`, `Mem::TryRead`, and
  clamps `v` to `(1e-6f, 100.f)`; on any failure `inst = 1.f`.
- `:428` a second bare call to `EnsureHbeakSpeedMulFieldOffset();`
- projRadius is already registry-routed: `Hbeak_ProjRadius` read at `:608`
  (`TryReadProjRadiusFromInstance`) and in `ProjectileRuntimeReader.cpp:71`, both
  range-gated (a bad read fails closed) — but neither witnesses a stale offset.

This file lives under `features/movement/dodge/`, which `check-raw-access.sh` check 10
deliberately exempts, which is exactly why this private resolver has survived. This
plan removes the last `il2cpp_class_get_field_from_name` / `il2cpp_field_get_offset`
in the whole movement tree (confirmed: it is the only one).

## Target design

Behavior-preserving mapping (the registry gives the identical offset, resolved once
per frame from `dPresent` instead of lazily on first projectile — same value, resolved
at or before first use):

- Delete `kHbeakSpeedMulFieldName`, `g_hbeakSpeedMulFieldOff`, and
  `EnsureHbeakSpeedMulFieldOffset()` entirely.
- In `ComputeEffectiveSpeedMulFromInstance`, replace the private-offset read with the
  registry offset, preserving the exact `0 = unresolved → inst stays 1.0` guard and
  clamps:
  ```cpp
  static float ComputeEffectiveSpeedMulFromInstance(void* hbeakInstance)
  {
      float flashTune = ProjectileTracking::GetFlashSpeedMultiplier();
      if (!(flashTune > 0.01f) || flashTune > 50.f)
          flashTune = 1.f;

      float inst = 1.f;
      const uint32_t off = RuntimeOffsets::Hbeak_SpeedMul;   // 0 until registry resolves it
      WitnessSpeedMulOffset(off);                            // transition-only log (see below)
      float v;
      if (off != 0u && Mem::TryRead(hbeakInstance, off, v)) {
          if (std::isfinite(v) && v > 1e-6f && v < 100.f)
              inst = v;
      }

      float p = inst * flashTune;
      if (!(p > 1e-6f) || p > 100.f)
          return 1.f;
      return p;
  }
  ```
- Delete the second `EnsureHbeakSpeedMulFieldOffset();` call at `:428`.

### Transition-only witnesses (grep tag `[ProjectileTracking]`)
Add two file-scope statics and one helper. Each is an integer compare in steady
state; a `DBG_FILE_LOG` fires only on a state change. No per-frame disk writes.
```cpp
static int g_speedMulOffLogged = -1;   // -1 unknown, 0 unresolved, 1 resolved
static void WitnessSpeedMulOffset(uint32_t off) {
    const int now = (off != 0u) ? 1 : 0;
    if (now == g_speedMulOffLogged) return;
    g_speedMulOffLogged = now;
    if (now)
        DBG_FILE_LOG("[ProjectileTracking] speed-mul offset KDAJOMOFMJB resolved -> 0x"
            << std::hex << off << std::dec);
    else
        DBG_FILE_LOG("[ProjectileTracking] speed-mul offset KDAJOMOFMJB UNRESOLVED "
            "— using flashTune only (per-shot speed multiplier ignored)");
}
```
Optional (same pattern) for `projRadius`: witness when
`RuntimeOffsets::GetOffsetStateFor(&RuntimeOffsets::Hbeak_ProjRadius)` is a fallback/
suspect state at the read site in `TryReadProjRadiusFromInstance` (`:604-609`):
```cpp
static int g_projRadiusTrustLogged = -1;
// inside TryReadProjRadiusFromInstance, before the Mem::TryRead:
{
    const bool trusted = RuntimeOffsets::IsFieldWriteTrusted(&RuntimeOffsets::Hbeak_ProjRadius);
    const int now = trusted ? 1 : 0;
    if (now != g_projRadiusTrustLogged) {
        g_projRadiusTrustLogged = now;
        if (!trusted)
            DBG_FILE_LOG("[ProjectileTracking] projRadius HHFDCMIIIHF offset NOT metadata-resolved "
                "— hitbox radius may be stale for this build");
    }
}
```
(`IsFieldWriteTrusted` is a read-only state query here, not a write gate — it just
reports "resolved from live metadata".) This is observability only; the read path and
its range gate are unchanged.

## Steps

1. **Route the speed-mul read through the registry.** In
   `ProjectileTracking.cpp`: replace the body of
   `ComputeEffectiveSpeedMulFromInstance` (`:117-136`) to read
   `RuntimeOffsets::Hbeak_SpeedMul` as shown (keep the `WitnessSpeedMulOffset` call).
   Do NOT delete the private resolver yet — leave it unused for one compile so the
   diff is reviewable. Confirm `RuntimeOffsets.h` is already included (it is, via the
   existing `RuntimeOffsets::PosX` usage at `:142`). Build:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ```

2. **Add the witnesses.** Add `g_speedMulOffLogged` + `WitnessSpeedMulOffset` (and
   optionally the `projRadius` witness in `TryReadProjRadiusFromInstance`). Build (as
   above). Behavior unchanged; logs are transition-only.

3. **Delete the private resolver.** Remove `kHbeakSpeedMulFieldName` (`:40`),
   `g_hbeakSpeedMulFieldOff` (`:102`), `EnsureHbeakSpeedMulFieldOffset()`
   (`:104-115`), and its second call site (`:428`). Build + guardrail:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   bash internal/tools/check-raw-access.sh
   ```
   Expect 0 errors, guardrail exit 0.

## Verification
```bash
bash internal/tools/wsl-build.sh Debug        # 0 errors after every step
bash internal/tools/check-raw-access.sh       # exit 0
```
Grep — the private resolver is gone and the registry is the only source (must be empty):
```bash
command grep -n 'g_hbeakSpeedMulFieldOff\|EnsureHbeakSpeedMulFieldOffset\|kHbeakSpeedMulFieldName' internal/src/features/movement/dodge/ProjectileTracking.cpp   # -> empty
command grep -n 'il2cpp_field_get_offset\|il2cpp_class_get_field_from_name' internal/src/features/movement/dodge/ProjectileTracking.cpp                          # -> empty
command grep -n 'RuntimeOffsets::Hbeak_SpeedMul' internal/src/features/movement/dodge/ProjectileTracking.cpp                                                     # -> the new read
```
In-game (user Release deploy): projectile speed prediction (fast/slow shots landing on
target) is visually identical; Test → OFFSET HEALTH shows `HBEAKBIHANL::KDAJOMOFMJB`
resolving green in a realm; the log carries exactly one
`[ProjectileTracking] speed-mul offset KDAJOMOFMJB resolved -> 0x...` on first realm
entry.

## Out of scope
- Do NOT change the speed-mul clamp constants (`> 1e-6f`, `< 100.f`), the flashTune
  logic, or `GetFlashSpeedMultiplier`/`SetFlashSpeedMultiplier` — same math.
- Do NOT touch the positionAt (`GIBLKPDHLBG`) method resolver in
  `ProjectileTrajectory.cpp` — it is already metadata-first, fail-closed, and
  self-witnessing; leave it alone.
- Do NOT edit `RuntimeOffsets.*` (plan 80 owns the table row) or any collider file
  (plan 81).
- Do NOT alter `ProjectileStore.cpp` — its only offset use (`PosX`/`PosY` via
  `Mem::TryRead`, `:54-55`) is already sanctioned.
