# features/combat/autoaim — the aim/shoot system

This directory is the **whole** aim/shoot family. `AutoAim`, `KillAura`,
`AutoFire` and `AutoBreakWalls` used to live in four sibling directories
(`autoaim/`, `killaura/`, `autofire/`, `autobreak/`), but they were already one
system by dependency — `KillAura` cannot run without `TargetSelector`,
`AutoFire` cannot run without `ShootRuntime`, and both of those already lived
here. `docs/plans/106` moved the four together and split them into four groups
by role:

| group | role |
|---|---|
| `core/` | shared computation. No hooks, no enable flag, no state machine. |
| `shoot/` | the only group that binds, calls or detours an IL2CPP method. |
| `modes/` | the user-facing behaviours. One enable flag + one `Tick()` each. |
| `ui/` | the ImGui panels, `namespace CombatTAB::`. |

**Every module keeps its own enable flag, its own `Tick()` and its own logic.**
There is deliberately **no** shared feature base class, CRTP mixin, virtual
`IFeature` or tick registry: the render-thread hot path does not need the
indirection and `CombatTAB::Tick` has no dispatch boilerplate to remove. That
was examined and rejected in `docs/plans/96-overview.md` ("What was considered
and deliberately NOT unified"); the rejection still stands. Directories are not
namespaces here — `AutoAim::`, `KillAura::`, `TargetSelector::` and the rest are
unchanged by the grouping.

## Layout

```
autoaim/
├── core/     AimMath.{h,cpp}  WeaponProfile.{h,cpp}  TargetSelector.{h,cpp}
├── shoot/    AimHooks.{h,cpp}  ShootRuntime.{h,cpp}  ProjNoclip.{h,cpp}
├── modes/    AutoAim.{h,cpp}  KillAura.{h,cpp}  AutoFire.{h,cpp}
│             AutoBreakWalls.{h,cpp}
└── ui/       FeatAutoAim.{h,cpp}  FeatMagnetAim.{h,cpp}
```

## Dependency graph

```
                    ui/FeatAutoAim ──────┐
                    ui/FeatMagnetAim     │ (panels; toggle + render only)
                                         v
  modes/AutoBreakWalls ──> modes/KillAura ──> core/TargetSelector ──> core/AimMath
        │                        │                   │
        │                        │                   └──> core/WeaponProfile
        │                        └──> shoot/AimHooks (via modes/AutoAim)
        │
        └──────────────> modes/AutoFire ──> shoot/ShootRuntime

  modes/AutoAim ──> core/TargetSelector, core/WeaponProfile, shoot/AimHooks
  ui/FeatAutoAim ──> modes/AutoAim, shoot/ProjNoclip
```

Concretely (file:line at the time of the move):

```
modes/AutoBreakWalls.cpp:106,175  → KillAura::SetForcedTargetId(...)   raw-access-ok
modes/AutoBreakWalls.cpp:107,176  → AutoFire::SetAutoEngage(...)
modes/KillAura.cpp:181            → TargetSelector::SelectKillAura(...)
modes/AutoFire.cpp:113,155,162    → ShootRuntime::EnsureResolved /
                                    TryComputeShootAngle / CallShootWithAngle
modes/AutoAim.cpp:67,103,115      → AimHooks::SetTarget / AimHooks::Install
```

`movement/dodge/ProjectileTracking.cpp` used to call
`KillAura::GetAuthoritativeInput(...)` to arm the local-bullet displacement. That
hook is deleted and the call with it, so the origin now leaves the DLL only over
the `aim` IPC payload — see the measured-result block atop `modes/KillAura.cpp`.

## Entry points

| what | where |
|---|---|
| `AutoAim::Tick()` — per-frame entity walk | `platform/hooks/DirectX.cpp:193` |
| `FeatAutoAim` / `FeatMagnetAim` / `KillAura` / `AutoFire` / `AutoBreakWalls` ticks | `gui/tabs/CombatTab/CombatTAB.cpp:25-29` |
| IPC feature keys (`autoAimEnabled`, `killaura*`, `autoFire*`, `autoBreakWalls*`, `projectileNoclipEnabled`) | `features/control/FeatureCommandRegistry.cpp:104-123` |
| Hook teardown (`ProjNoclip::Uninstall`, `AutoAim::Uninstall`) | `platform/hooks/InitHooks.cpp:94,96` |

## Include rule

Always the full `src`-relative subpath, from anywhere — including from a
sibling file inside this directory:

```cpp
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"
```

The bare form (`#include "TargetSelector.h"`) used to work only because <!-- raw-access-ok -->
`$(ProjectDir)src\features\combat\autoaim` sat in
`<AdditionalIncludeDirectories>`. That entry is gone. **Check 19** in
`internal/tools/check-raw-access.sh` fails the build-and-test wrapper on a
bare-name include of any autoaim header, and on any path naming a retired
`killaura/`, `autofire/` or `autobreak/` directory.

## Guardrail invariants

- **Check 13** — only `shoot/AimHooks.cpp` (which HOOKS the shoot methods) and
  `shoot/ShootRuntime.cpp` (which RESOLVES and CALLS them) may name the
  shoot-method tokens. A third site means someone re-bound the shoot path
  privately instead of routing through those two.
- **Check 14** — only `modes/AutoBreakWalls.cpp` may call
  `KillAura::SetForcedTargetId`. <!-- raw-access-ok --> The forced-target override has exactly one
  owner; a second caller would silently fight it for the target. Co-location in
  `modes/` makes a second caller *more* tempting, not less — the check stays.
