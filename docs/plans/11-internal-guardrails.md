# 11 — Internal guardrails: forbid new raw access

## Goal
A checked-in script, `internal/tools/check-raw-access.ps1` (PowerShell — runs on
the Windows build host) plus an equivalent `check-raw-access.sh` for WSL/CI,
fails with a nonzero exit when a forbidden raw pattern reappears in feature/GUI
code, and `internal/build-and-test.bat` runs it after a successful build. This
makes the migration one-way: new code cannot quietly re-introduce local
`AddrOk` copies, open-coded offset reads, private dict-layout constants, or
bare `MH_CreateHook` calls outside the sanctioned layers.

## Dependencies
MUST merge last of the internal chain: after **04, 05, 06, 07, 08** (the greps
must already be clean) and ideally after **09, 10**. Touches only
`internal/tools/` (new files) and `internal/build-and-test.bat`.

## Current state
`internal/build-and-test.bat` builds Release|x64 via MSBuild and tails the trace
log; it has no static checks. `internal/tools/` exists for auxiliary tooling.
After plans 04–08 the following greps return empty — this plan freezes that.

## Target design
`internal/tools/check-raw-access.sh` (bash; the .ps1 mirrors it):
```bash
#!/usr/bin/env bash
# Guardrail: forbidden raw-access patterns in feature/GUI code.
# Sanctioned homes: core/runtime/MemRead.h, core/il2cpp/Il2CppContainers.*,
# platform/hooks/Il2CppHook.*, core/runtime/* (infrastructure).
set -u
root="$(cd "$(dirname "$0")/../src" && pwd)"
fail=0
check() { # $1=label $2=grep-args... ; any hit = failure
  local label="$1"; shift
  local hits; hits="$(grep -rn "$@" 2>/dev/null)"
  if [ -n "$hits" ]; then echo "FORBIDDEN [$label]:"; echo "$hits"; fail=1; fi
}
scope_feat="$root/features $root/gui"
# 1. Local pointer-validity copies (use Mem::AddrOk)
check "local AddrOk"      -E 'bool (AddrOk|AddrValid)\(' $scope_feat
# 2. Open-coded offset reads (use Mem::TryRead/ReadOr or Game:: wrappers)
check "raw offset read"   -E 'reinterpret_cast<[^>]*>\([^;]*RuntimeOffsets::' $scope_feat
# 3. Private IL2CPP container layout constants (use Il2CppC::)
check "dict layout consts" -E 'kDict_|kOffDict|OFF_DICT_|kEntryStride|kEntrySize|OFF_ARR_|kArr_(MaxLen|Data)' $scope_feat
# 4. Bare MinHook installs (use Il2CppHook::InstallMinHook)
check "bare MH_CreateHook" -F 'MH_CreateHook' $scope_feat
exit $fail
```
Notes for the implementer:
- Pattern 4 must NOT flag `platform/hooks/` (the sanctioned home) — scope is
  features+gui only, which the `$scope_feat` variable already enforces.
- If plan 06 kept any commented hot-loop raw reads in
  `features/projectiles/`, add a `// raw-access-ok:` suppression convention:
  filter lines matching `raw-access-ok` out of check 2 (`| grep -v 'raw-access-ok'`),
  and require the comment on the same line.
- The `.ps1` version uses `Select-String` with the same regexes and `exit 1`
  on any hit.

`internal/build-and-test.bat`: after the MSBuild success branch, add
```bat
echo === [2.5/3] Raw-access guardrails ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\check-raw-access.ps1"
if errorlevel 1 ( echo GUARDRAIL FAILURE — see above & exit /b 1 )
```

## Steps
1. Create `internal/tools/check-raw-access.sh` and `check-raw-access.ps1` with
   the four checks. Run the .sh from WSL against the migrated tree — it must
   exit 0. If it flags stragglers, list them and STOP: the straggler belongs to
   whichever consumer plan owns that subtree (report it; do not fix here beyond
   trivial mechanical conversion identical to that plan's pattern).
2. Wire the `.ps1` into `internal/build-and-test.bat` after the build step.
3. Document the rule: add a short "Raw access is forbidden in features/ and
   gui/ — use Mem::, Il2CppC::, Il2CppHook::, Game::" paragraph to
   `internal/CLAUDE.md` under "Source layout".

## Verification
- `bash internal/tools/check-raw-access.sh` → exit 0, no output.
- Negative test: temporarily add `static bool AddrOk(const void*p){return p;}`
  to any feature file, run the script → exit 1 naming the file; revert.
- `internal/build-and-test.bat` still builds and now runs the check (verify the
  new banner appears).

## Out of scope
- No source-file changes under `internal/src/` except `CLAUDE.md`-adjacent docs;
  stragglers get reported to their owning plan, not patched ad hoc.
- No CI pipeline creation (there is none in-repo); the .bat hook is the gate.
