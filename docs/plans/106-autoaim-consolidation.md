# 106 — Consolidate killaura / autofire / autobreak into ONE autoaim system

## Goal

After this plan there is exactly **one** aim/shoot feature family on disk:
`internal/src/features/combat/autoaim/`, internally grouped into `core/`,
`shoot/`, `modes/` and `ui/`. The three sibling directories
`features/combat/killaura/`, `features/combat/autofire/` and
`features/combat/autobreak/` are gone — their translation units live under
`autoaim/modes/` alongside `AutoAim`, which is where their real dependencies
already pointed. Every include of an autoaim header is an explicit
`features/combat/autoaim/<group>/<Header>.h` subpath (the repo convention stated
in `internal/CLAUDE.md`), and the implicit
`$(ProjectDir)src\features\combat\autoaim` entry in `AdditionalIncludeDirectories`
— the thing that made `#include "TargetSelector.h"` resolve from a totally
different directory — is deleted. A new guardrail check makes the old bare-name
form and the retired directories impossible to reintroduce.

**This is a MECHANICAL MOVE + REWIRE. Zero behavior change.** Every module keeps
its own translation unit, its own enable flag, its own `Tick()`, its own
`RenderSettings()`, and its exact current logic. Do not merge any two modules.
Do not introduce a shared feature base class or a dispatch registry — the prior
review (`docs/plans/96-overview.md`, "What was considered and deliberately NOT
unified") examined and rejected that, and the rejection still stands.

**This is a C++ plan.** It builds the DLL, so it must not run concurrently with
any other C++ plan (`internal/tools/wsl-build.sh` writes to a shared
`C:\rebuild\<Config>` directory).

## Dependencies

Plans that MUST be merged first:

- **104 (build-tooling-and-dead-code-hygiene)** — 104 repairs
  `internal/il2cpp-dll-injection.vcxproj.filters` (14 missing entries, 2 phantom
  entries) and deletes the dead `#include "FeatMagnetAim.h"` from
  `ProjectileTracking.cpp`. This plan renames paths *inside* that file. Running
  106 first guarantees a conflict and would also mean rewriting entries 104 is
  about to add.
- **105 (failclosed-gate-coverage)** — 105's plan text cites
  `internal/src/features/combat/autoaim/AimHooks.cpp:126-127` by its **current**
  path. Its implementer has no other context. Moving `AimHooks.cpp` before 105
  runs would send that implementer to a file that no longer exists. 106 is the
  **last** plan in the C++ queue.

Slot in the 96-series execution order: `99 → 100 → 101 → 102 → 103 → 104 → 105 →
**106**`.

Files this plan touches that other plans also touch:

- `internal/il2cpp-dll-injection.vcxproj` and `.vcxproj.filters` — plans 99, 101,
  102, 104. Land after all of them.
- `internal/tools/check-raw-access.sh` — plans 100, 101, 102, 103, 104 all append
  checks. **Read the file before editing; do not reconstruct it from this
  document.** This plan edits checks 13 and 14 in place and appends check 15.
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` — plans 100, 101,
  103, 104.
- `internal/src/features/combat/autoaim/AimHooks.cpp`,
  `internal/src/gui/tabs/TestTAB.cpp` — plan 105.
- `internal/src/features/combat/autoaim/TargetSelector.{h,cpp}` — modified in the
  working tree right now (uncommitted Phase 1–3 work). Expected; `git mv`
  preserves uncommitted content.

## Current state

### The four directories are already one system

Verified dependency graph (read the files, do not assume):

```
autobreak/AutoBreakWalls.cpp:106,175  → KillAura::SetForcedTargetId(...)
autobreak/AutoBreakWalls.cpp:107,176  → AutoFire::SetAutoEngage(...)
autobreak/AutoBreakWalls.cpp:5,6      → #include killaura/KillAura.h, autofire/AutoFire.h
killaura/KillAura.cpp:183             → TargetSelector::SelectKillAura(...)   [lives in autoaim/]
killaura/KillAura.cpp:5,6             → #include "TargetSelector.h", "WeaponProfile.h"
autofire/AutoFire.cpp:113,155,162     → ShootRuntime::EnsureResolved / TryComputeShootAngle
                                        / CallShootWithAngle                  [lives in autoaim/]
autofire/AutoFire.cpp:4               → #include "ShootRuntime.h"
projectiles/ShotOrigin.cpp:43         → KillAura::ComputeShotOrigin(...)
```

`TargetSelector` and `ShootRuntime` — the two modules `killaura` and `autofire`
cannot function without — are already inside `autoaim/`. The three sibling
directories exist for historical reasons only (plans 85, 88, 89 each created
one).

Two source comments already admit the coupling is being papered over by an
include-path trick:

```cpp
// internal/src/features/combat/killaura/KillAura.cpp:5
#include "TargetSelector.h"      // features/combat/autoaim is on the include path
// internal/src/features/combat/autofire/AutoFire.cpp:4
#include "ShootRuntime.h"        // features/combat/autoaim is on the include path
// internal/src/features/projectiles/ShotOrigin.cpp:5
#include "AutoAim.h"          // features/combat/autoaim is on the include path
```

### The include-path shortcut

`internal/il2cpp-dll-injection.vcxproj:366` (Debug) and `:393` (Release) both
contain, inside `<AdditionalIncludeDirectories>`:

```
$(ProjectDir)src\features\combat\autoaim;
```

That single entry is why 24 `#include "SomeAimHeader.h"` lines across 8
directories resolve at all. `internal/CLAUDE.md:75-77` states the actual repo
convention: "`src` is the include root — headers are referred to by their subpath
(e.g. `#include "core/runtime/RuntimeOffsets.h"`)". The autoaim entry is the
exception, and it is what makes the move look scary. Removing it is step 1.

### Every bare-name include of an autoaim header (24 sites)

Outside `autoaim/`:

| file:line | current line |
|---|---|
| `internal/src/features/combat/autoability/AutoAbility.cpp:3` | `#include "AutoAim.h"` |
| `internal/src/features/combat/autofire/AutoFire.cpp:4` | `#include "ShootRuntime.h"` |
| `internal/src/features/combat/killaura/KillAura.cpp:5` | `#include "TargetSelector.h"` |
| `internal/src/features/combat/killaura/KillAura.cpp:6` | `#include "WeaponProfile.h"` |
| `internal/src/features/control/FeatureCommandRegistry.cpp:16` | `#include "AutoAim.h"` |
| `internal/src/features/control/FeatureCommandRegistry.cpp:20` | `#include "ProjNoclip.h"` |
| `internal/src/features/movement/dodge/DangerPlanner.cpp:23` | `#include "AutoAim.h"` |
| `internal/src/features/movement/dodge/ProjectileTracking.cpp:9` | `#include "AutoAim.h"` |
| `internal/src/features/movement/dodge/ProjectileTracking.cpp:10` | `#include "FeatMagnetAim.h"` — **deleted by plan 104**; if still present, delete it, do not repath |
| `internal/src/features/movement/dodge/RolloutDodge.cpp:10` | `#include "AutoAim.h"` |
| `internal/src/features/movement/dodge/XDodge.cpp:3` | `#include "AutoAim.h"` |
| `internal/src/features/movement/repp/RePP.cpp:12` | `#include "AutoAim.h"` |
| `internal/src/features/movement/udodge/UDodge.cpp:16` | `#include "AutoAim.h"` |
| `internal/src/features/movement/zdodge/ZDodge.cpp:12` | `#include "AutoAim.h"` |
| `internal/src/features/movement/zdodge/ZDodgeSensors.cpp:5` | `#include "AutoAim.h"` |
| `internal/src/features/projectiles/ShotOrigin.cpp:5` | `#include "AutoAim.h"` |
| `internal/src/features/projectiles/ShotOrigin.cpp:6` | `#include "FeatMagnetAim.h"` |
| `internal/src/features/runtime/FeatureRuntime.cpp:19` | `#include "AutoAim.h"` |
| `internal/src/features/runtime/FeatureRuntime.cpp:20` | `#include "ProjNoclip.h"` |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp:3` | `#include "FeatAutoAim.h"` |
| `internal/src/gui/tabs/CombatTab/CombatTAB.cpp:4` | `#include "FeatMagnetAim.h"` |
| `internal/src/gui/tabs/TestTAB.cpp:33` | `#include "AutoAim.h"` |
| `internal/src/platform/hooks/DirectX.cpp:17` | `#include "AutoAim.h"` |
| `internal/src/platform/hooks/InitHooks.cpp:11` | `#include "AutoAim.h"` |
| `internal/src/platform/hooks/InitHooks.cpp:14` | `#include "ProjNoclip.h"` |

Inside `autoaim/` (same-directory resolution, will break once subdirectories
exist — all must become explicit):

```
AimHooks.cpp:3   #include "AimHooks.h"
AimHooks.cpp:4   #include "WeaponProfile.h"
AimMath.cpp:3    #include "AimMath.h"
AutoAim.cpp:3-6  #include "AutoAim.h" / "AimHooks.h" / "WeaponProfile.h" / "TargetSelector.h"
AutoAim.h:3-4    #include "TargetSelector.h" / "WeaponProfile.h"
FeatAutoAim.cpp:2-4  #include "FeatAutoAim.h" / "AutoAim.h" / "ProjNoclip.h"
FeatMagnetAim.cpp:2  #include "FeatMagnetAim.h"
ProjNoclip.cpp:2 #include "ProjNoclip.h"
ShootRuntime.cpp:2 #include "ShootRuntime.h"
TargetSelector.cpp:3-4 #include "TargetSelector.h" / "AimMath.h"
TargetSelector.h:3  #include "WeaponProfile.h"
WeaponProfile.cpp:3-4  #include "WeaponProfile.h" / "AimMath.h"
```

**Note:** several autoaim files also include `"ProjectileTracking.h"`,
`"AoeTracking.h"`, `"GameState.h"`, `"RuntimeOffsets.h"`, `"Il2CppResolver.h"`,
`"BootGate.h"`, `"LocalPlayer.h"`, `"keybinds.h"`, `"DbgFileLog.h"`,
`"pch-il2cpp.h"`. Those resolve through **other** `AdditionalIncludeDirectories`
entries (`src\features\movement\dodge`, `src\core\runtime`, …) which this plan
does **not** remove. Leave them exactly as they are.

### Full-path includes of the three sibling modules (7 sites)

```
internal/src/features/combat/autobreak/AutoBreakWalls.cpp:3  "features/combat/autobreak/AutoBreakWalls.h"
internal/src/features/combat/autobreak/AutoBreakWalls.cpp:5  "features/combat/killaura/KillAura.h"
internal/src/features/combat/autobreak/AutoBreakWalls.cpp:6  "features/combat/autofire/AutoFire.h"
internal/src/features/combat/autofire/AutoFire.cpp:3         "features/combat/autofire/AutoFire.h"
internal/src/features/combat/killaura/KillAura.cpp:3         "features/combat/killaura/KillAura.h"
internal/src/features/control/FeatureCommandRegistry.cpp:17-19  killaura/ autofire/ autobreak/
internal/src/features/projectiles/ShotOrigin.cpp:4           "features/combat/killaura/KillAura.h"
internal/src/gui/tabs/CombatTab/CombatTAB.cpp:5-7            killaura/ autofire/ autobreak/
```

### Project files

`internal/il2cpp-dll-injection.vcxproj` lists the 13 modules at:
`:72,73` (FeatAutoAim/FeatMagnetAim .cpp), `:89-94` (AutoAim, AimMath,
WeaponProfile, TargetSelector, AimHooks, ShootRuntime .cpp), `:95-97`
(KillAura, AutoFire, AutoBreakWalls .cpp), `:106` (ProjNoclip.cpp),
`:217-222` (AutoAim, AimMath, WeaponProfile, TargetSelector, AimHooks,
ShootRuntime .h), `:223-225` (KillAura, AutoFire, AutoBreakWalls .h),
`:280,281` (FeatAutoAim/FeatMagnetAim .h), `:286` (ProjNoclip.h).

`internal/il2cpp-dll-injection.vcxproj.filters` lists a subset at `:56,57,72-76,
84,153-157,211,212,217`. **All autoaim entries in the `.filters` file are bare
`<ClCompile Include="…" />` / `<ClInclude Include="…" />` elements with no
`<Filter>` child** — i.e. they render at project root. This plan preserves that
(do not invent `<Filter>` values); it only rewrites the path strings.

### Guardrail checks that name these paths

`internal/tools/check-raw-access.sh:146-154` (check 13) and `:156-162`
(check 14):

```bash
hits13="$(grep -rnE 'ELCBJAFBLJG|EHGHCACPAGH|PMIANFBMMNN' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autoaim/AimHooks.cpp' | grep -v 'autoaim/ShootRuntime.cpp' \
  | grep -v 'raw-access-ok')"
...
hits14="$(grep -rn 'KillAura::SetForcedTargetId' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autobreak/AutoBreakWalls.cpp' | grep -v 'raw-access-ok')"
```

These exclusions are **path substring matches**. Moving `AimHooks.cpp` to
`autoaim/shoot/AimHooks.cpp` still contains the substring `autoaim/` but **not**
`autoaim/AimHooks.cpp` — so check 13 would start reporting its own sanctioned
home as a violation. `autobreak/AutoBreakWalls.cpp` breaks outright. Both must be
updated **in the same step as the move**.

### Documentation drift

`internal/CLAUDE.md:65` lists the combat family as
`autoability, autoaim, autonexus, enemytracker, ghostHit` — it never learned
about `killaura`, `autofire` or `autobreak` at all.

`client/plugins/killaura.ts:152` cites
`internal/src/features/combat/killaura/KillAura.cpp` in a comment.
(`client/dist/plugins/killaura.js:136` is build output — **do not edit it**.)

## Target design

### Layout

```
internal/src/features/combat/autoaim/
├── README.md                 (new — the map of this system)
├── core/                     shared computation; no hooks, no enable flag
│   ├── AimMath.{h,cpp}
│   ├── WeaponProfile.{h,cpp}
│   └── TargetSelector.{h,cpp}
├── shoot/                    everything that binds, calls or detours a game method
│   ├── AimHooks.{h,cpp}      HOOKS the shoot methods
│   ├── ShootRuntime.{h,cpp}  RESOLVES + CALLS the shoot methods
│   └── ProjNoclip.{h,cpp}    detours the local projectile collision path
├── modes/                    the user-facing behaviours; one enable flag + Tick() each
│   ├── AutoAim.{h,cpp}
│   ├── KillAura.{h,cpp}
│   ├── AutoFire.{h,cpp}
│   └── AutoBreakWalls.{h,cpp}
└── ui/                       ImGui panels, namespace CombatTAB::
    ├── FeatAutoAim.{h,cpp}
    └── FeatMagnetAim.{h,cpp}
```

**Why this and not a flat directory:** flat would be 27 files, which the repo does
tolerate (`features/movement/dodge/` is 27), but the whole point of the exercise
is that the family reads as one system with a legible internal shape. The four
groups are the shape that is already there: `core` has no game bindings and no
state machine, `shoot` is the only group that touches IL2CPP methods, `modes` is
the only group with enable flags and `Tick()`, `ui` is the only group in
namespace `CombatTAB`. Crucially, the marginal cost of the grouping is ~zero:
once step 1 has converted every include to an explicit `src`-relative subpath (a
prerequisite for **any** move), a grouped move edits exactly the same lines a
flat move would, just with different text.

**Why not `features/combat/aim/`:** renaming the family costs a second rename of
every path with no benefit — "autoaim" is the name the user, the client plugin
keys (`autoAimPrioritizeBosses`, `autoFireEnabled`), the GUI and the docs already
use.

**Namespaces do not change.** `AutoAim::`, `KillAura::`, `AutoFire::`,
`AutoBreakWalls::`, `TargetSelector::`, `ShootRuntime::`, `WeaponProfile::`,
`AimMath::`, `AimHooks::`, `ProjNoclip::`, `CombatTAB::FeatAutoAim`,
`CombatTAB::FeatMagnetAim` all stay exactly as they are. Directories are not
namespaces here and this plan does not make them so.

### Include convention after this plan

Every include of an autoaim header, from anywhere including inside `autoaim/`
itself, is the full `src`-relative subpath:

```cpp
#include "features/combat/autoaim/core/TargetSelector.h"
#include "features/combat/autoaim/shoot/ShootRuntime.h"
#include "features/combat/autoaim/modes/KillAura.h"
#include "features/combat/autoaim/ui/FeatMagnetAim.h"
```

Same-directory siblings are written the long way too. That is deliberate: it
makes check 15 a single unconditional grep with no exclusion list, and it means
moving a file between groups later is a pure find/replace.

### Divergence warnings

- There is **no logic divergence between the four modules** to resolve — they do
  different jobs and share code through `TargetSelector` / `ShootRuntime` /
  `WeaponProfile` already. Nothing is being unified except directory paths.
- The 30-second throttled-log idiom appears in `AutoFire.cpp:77,105,118`,
  `KillAura.cpp:122` and `AutoBreakWalls.cpp:154` with the same 30000 ms window.
  **Leave it.** `96-overview.md` already ruled a shared helper not worth a plan,
  and folding it in here would make this a behavior-carrying change.
- `AutoBreakWalls` is the sole legitimate caller of
  `KillAura::SetForcedTargetId` (guardrail check 14). After the move both files
  are in `autoaim/modes/`, so the exclusion path becomes
  `autoaim/modes/AutoBreakWalls.cpp`. Keep the check — a second caller is still
  a bug, and co-location makes it *more* tempting, not less.

## Steps

Run `bash internal/tools/wsl-build.sh Debug` and
`bash internal/tools/check-raw-access.sh` after **every** step. Both must be
clean before you start the next one. No step may leave the tree unbuildable.

---

### Step 1 — Make every autoaim include explicit, then delete the include-path shortcut

No files move in this step.

1a. Rewrite the 24 external bare-name includes listed in "Current state" to full
subpaths against the **pre-move** layout (everything is still directly under
`autoaim/`):

```cpp
// before
#include "AutoAim.h"
// after
#include "features/combat/autoaim/AutoAim.h"
```

Mapping for this step (all headers are still at `autoaim/<Header>.h`):

| bare | explicit |
|---|---|
| `"AutoAim.h"` | `"features/combat/autoaim/AutoAim.h"` |
| `"AimHooks.h"` | `"features/combat/autoaim/AimHooks.h"` |
| `"AimMath.h"` | `"features/combat/autoaim/AimMath.h"` |
| `"TargetSelector.h"` | `"features/combat/autoaim/TargetSelector.h"` |
| `"WeaponProfile.h"` | `"features/combat/autoaim/WeaponProfile.h"` |
| `"ShootRuntime.h"` | `"features/combat/autoaim/ShootRuntime.h"` |
| `"ProjNoclip.h"` | `"features/combat/autoaim/ProjNoclip.h"` |
| `"FeatAutoAim.h"` | `"features/combat/autoaim/FeatAutoAim.h"` |
| `"FeatMagnetAim.h"` | `"features/combat/autoaim/FeatMagnetAim.h"` |

Delete the trailing `// features/combat/autoaim is on the include path` comments
on `KillAura.cpp:5`, `AutoFire.cpp:4`, `ShotOrigin.cpp:5` — they are now false.

If `ProjectileTracking.cpp` still has `#include "FeatMagnetAim.h"` (plan 104
should have removed it), **delete the line** rather than repathing it: grep the
file for `MagnetAim` to confirm there is no other mention first.

1b. Rewrite the in-directory includes listed in "Current state" the same way
(they are still same-directory at this point, so this is a no-op for the
compiler but a prerequisite for step 2).

1c. Delete `$(ProjectDir)src\features\combat\autoaim;` from
`<AdditionalIncludeDirectories>` at `internal/il2cpp-dll-injection.vcxproj:366`
**and** `:393`. Change nothing else in those two very long lines — copy the
value, remove that one segment (including its trailing semicolon), paste back.

Verify:

```bash
bash internal/tools/wsl-build.sh Debug      # 0 Error(s)
bash internal/tools/check-raw-access.sh     # exit 0
grep -c 'features\\combat\\autoaim;' internal/il2cpp-dll-injection.vcxproj   # 0
```

A build failure here means one bare include was missed — the error message names
the file and the header. Fix and rebuild; do not restore the include directory.

---

### Step 2 — Create `autoaim/core/` and move the three computation modules

```bash
cd internal/src/features/combat/autoaim
mkdir core
git mv AimMath.h AimMath.cpp WeaponProfile.h WeaponProfile.cpp \
       TargetSelector.h TargetSelector.cpp core/
```

Then, repo-wide, replace:

- `"features/combat/autoaim/AimMath.h"` → `"features/combat/autoaim/core/AimMath.h"`
- `"features/combat/autoaim/WeaponProfile.h"` → `"features/combat/autoaim/core/WeaponProfile.h"`
- `"features/combat/autoaim/TargetSelector.h"` → `"features/combat/autoaim/core/TargetSelector.h"`

Update `internal/il2cpp-dll-injection.vcxproj` (`:90-92` ClCompile, `:218-220`
ClInclude) and `internal/il2cpp-dll-injection.vcxproj.filters` — after plan 104,
`AimMath` / `WeaponProfile` / `TargetSelector` entries exist in `.filters`; change
`src\features\combat\autoaim\X` → `src\features\combat\autoaim\core\X` for all six.

Verify:

```bash
bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
```

---

### Step 3 — Create `autoaim/shoot/` and move the three game-binding modules

```bash
cd internal/src/features/combat/autoaim
mkdir shoot
git mv AimHooks.h AimHooks.cpp ShootRuntime.h ShootRuntime.cpp \
       ProjNoclip.h ProjNoclip.cpp shoot/
```

Repo-wide replace `features/combat/autoaim/{AimHooks,ShootRuntime,ProjNoclip}.h`
→ `features/combat/autoaim/shoot/…`.

Update the vcxproj (`:93,94,106` ClCompile; `:221,222,286` ClInclude) and
`.filters` (`:73,84,154,217` plus the AimHooks entries plan 104 added).

**Update guardrail check 13 in `internal/tools/check-raw-access.sh`** — read the
file first, it may have shifted from lines 146-154:

```bash
# before
  | grep -v 'autoaim/AimHooks.cpp' | grep -v 'autoaim/ShootRuntime.cpp' \
# after
  | grep -v 'autoaim/shoot/AimHooks.cpp' | grep -v 'autoaim/shoot/ShootRuntime.cpp' \
```

Verify:

```bash
bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
```

`check-raw-access.sh` failing with `FORBIDDEN [private shoot-method binding]`
pointing at `AimHooks.cpp` or `ShootRuntime.cpp` means you edited the paths
wrong. It must exit 0 silently.

---

### Step 4 — Create `autoaim/ui/` and move the two ImGui panels

```bash
cd internal/src/features/combat/autoaim
mkdir ui
git mv FeatAutoAim.h FeatAutoAim.cpp FeatMagnetAim.h FeatMagnetAim.cpp ui/
```

Repo-wide replace `features/combat/autoaim/{FeatAutoAim,FeatMagnetAim}.h` →
`features/combat/autoaim/ui/…` (call sites: `CombatTAB.cpp:3,4`,
`ShotOrigin.cpp:6`, `FeatAutoAim.cpp:2`, `FeatMagnetAim.cpp:2`).

Update vcxproj `:72,73,280,281` and `.filters` `:56,57,211,212`.

Verify: build + guardrail.

---

### Step 5 — Create `autoaim/modes/` and move `AutoAim`

```bash
cd internal/src/features/combat/autoaim
mkdir modes
git mv AutoAim.h AutoAim.cpp modes/
```

Repo-wide replace `features/combat/autoaim/AutoAim.h` →
`features/combat/autoaim/modes/AutoAim.h` (12 call sites — the largest fan-out
in this plan; use `grep -rn` to confirm zero remain).

Update vcxproj `:89`, `:217`; `.filters` `:72`, `:153`.

Verify: build + guardrail. At this point `autoaim/` contains only the four
subdirectories.

---

### Step 6 — Move `KillAura`, `AutoFire`, `AutoBreakWalls` into `autoaim/modes/` and delete the three sibling directories

```bash
cd internal/src/features/combat
git mv killaura/KillAura.h killaura/KillAura.cpp autoaim/modes/
git mv autofire/AutoFire.h autofire/AutoFire.cpp autoaim/modes/
git mv autobreak/AutoBreakWalls.h autobreak/AutoBreakWalls.cpp autoaim/modes/
rmdir killaura autofire autobreak
```

Repo-wide replace:

- `"features/combat/killaura/KillAura.h"` → `"features/combat/autoaim/modes/KillAura.h"`
- `"features/combat/autofire/AutoFire.h"` → `"features/combat/autoaim/modes/AutoFire.h"`
- `"features/combat/autobreak/AutoBreakWalls.h"` → `"features/combat/autoaim/modes/AutoBreakWalls.h"`

Call sites: `AutoBreakWalls.cpp:3,5,6`, `AutoFire.cpp:3`, `KillAura.cpp:3`,
`FeatureCommandRegistry.cpp:17-19`, `ShotOrigin.cpp:4`, `CombatTAB.cpp:5-7`.

Update vcxproj `:95-97` (ClCompile) and `:223-225` (ClInclude), and `.filters`
`:74-76`, `:155-157`.

**Update guardrail check 14** in `internal/tools/check-raw-access.sh`:

```bash
# before
  | grep -v 'autobreak/AutoBreakWalls.cpp' | grep -v 'raw-access-ok')"
# after
  | grep -v 'autoaim/modes/AutoBreakWalls.cpp' | grep -v 'raw-access-ok')"
```

Verify:

```bash
bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
ls internal/src/features/combat            # autoability autoaim autonexus enemytracker ghostHit
ls internal/src/features/combat/autoaim    # README.md(next step) core modes shoot ui
```

---

### Step 7 — Project-file consistency check, guardrail check 15, docs

7a. Run plan 104's project-file diff. Both lists must be empty:

```bash
python3 - <<'EOF'
import re
p=open('/home/jesse/realm-engine-client/internal/il2cpp-dll-injection.vcxproj').read()
f=open('/home/jesse/realm-engine-client/internal/il2cpp-dll-injection.vcxproj.filters').read()
items=lambda t:{x for x in re.findall(r'Include="([^"]+)"',t) if x.lower().endswith(('.cpp','.h'))}
a,b=items(p),items(f)
print("in vcxproj not filters:",sorted(a-b))
print("in filters not vcxproj:",sorted(b-a))
EOF
```

Also confirm every listed path exists on disk:

```bash
python3 - <<'EOF'
import re,os
root='/home/jesse/realm-engine-client/internal/'
p=open(root+'il2cpp-dll-injection.vcxproj').read()
missing=[x for x in re.findall(r'Include="([^"]+)"',p)
         if x.lower().endswith(('.cpp','.h')) and not os.path.exists(root+x.replace('\\','/'))]
print("missing on disk:",missing)
EOF
```

7b. Append **check 15** to `internal/tools/check-raw-access.sh` (read the file
first; append after the highest-numbered existing check, before `exit $fail`):

```bash
# 15. The aim/shoot family is ONE directory: features/combat/autoaim, grouped
#     into core/ shoot/ modes/ ui/ (docs/plans/106). Two things creep back:
#     (a) a bare-name include of an autoaim header, which only ever worked
#         because features\combat\autoaim used to be on the include path;
#     (b) a new sibling directory (killaura/, autofire/, autobreak/) or a stale
#         path to one.
hits15a="$(grep -rnE '#include "(AutoAim|AimHooks|AimMath|TargetSelector|WeaponProfile|ShootRuntime|ProjNoclip|FeatAutoAim|FeatMagnetAim|KillAura|AutoFire|AutoBreakWalls)\.h"' \
  "${scope_feat[@]}" "$root/platform" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits15a" ]; then
  echo "FORBIDDEN [bare-name autoaim include — use features/combat/autoaim/<group>/X.h]:"
  echo "$hits15a"; fail=1
fi
hits15b="$(grep -rnE 'features/combat/(killaura|autofire|autobreak)/' "$root" 2>/dev/null)"
if [ -n "$hits15b" ]; then
  echo "FORBIDDEN [retired autoaim sibling directory]:"
  echo "$hits15b"; fail=1
fi
```

Also add `$(ProjectDir)src\features\combat\autoaim` to the "do not reintroduce"
note in the script's header comment block.

7c. Write `internal/src/features/combat/autoaim/README.md`. Content — the map,
not a tutorial:

- One paragraph: this directory is the whole aim/shoot system; four groups; each
  module keeps its own enable flag and `Tick()`; there is deliberately no shared
  base class (cite `docs/plans/96-overview.md`).
- The dependency graph from "Current state" above, as an ASCII diagram.
- The entry points: `AutoAim::Tick()` from `platform/hooks/DirectX.cpp:193`;
  `FeatAutoAim/FeatMagnetAim/KillAura/AutoFire/AutoBreakWalls` all ticked from
  `gui/tabs/CombatTab/CombatTAB.cpp:23-42`; IPC keys handled in
  `features/control/FeatureCommandRegistry.cpp:106-124`; hook teardown in
  `platform/hooks/InitHooks.cpp:94-96`.
- The include rule: always `features/combat/autoaim/<group>/<Header>.h`, enforced
  by check 15.
- The two guardrail invariants: check 13 (only `shoot/AimHooks.cpp` and
  `shoot/ShootRuntime.cpp` may name the shoot-method tokens) and check 14 (only
  `modes/AutoBreakWalls.cpp` may call `KillAura::SetForcedTargetId`).

7d. Fix the two documentation references:

- `internal/CLAUDE.md:65`: change
  `│   ├── combat/          autoability, autoaim, autonexus, enemytracker, ghostHit`
  to
  `│   ├── combat/          autoability, autoaim (core/shoot/modes/ui — see its README), autonexus, enemytracker, ghostHit`
- `client/plugins/killaura.ts:152`: update the cited path to
  `internal/src/features/combat/autoaim/modes/KillAura.cpp`.
  **Do not touch `client/dist/plugins/killaura.js` — it is build output.**

Verify:

```bash
bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
cd client && npx tsc --noEmit -p tsconfig.json      # comment-only edit; must stay clean
```

## Verification

Full green state:

```bash
bash internal/tools/wsl-build.sh Debug      # expect: 0 Error(s)
bash internal/tools/check-raw-access.sh     # expect: exit 0, no output
cd client && npx tsc --noEmit -p tsconfig.json   # expect: exit 0, no output
```

Structure:

```bash
ls internal/src/features/combat
# autoability  autoaim  autonexus  enemytracker  ghostHit

ls internal/src/features/combat/autoaim
# README.md  core  modes  shoot  ui

ls internal/src/features/combat/autoaim/modes
# AutoAim.cpp AutoAim.h AutoBreakWalls.cpp AutoBreakWalls.h
# AutoFire.cpp AutoFire.h KillAura.cpp KillAura.h
```

Greps that must return **zero** results:

```bash
# 1. The retired sibling directories, anywhere in tracked source or tooling.
grep -rn 'features/combat/killaura\|features/combat/autofire\|features/combat/autobreak' \
  /home/jesse/realm-engine-client/internal /home/jesse/realm-engine-client/client/plugins \
  /home/jesse/realm-engine-client/client/src

# 2. The include-path shortcut.
grep -n 'features\\combat\\autoaim;' /home/jesse/realm-engine-client/internal/il2cpp-dll-injection.vcxproj

# 3. Bare-name includes of any autoaim header.
grep -rnE '#include "(AutoAim|AimHooks|AimMath|TargetSelector|WeaponProfile|ShootRuntime|ProjNoclip|FeatAutoAim|FeatMagnetAim|KillAura|AutoFire|AutoBreakWalls)\.h"' \
  /home/jesse/realm-engine-client/internal/src

# 4. The now-false "on the include path" comments.
grep -rn 'is on the include path' /home/jesse/realm-engine-client/internal/src
```

Behavioral smoke test (manual, in-game — this plan changes no logic, so anything
that regresses is a wiring mistake):

- Combat tab renders all six panels in the same order: Auto Aim, Magnet Aim,
  muzzle slider, Auto Nexus, KillAura, AutoFire, AutoBreakWalls.
- Toggling each of `autoAimEnabled`, `killauraEnabled`, `autoFireEnabled`,
  `autoBreakWallsEnabled` from the client still takes effect (they route through
  `FeatureCommandRegistry`).
- Unload the DLL cleanly (`InitHooks.cpp` teardown still finds `ProjNoclip` and
  `AutoAim`).

## Out of scope

- **Do NOT merge any two modules, delete any module, or move logic between
  them.** `KillAura::Tick`, `AutoFire::Tick`, `AutoBreakWalls::Tick` and
  `AutoAim::Tick` stay four separate functions with four separate enable flags.
- **Do NOT introduce a feature base class, CRTP mixin, virtual `IFeature`, or a
  tick registry.** Rejected on the merits in `docs/plans/96-overview.md`; the
  render-thread hot path does not need the indirection and `CombatTAB::Tick` has
  no dispatch boilerplate to remove.
- **Do NOT rename any namespace, function, enable-flag, IPC feature key, or
  ImGui label.** `FeatureCommandRegistry.cpp:106-124` keys and
  `client/src/bridge/contract.ts` must remain byte-identical in meaning.
- **Do NOT extract the throttled 30-second logging idiom** into a helper.
- **Do NOT touch the other `AdditionalIncludeDirectories` entries.** Only the
  `src\features\combat\autoaim` segment is removed; `src\features\movement\dodge`,
  `src\core\runtime` and the rest still carry bare-name includes this plan does
  not convert.
- **Do NOT restructure `features/combat/autonexus`, `enemytracker`, `ghostHit`
  or `autoability`.** `EnemyTracker` is consumed by movement code as well as aim
  code; it is correctly a peer, not a member of this family.
- **Do NOT edit anything under `client/dist/`** — build output.
- **Do NOT fix the `client/plugins/auto-follow.ts` dead-feature-key bug** or any
  other behavioral issue you notice; those belong to their own plans.
