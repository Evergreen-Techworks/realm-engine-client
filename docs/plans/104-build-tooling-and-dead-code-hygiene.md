# 104 — Build-tooling repair and dead-code hygiene

## Goal

After this plan, the DLL's build tooling tells the truth: `build-and-test.bat`
points at the DLL the project actually produces (it currently looks for
`version.dll` in a directory the project stopped writing to, so it fails every
run — and it is the **only** invoker of the raw-access guardrail on Windows, so
that guardrail has effectively never run there). The drifted PowerShell mirror
of `check-raw-access.sh` is retired rather than left half-ported. The Visual
Studio project's filter file matches reality (14 missing entries, 2 phantom
entries pointing at files that do not exist). Three dead includes and one dead
TypeScript module are gone.

None of this changes runtime behavior. All of it removes traps that make the
next person's build lie to them.

**This is a C++ + tooling plan**, with one TypeScript file deletion at the end.
It builds the DLL and must not run concurrently with any other C++ plan.

## Dependencies

- **Plans 100 and 101 MUST be merged first.** Both add checks to
  `internal/tools/check-raw-access.sh` and both edit
  `internal/src/features/movement/dodge/ProjectileTracking.cpp`. This plan
  removes includes from that file and rewrites the guardrail's Windows story;
  doing it before them guarantees a conflict.
- Plans 102 and 103 also append guardrail checks. If either has landed, this
  plan's step 4 must preserve their checks — read the file first, do not
  reconstruct it from this document.

Files this plan touches that other plans also touch:
- `internal/tools/check-raw-access.sh` — plans 100, 101, 102, 103.
- `internal/tools/check-raw-access.ps1` — **this plan deletes it.** No other
  plan touches it.
- `internal/il2cpp-dll-injection.vcxproj.filters` — plans 99 (removes 2),
  101 (adds 2), 102 (adds 2). Land last.
- `internal/src/features/movement/dodge/ProjectileTracking.cpp` — plans 100,
  101, 103.

## Current state

### 1. `build-and-test.bat` cannot succeed

`internal/build-and-test.bat:18`:

```bat
set "OUTDLL=%ROOT%x64\%CONFIG%\version.dll"
```

But `internal/il2cpp-dll-injection.vcxproj:347-348` (Debug) and `:352-353`
(Release) both say:

```xml
    <TargetName>realm-engine</TargetName>
    <OutDir>$(SolutionDir)..\client\assets\</OutDir>
```

So MSBuild writes `client/assets/realm-engine.dll`, and
`%ROOT%x64\Release\version.dll` never exists. The script's own guard at
`:50-53` then fires:

```bat
if not exist "%OUTDLL%" (
  echo ERROR: build succeeded but %OUTDLL% is missing.
  goto :end
)
```

`goto :end` skips everything below — **including** `[2.5/3] Raw-access
guardrails` at `:56-59`, which is the only place in the repo that runs
`check-raw-access.ps1`:

```bash
$ grep -rn 'check-raw-access' --include='*.bat' --include='*.sh' --include='*.mjs' --include='*.yml' .
internal/build-and-test.bat:58:powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\check-raw-access.ps1"
internal/tools/check-raw-access.sh:28:# Usage: ...
# (the rest are docs/plans references)
```

`client/build-tools/dev-build.bat` — the script actually used for the dev loop —
runs MSBuild, locates the DLL correctly at
`!WIN_BASE!\client\assets\realm-engine.dll` (`dev-build.bat:151`), builds
`injector.exe`, and rebuilds the client TypeScript. It runs **no guardrail at
all**.

The `version.dll` naming is a leftover from a DLL-hijack era; `clean-wipe.bat`
still deletes `%GAMEDIR%\version.dll` (`:24,27,37`) as cleanup, which is
correct and should stay.

### 2. `check-raw-access.ps1` is a partial mirror and says so

`internal/tools/check-raw-access.ps1:8-10`:

```powershell
# DRIFT: the mirror carries checks 1-4 and 13-14; checks 5-12 were added to the
# shell script and never mirrored. Numbers are kept aligned with the shell
# script so the two files can be diffed by check number.
```

The `.sh` has 14 checks today (and plans 100–103 add up to four more). The
`.ps1` has 6. It has one caller, and that caller is broken. Maintaining two
implementations of a grep ratchet in two languages has produced exactly the
outcome you would predict.

### 3. `.vcxproj.filters` is out of sync with `.vcxproj`

Fourteen files are compiled/included by the project but absent from the filter
file, so Visual Studio shows them dumped at the project root:

```
src\core\il2cpp\Il2CppContainers.cpp   src\core\il2cpp\Il2CppContainers.h
src\features\combat\autoaim\AimHooks.cpp        AimHooks.h
src\features\combat\autoaim\AimMath.cpp         AimMath.h
src\features\combat\autoaim\TargetSelector.cpp  TargetSelector.h
src\features\combat\autoaim\WeaponProfile.cpp   WeaponProfile.h
src\features\combat\enemytracker\EnemyTracker.cpp  EnemyTracker.h
src\platform\hooks\Il2CppHook.cpp               Il2CppHook.h
```

Two entries point at files that do not exist (more `version.dll`-era residue):

- `internal/il2cpp-dll-injection.vcxproj.filters:11` —
  `<ClCompile Include="src\bootstrap\version.cpp" />`
- `internal/il2cpp-dll-injection.vcxproj.filters:126` —
  `<ClInclude Include="src\bootstrap\version.h" />`

Four header-only files exist on disk and are compiled-in transitively but are in
neither project file, so they are invisible in the IDE:
`src\core\logging\CrashProbe.h`, `src\core\logging\DbgFileLog.h`,
`src\core\runtime\MemRead.h`, `src\features\movement\dodge\Mangled.h`.
(`MemRead.h` being invisible is particularly unhelpful — it is the sanctioned
home the guardrail points everyone at.)

### 4. Dead includes

`internal/src/features/movement/dodge/ProjectileTracking.cpp:10`:

```cpp
#include "FeatMagnetAim.h"
```

`grep -n 'FeatMagnetAim\|MagnetAim' internal/src/features/movement/dodge/ProjectileTracking.cpp`
returns **only line 10**. The MagnetAim branch moved to
`features/projectiles/ShotOrigin.cpp:55-81` (plan 87); the include did not
follow.

`internal/src/features/movement/dodge/ProjectileTracking.cpp:12`:

```cpp
#include "helpers.h"
```

`grep -n 'helpers\|il2cppi_' ` on the file returns only line 12.
`core/logging/helpers.h` is Il2CppInspectorPro-generated
(`il2cppi_get_base_address`, `LogError`, `il2cppi_new_console`,
`il2cppi_to_string`) — none used here. **Caution:** it transitively includes
`il2cpp-metadata-version.h`; if removal breaks the build, put it back and note
that in the PR rather than papering over it.

`internal/src/features/movement/dodge/ProjectileTracking.cpp:22`
(`#include "minhook/MinHook.h"`) is removed by plan 100. If plan 100 has landed,
it is already gone.

### 5. Dead TypeScript module

`client/src/simulation/ProjectileSimulator.ts` (154 lines,
"Ported directly from the game client's `Projectile.as positionAt()` method")
has **no consumers**:

```bash
$ cd client && grep -rn 'ProjectileSimulator' src plugins --include='*.ts' | grep -v 'src/simulation/ProjectileSimulator.ts'
src/state/ProjectileTracker.ts:28: * for trajectory calculation by ProjectileSimulator.
```

— a docstring mention, not an import. The DLL took over threat prediction
(`DllThreatBus` ← `IpcMessages::EncodeThreats`), and `plugins/auto-nexus.ts:995`
now reads `getDllThreats()` instead of simulating locally.

`ProjectileTracker` itself **is** live (`plugins/anti-debuffs.ts:248` uses
`ctx.projectileTracker`) — do not touch it.

### 6. Untracked stray build directory

`internal/il2cpp-d.01413F01/x64/` is a root-owned MSBuild intermediate directory
left behind by a Windows build. It is untracked and not in `.gitignore`.

## Target design

No new API. The changes are:

- `build-and-test.bat` resolves the DLL at `%ROOT%..\client\assets\realm-engine.dll`
  (matching the vcxproj `OutDir`) and invokes the **bash** guardrail through
  WSL, with a clear message if WSL is unavailable.
- `check-raw-access.sh` becomes the single implementation. `check-raw-access.ps1`
  is deleted.
- `.vcxproj.filters` gains the 14 missing entries under the filters their
  siblings already use, loses the 2 phantom entries, and both project files gain
  the 4 header-only files.

### Divergence resolution — one guardrail or two?

Two implementations of the same ratchet in two languages is the exact failure
mode this program exists to remove, and the evidence is in the `.ps1`'s own
header: eight of fourteen checks were never ported. Every developer environment
here already has WSL (the C++ build itself is driven from WSL via
`internal/tools/wsl-build.sh`). **Correct outcome: one bash implementation,
invoked from the batch file via `wsl bash ...`.**

If WSL is genuinely unavailable on some build host, the batch file must print a
loud `GUARDRAIL SKIPPED (no WSL)` and continue — a skipped check that announces
itself beats a silently-half-implemented mirror.

## Steps

1. **Fix `internal/build-and-test.bat`'s output path.** Change `:18` from
   ```bat
   set "OUTDLL=%ROOT%x64\%CONFIG%\version.dll"
   ```
   to
   ```bat
   rem The vcxproj OutDir is $(SolutionDir)..\client\assets\ and TargetName is
   rem realm-engine (il2cpp-dll-injection.vcxproj:347-348, :352-353). The old
   rem %ROOT%x64\%CONFIG%\version.dll path is a DLL-hijack-era leftover and
   rem never existed, which made every run of this script bail before the
   rem guardrail step.
   set "OUTDLL=%ROOT%..\client\assets\realm-engine.dll"
   ```
   Also update the header comment at `:5` and the two deploy messages at
   `:64-65` (`copy /y "%OUTDLL%" "%GAME_DIR%\realm-engine.dll"`).
   **Note:** the deploy branch copies next to `GameAssembly.dll`; with external
   injection (`injector.exe`) that copy is no longer how the DLL loads. Leave
   the branch in place but add a one-line comment saying it is legacy and that
   the client injects from `client/assets/`.
   Verify (Windows/WSL): `bash -n` cannot check batch. Instead confirm the
   path exists after a build:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ls -la /mnt/c/rebuild/Debug/bin/realm-engine.dll   # wsl-build's own OutDir override
   ls -la client/assets/realm-engine.dll              # the vcxproj default OutDir
   ```

2. **Point `build-and-test.bat` at the bash guardrail.** Replace `:56-59`:
   ```bat
   echo(
   echo === [2.5/3] Raw-access guardrails ===
   powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\check-raw-access.ps1"
   if errorlevel 1 ( echo GUARDRAIL FAILURE - see above & exit /b 1 )
   echo Guardrails OK - no forbidden raw access in features/ or gui/.
   ```
   with:
   ```bat
   echo(
   echo === [2.5/3] Raw-access guardrails ===
   rem ONE implementation: tools\check-raw-access.sh. The former .ps1 mirror
   rem carried only 6 of 14 checks and was deleted (see docs/plans/104).
   where wsl >nul 2>&1
   if errorlevel 1 (
     echo GUARDRAIL SKIPPED - wsl.exe not found. Run:
     echo     bash internal/tools/check-raw-access.sh
     echo from a WSL shell before pushing.
   ) else (
     wsl bash -c "cd \"$(wslpath '%ROOT%')\" && bash tools/check-raw-access.sh"
     if errorlevel 1 ( echo GUARDRAIL FAILURE - see above & exit /b 1 )
     echo Guardrails OK - no forbidden raw access in features/ or gui/.
   )
   ```
   Verify: no build change; re-run `bash internal/tools/check-raw-access.sh`
   directly to confirm exit 0.

3. **Delete `internal/tools/check-raw-access.ps1`.**
   ```bash
   rm internal/tools/check-raw-access.ps1
   ```
   Then update every doc that references it:
   - `internal/CLAUDE.md:101-104` — the sentence
     "`internal/tools/check-raw-access.sh` (and its `.ps1` mirror, run by
     `build-and-test.bat`) is the ratchet that enforces this" becomes
     "`internal/tools/check-raw-access.sh` is the ratchet that enforces this;
     `build-and-test.bat` invokes it through WSL."
   Verify:
   ```bash
   grep -rn 'check-raw-access.ps1' /home/jesse/realm-engine-client --include='*.md' --include='*.bat' --include='*.sh' --include='*.json' \
     | grep -v '/docs/plans/'
   ```
   → empty. (Historical references inside `docs/plans/11-*.md`, `43-*.md` are
   history; leave them.)

4. **Add a header banner to `check-raw-access.sh` stating it is the sole
   implementation.** Read the file first — plans 100–103 may have appended
   checks 15–18. Edit only the header comment block (lines 1–30), changing the
   usage note to record that there is no Windows mirror and that
   `build-and-test.bat` shells into WSL to run this file.
   Verify: `bash internal/tools/check-raw-access.sh` → exit 0, no output.

5. **Repair `.vcxproj.filters`.** Remove the two phantom entries (lines 11 and
   126, `src\bootstrap\version.cpp` / `version.h`) and add the 14 missing ones,
   each under the same `<Filter>` value its directory siblings already use
   (open the file and copy the neighbouring entry's `<Filter>` text verbatim —
   do not invent new filter names, and do not add `<Filter>` definitions that
   are not already present in the `ItemGroup` at the top).
   Verify:
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
   Both lists must be empty. Then
   `bash internal/tools/wsl-build.sh Debug` → 0 errors (the filter file does not
   affect the build, but confirm you did not corrupt the XML —
   a malformed `.filters` makes MSBuild warn).

6. **Add the four header-only files to both project files.**
   `src\core\logging\CrashProbe.h`, `src\core\logging\DbgFileLog.h`,
   `src\core\runtime\MemRead.h`, `src\features\movement\dodge\Mangled.h` as
   `<ClInclude>` entries in `il2cpp-dll-injection.vcxproj` and matching entries
   with the right `<Filter>` in `.filters`.
   Verify: re-run the python diff from step 5 (both lists empty) plus a build.

7. **Remove the two dead includes.** In
   `internal/src/features/movement/dodge/ProjectileTracking.cpp`, delete line 10
   (`#include "FeatMagnetAim.h"`) and line 12 (`#include "helpers.h"`).
   Verify:
   ```bash
   bash internal/tools/wsl-build.sh Debug && bash internal/tools/check-raw-access.sh
   ```
   **If removing `helpers.h` breaks the build**, restore that one line, add a
   comment saying what it transitively provides, and continue with only the
   `FeatMagnetAim.h` removal. Do not chase the transitive dependency in this
   plan.

8. **Sweep for other dead includes in the files Phase 1–3 touched.** For each of
   `KillAura.cpp`, `AutoFire.cpp`, `AutoBreakWalls.cpp`, `PlayerCollider.cpp`,
   `ShotOrigin.cpp`, `ShootRuntime.cpp`, `TargetSelector.cpp`,
   `WeaponProfile.cpp`, `AimHooks.cpp`, `AimMath.cpp`: for every
   `#include "X.h"` where `X` is a project header, grep the file for the
   header's namespace/class token. Remove only includes with **zero** other
   mentions, one file at a time.
   Verify after **each file**:
   ```bash
   bash internal/tools/wsl-build.sh Debug
   ```
   A removal that breaks the build gets reverted immediately, not debugged.

9. **Delete the dead client module.**
   ```bash
   rm client/src/simulation/ProjectileSimulator.ts
   rmdir client/src/simulation 2>/dev/null || true
   ```
   Then fix the now-dangling docstring at
   `client/src/state/ProjectileTracker.ts:26-30`: change
   "Stores spawn position, angle, damage, and linked ProjectileDef for
   trajectory calculation by ProjectileSimulator." to
   "Stores spawn position, angle, damage, and linked ProjectileDef. Consumed by
   plugins through `ctx.projectileTracker` (see plugins/anti-debuffs.ts).
   Trajectory prediction now happens in the DLL and arrives via DllThreatBus."
   Verify:
   ```bash
   cd client && npx tsc --noEmit -p tsconfig.json     # exit 0, no output
   cd client && npm test                              # if plan 97 landed: green
   ```

10. **Ignore the stray build directory.** Add to `/home/jesse/realm-engine-client/.gitignore`:
    ```
    # ── Stray MSBuild intermediates ──
    internal/x64/
    internal/il2cpp-d.*/
    ```
    Do **not** `rm` the directory — it is root-owned and deleting it is a
    permissions problem, not a code problem.
    Verify: `git status --short internal/ | head` no longer lists it.

## Verification

```bash
bash internal/tools/wsl-build.sh Debug     # expect: 0 Error(s), 0 Warning(s)
bash internal/tools/check-raw-access.sh    # expect: exit 0, no output
cd client && npx tsc --noEmit -p tsconfig.json   # exit 0, no output
```

Project-file consistency (must print two empty lists):

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

Greps that must return **zero** results when this plan is complete:

```bash
ls /home/jesse/realm-engine-client/internal/tools/check-raw-access.ps1 2>/dev/null

grep -rn 'check-raw-access.ps1' /home/jesse/realm-engine-client \
  --include='*.md' --include='*.bat' --include='*.sh' --include='*.json' \
  | grep -v '/docs/plans/'

grep -rn 'version.dll' /home/jesse/realm-engine-client/internal/

grep -n 'FeatMagnetAim' /home/jesse/realm-engine-client/internal/src/features/movement/dodge/ProjectileTracking.cpp

grep -rn 'ProjectileSimulator' /home/jesse/realm-engine-client/client/src /home/jesse/realm-engine-client/client/plugins
```

(The `version.dll` grep excludes `client/build-tools/clean-wipe.bat`, which
legitimately deletes a legacy artifact from the game directory — that one stays.)

## Out of scope

- **Do NOT touch `client/build-tools/dev-build.bat` or `sync-and-build.bat`.**
  Both are modified in the working tree right now and are the developer's live
  build loop. Adding a guardrail invocation there is tempting but would conflict
  with uncommitted work; propose it separately.
- **Do NOT touch `client/build-tools/clean-wipe.bat`.** Its `version.dll`
  deletions are correct cleanup for a legacy artifact that may still be sitting
  in someone's game directory.
- **Do NOT delete `client/src/state/ProjectileTracker.ts`.** It has a live
  consumer (`plugins/anti-debuffs.ts:248`).
- **Do NOT delete `internal/src/core/logging/helpers.h`** or any other
  Il2CppInspectorPro-generated file — only the unused `#include` of it.
- **Do NOT change any `OutDir` / `TargetName` / `Configuration` in the
  `.vcxproj`.** The batch file is what is wrong, not the project.
- **Do NOT re-port the missing `.ps1` checks.** The decision is one
  implementation, not two better-synced ones.
- **Do NOT remove `BootGate`'s unused `kFeatures` rows** — plan 105 owns them.
- **Do NOT run a broad unused-include sweep across all 223 source files.**
  Step 8 is scoped to the ten files recent work churned, one build per file.
