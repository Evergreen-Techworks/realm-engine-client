# 06 — Migrate `features/projectiles/**` to `Mem::`

## Goal
The projectile subtree — the single densest cluster of raw field reads in the
codebase (~45 read sites across `ProjectileRuntimeReader`, `ProjectileStore`,
`ProjectileTrajectory`) — reads all IL2CPP memory through `Mem::` and uses
`Mem::AddrOk` instead of its 3 local copies. Behavior identical; this is a pure
mechanical read-path swap (no container walks or hooks live here).

## Dependencies
MUST merge first: **01** (`Mem`). Does NOT need 02 or 03 (no dict walks, no
hooks in this subtree). Parallel-safe against 04/05/07/08 — touches ONLY
`features/projectiles/**`.

## Current state
Files: `ProjectileRuntimeReader.cpp`, `ProjectileStore.cpp`,
`ProjectileTrajectory.cpp` (+ their headers).

### Local `AddrOk` copies (3) — replace with `Mem::AddrOk`
- `ProjectileRuntimeReader.cpp:12`
- `ProjectileStore.cpp:49`
- `ProjectileTrajectory.cpp:70`

### Raw reads (~45) — replace with `Mem::TryRead`/`ReadOr`
Authoritative list:
```
grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/projectiles/
grep -rnE '\*\s*\(\s*(const\s+)?(float|int32_t|uint32_t|int|bool|uint8_t|void\s*\*)\s*\*\s*\)' internal/src/features/projectiles/
```
These read `ProjectileProperties` / `HBEAKBIHANL` fields
(`PP_Speed`, `PP_Lifetime`, `Hbeak_Angle`, `Hbeak_InstanceDamage`, …). Many are
in the per-frame `ComputePosAt` / trajectory path — see hot-path note.

## Target design
Same mechanical rules as plan 04:
```cpp
// before
float life = *reinterpret_cast<float*>(props + RuntimeOffsets::PP_Lifetime);
bool  wavy = *reinterpret_cast<bool*>(props + RuntimeOffsets::PP_IsWavy);
// after
float life = Mem::ReadOr<float>(props, RuntimeOffsets::PP_Lifetime, 0.0f);
bool  wavy = Mem::ReadOr<bool>(props, RuntimeOffsets::PP_IsWavy, false);
```
Pick the fallback that reproduces today's behavior: if the current code reads
into a value that is used unconditionally, use a neutral default (`0`/`false`);
if the code already null-checks `props` before reading, keep that check and use
`Mem::TryRead` returning early on failure.

**Hot-path note:** `ProjectileTrajectory::ComputePosAt` and the reader run per
projectile per frame. `Mem::ReadOr`/`TryRead` are `inline` and emit the same
load the manual cast does (the x64 SEH frame is zero-cost when no exception
fires), so there is no regression. **Do not** batch-read behind a new struct
copy — keep the field-by-field reads to preserve the exact same access pattern.
Where a tight loop already sits inside one `__try` block and reads many fields
of the *same validated pointer*, you MAY keep raw `*reinterpret_cast` **inside
that guarded block** if converting each to `Mem::TryRead` measurably changes the
generated loop — but default to `Mem::` and only keep raw reads where a comment
explains the hot-loop guard. State which you chose per file.

## Steps
1. `ProjectileStore.cpp`: AddrOk + reads. Build.
2. `ProjectileRuntimeReader.cpp`: AddrOk + reads. Build.
3. `ProjectileTrajectory.cpp`: AddrOk + reads (hot path — follow the note). Build.
4. Full build both configs.

Each: `msbuild internal/il2cpp-dll-injection.sln /p:Configuration=Release /p:Platform=x64`.

## Verification
- Both configs build, no new warnings.
- `grep -rn 'bool AddrOk' internal/src/features/projectiles/` → empty.
- `grep -rn 'reinterpret_cast<[^>]*>([^;]*RuntimeOffsets::' internal/src/features/projectiles/`
  → empty (or only lines inside an explicitly-commented hot-loop guard, if the
  implementer kept any — list them in the PR description).
- Runtime smoke: projectile prediction / dodge lines still track shots correctly
  (Test tab AoE probe unchanged).

## Out of scope
- Projectile math (Flash-parity `positionAt`, wavy/boomerang/turning formulas) —
  behavior-preserving only.
- `RuntimeOffsets` PP_* / Hbeak_* fallback values — do not retune them.
- Files outside `features/projectiles/`.
