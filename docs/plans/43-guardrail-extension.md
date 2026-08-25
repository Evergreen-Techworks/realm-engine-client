# 43 — Guardrail Extension (checks 9-11)

## Goal
`internal/tools/check-raw-access.sh` gains three new checks that close the
gaps the 2026-08-18 adoption audit found: raw method resolution in `gui/`
(check 8 today only scopes `features/`), private per-field IL2CPP resolution
(`il2cpp_class_get_field_from_name`) anywhere in `features/`+`gui/`, and raw
hex-literal pointer-offset casts (the C-style-cast form that evades check
2's `reinterpret_cast`-only pattern). After this plan, every violation
pattern named in `docs/plans/36-adoption-overview.md` has a permanent
ratchet, matching the existing checks 1-8 in style and scope.

## Dependencies
- **Plans 37, 38, 39, 40, 41, and 42 must ALL be merged first.** This plan's
  new checks are written to be green against the POST-migration tree; if
  run before 39-42 land, checks 9 and 10 fail on the exact call sites those
  plans remove (see "Current state" for the list). This plan **must run
  last in the wave** — it is the guardrail-extension step described in the
  overview's dependency graph (`37,38 → 39,40,41,42 → 43`).
- Not parallel-safe with anything in this wave in the sense that it must be
  ordered after all of them; it IS parallel-safe with unrelated work
  elsewhere in the repo (it touches exactly one file).
- **Cross-wave note:** the concurrent dodge program (plans 30-35) only RUNS
  this script; it does not modify it. This plan's new checks explicitly
  exclude `features/movement/{repp,pjdodge,dodge,zdodge,udodge}/` (see
  "Divergence warnings" — one of those directories has a pre-existing,
  legitimately-out-of-scope hit on the check-10 pattern today). If a NEW
  hit appears in one of those directories after this plan merges, that is
  the dodge program's concern, not something to "fix" by editing those
  directories from here or by loosening the exclusion.

Files touched (no other plan in this wave touches this file):
- `internal/tools/check-raw-access.sh`

Do NOT touch `internal/tools/check-raw-access.ps1` (the Windows mirror
`build-and-test.bat` runs) unless you also intend to keep it in lock-step —
see "Out of scope".
Do NOT touch any `.cpp`/`.h` file. Do NOT touch
`internal/src/features/movement/{repp,pjdodge,dodge,zdodge,udodge}/`.

## Current state

`internal/tools/check-raw-access.sh` (97 lines) runs 8 checks today, scoped
via `scope_feat=("$root/features" "$root/gui")` (line 43) except where noted:

1. Local `AddrOk`/`AddrValid` copies (`features/`+`gui/`).
2. Open-coded `reinterpret_cast<...>(...RuntimeOffsets::...)` reads,
   exempted by a same-line `raw-access-ok` marker (`features/`+`gui/`).
3. Private dict/array layout constants (`features/`+`gui/`).
4. Bare `MH_CreateHook` (`features/`+`gui/`).
5. Offset aliasing — a local name reference-bound to a `RuntimeOffsets::`
   member (`features/`+`gui/`).
6. Inline `0x7FFFFFFFFFFF` `AddrOk` ceiling literal (`features/`+`gui/`).
7. Hardcoded camera offset names `OFF_CM_TRANSFORM`/`OFF_CM_UNITY_CAM`
   (`gui/` only).
8. Direct `il2cpp_class_get_method_from_name` — **`"$root/features"` only**
   (`check-raw-access.sh:88-94`):
   ```bash
   hits8="$(grep -rnF 'il2cpp_class_get_method_from_name' "$root/features" 2>/dev/null | grep -v 'raw-access-ok')"
   if [ -n "$hits8" ]; then
     echo "FORBIDDEN [direct method resolution in features/]:"
     echo "$hits8"
     fail=1
   fi
   ```
   Nothing scopes `gui/` for this pattern, which is exactly why
   `gui/tabs/CameraTAB.cpp`'s 11 call sites (removed by plan 42) were never
   caught.

None of checks 1-8 catch:
- `il2cpp_class_get_field_from_name` (private per-field resolution — no
  check targets this API at all today).
- A C-style pointer cast with a hex-literal offset, e.g.
  `*(float*)((uint8_t*)p + 0x3C)` — check 2's regex requires the literal
  substring `reinterpret_cast<`, so a C-style cast (`(float*)(...)`) is
  invisible to it regardless of whether the offset is `RuntimeOffsets::X`
  or a bare hex literal.

Verified counts on the current tree (before plans 39-42 merge; paths
relative to `internal/src/`):

**`il2cpp_class_get_field_from_name` in `features/`+`gui/`** (9 hits today,
excluding the sanctioned dodge-program hit below):
```
features/movement/collider/PlayerCollider.cpp:39     (removed by plan 40)
features/combat/autonexus/AutoNexus.cpp:597           (removed by plan 39)
features/combat/autoability/AutoAbility.cpp:64        (removed by plan 39)
features/combat/autoaim/ProjNoclip.cpp:157,164,173    (removed by plan 40)
gui/tabs/PlayerTAB.cpp:43                              (removed by plan 42)
gui/tabs/WorldTAB.cpp:2322                             (removed by plan 41)
```
Plus one PRE-EXISTING, permanently-out-of-scope hit:
```
features/movement/dodge/ProjectileTracking.cpp:109
```
This resolves `HBEAKBIHANL.KDAJOMOFMJB` (the native per-shot speed
multiplier) — it is dodge-program territory (`features/movement/dodge/`),
explicitly excluded from this entire wave by the overview
(`docs/plans/36-adoption-overview.md` "Scope exclusions (hard)"). It is
NOT one of the fields plan 37 added to the registry and is not touched by
any plan in this wave. A check that does not exclude this directory would
never go green.

**`il2cpp_class_get_method_from_name` in `gui/`** (11 hits today, all in
`gui/tabs/CameraTAB.cpp` — removed by plan 42; verified no other file under
`gui/` uses this API).

**C-style hex-literal pointer-offset casts in `features/`+`gui/`** (6 hits
today):
```
gui/CamState.cpp:29,30                  (removed by plan 41)
gui/tabs/TestTAB.cpp:797,798,799,800    (removed by plan 40)
```
Note `gui/tabs/TestTAB.cpp:413-414` also uses a C-style cast
(`*(int32_t*)((uint8_t*)lp + RuntimeOffsets::HP)`) but names
`RuntimeOffsets::HP`/`MaxHP` instead of a hex literal, and is untouched by
any plan in this wave — the new check's pattern (below) is deliberately
written to require a trailing hex literal so it does NOT flag this line.

## Target design

Three new checks, appended to `check-raw-access.sh` after check 8
(before the final `exit $fail` at line 96), following the existing script's
two idioms: the `check()` helper function for simple always-fail patterns,
and inline `hits9=/hits10=/hits11=` variables (matching checks 2, 5, 6, 8)
for patterns that need a `grep -v` exclusion.

```bash
# 9. Direct il2cpp_class_get_method_from_name in gui/ (use Il2CppHook::
#    ResolveMethod*). Mirrors check 8, which only scopes features/.
hits9="$(grep -rnF 'il2cpp_class_get_method_from_name' "$root/gui" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits9" ]; then
  echo "FORBIDDEN [direct method resolution in gui/]:"
  echo "$hits9"
  fail=1
fi

# 10. Direct il2cpp_class_get_field_from_name in features/+gui/ (use
#     RuntimeOffsets:: table entries, or Mem:: primitives once you have the
#     offset). The concurrent dodge program (docs/plans/30-35) owns
#     features/movement/{repp,pjdodge,dodge,zdodge,udodge}/ and is excluded
#     here — same hard boundary as the adoption-sweep wave's scope
#     exclusions (docs/plans/36-adoption-overview.md). A hit inside those
#     directories is the dodge program's concern, not this ratchet's.
hits10="$(grep -rnF 'il2cpp_class_get_field_from_name' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'raw-access-ok' \
  | grep -vE '/movement/(repp|pjdodge|dodge|zdodge|udodge)/')"
if [ -n "$hits10" ]; then
  echo "FORBIDDEN [private field resolution]:"
  echo "$hits10"
  fail=1
fi

# 11. Raw hex-literal pointer-offset casts, e.g.
#     *(float*)((uint8_t*)p + 0x3C) — the C-style-cast form of check 2's
#     reinterpret_cast pattern. Use Mem::TryRead / Mem::TryWrite. Only
#     matches a trailing 0x literal, so a cast that already names
#     RuntimeOffsets::X (just via a C-style cast instead of
#     reinterpret_cast) is not flagged — that is a smaller, still-sanctioned
#     step this check does not require in one motion. A same-line
#     raw-access-ok marker exempts a justified hot-loop case.
hits11="$(grep -rnE '\*\([A-Za-z_][A-Za-z0-9_]*\*\)\(\([A-Za-z_][A-Za-z0-9_]*\*\)[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\+[[:space:]]*0x' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits11" ]; then
  echo "FORBIDDEN [raw hex pointer cast]:"
  echo "$hits11"
  fail=1
fi
```

`scope_feat` is already defined at `check-raw-access.sh:43`; checks 10 and
11 reuse it exactly like checks 1-6. Check 9 does not use `scope_feat` — it
intentionally scopes `"$root/gui"` only (mirroring check 8's
`"$root/features"`-only scope; a feature/ hit on this pattern is already
caught by check 8).

### Divergence warnings
- The dodge-directory exclusion in check 10 is a **directory-path**
  exclusion (`grep -vE '/movement/(repp|pjdodge|dodge|zdodge|udodge)/'`),
  not a marker-based one. This differs in kind from every other exemption
  mechanism in this script (which are all same-line `raw-access-ok`
  comments). It is necessary because the pattern being checked
  (`il2cpp_class_get_field_from_name`) has a real, currently-legitimate use
  inside dodge-program territory that this wave has no mandate to touch or
  annotate. Do not extend this style of exclusion to any other directory or
  any other check without a similarly documented reason — prefer
  `raw-access-ok` markers everywhere else.

## Steps

### Step 1 — Add checks 9, 10, 11
File: `internal/tools/check-raw-access.sh`

Insert the three new check blocks from "Target design" immediately after
check 8's closing `fi` (after line 94) and before the trailing blank line
and `exit $fail` (currently lines 95-96). Keep the numbering comment style
identical to the existing checks (`# 9. ...`, `# 10. ...`, `# 11. ...`).
Also update the file's top-of-file summary comment (`check-raw-access.sh:6-11`),
which today reads:
```
# once features/ and gui/ read memory through Mem::, walk containers through
# Il2CppC::, install hooks through Il2CppHook::, and talk to game objects
# through Game::, new code cannot quietly re-introduce a local AddrOk copy, an
# open-coded offset read, a private dict-layout constant, a bare MH_CreateHook,
# an offset ALIAS that hides a raw read from check 2 (check 5), or an inline
# copy of the AddrOk ceiling bound (check 6). Any hit exits nonzero.
```
Extend the last two lines to also name the three new checks, e.g.:
```
# an offset ALIAS that hides a raw read from check 2 (check 5), an inline
# copy of the AddrOk ceiling bound (check 6), a method-resolution call in
# gui/ (check 9), a private per-field resolution (check 10), or a raw
# hex-offset pointer cast (check 11). Any hit exits nonzero.
```

**Verify:** `bash internal/tools/check-raw-access.sh` — run it against the
CURRENT tree first (before any of plans 39-42 have merged, if you are
executing this plan out of order for testing purposes only). It is EXPECTED
to fail at this point, printing the exact `file:line` lists in "Current
state" above for checks 9 and 10, and (if plan 41/40 have not yet merged)
check 11. This confirms the new checks fire correctly. Do NOT attempt to
"fix" those hits from this plan — this plan only edits the shell script.

### Step 2 — Confirm green after the real dependency order
This step is a re-statement of the dependency contract, not new script
work: once plans 37, 38, 39, 40, 41, and 42 are ALL merged into the branch
this plan also merges into, re-run:
```bash
bash internal/tools/check-raw-access.sh
```
Expected: exit 0, no `FORBIDDEN` output at all (checks 1-11 all clean).

**Verify:** `bash internal/tools/wsl-build.sh Debug` (this plan does not
touch any compiled source, but the wave's standing rule is every plan ends
green on the full verification pair) and
`bash internal/tools/check-raw-access.sh`.

## Verification
```bash
# The script itself is well-formed bash:
bash -n internal/tools/check-raw-access.sh

# After plans 37-42 are ALL merged:
bash internal/tools/wsl-build.sh Debug            # 0 warnings / 0 errors
bash internal/tools/check-raw-access.sh            # exit 0, no FORBIDDEN lines

# The three new checks exist in the script (expect 3 hits):
grep -c '^# 9\.\|^# 10\.\|^# 11\.' internal/tools/check-raw-access.sh

# Sanity: re-run the exact grep each check uses and confirm zero output
# once 37-42 are merged (mirrors what the script itself does):
grep -rnF 'il2cpp_class_get_method_from_name' internal/src/gui | grep -v 'raw-access-ok'
grep -rnF 'il2cpp_class_get_field_from_name' internal/src/features internal/src/gui \
  | grep -v 'raw-access-ok' | grep -vE '/movement/(repp|pjdodge|dodge|zdodge|udodge)/'
grep -rnE '\*\([A-Za-z_][A-Za-z0-9_]*\*\)\(\([A-Za-z_][A-Za-z0-9_]*\*\)[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\+[[:space:]]*0x' \
  internal/src/features internal/src/gui | grep -v 'raw-access-ok'
```
All three grep commands above must print nothing once plans 37-42 are
merged.

## Out of scope
- `internal/tools/check-raw-access.ps1` — the PowerShell mirror invoked by
  `build-and-test.bat` on Windows. The overview and this wave's other plans
  only exercise `wsl-build.sh` / the `.sh` guardrail; keeping the `.ps1`
  mirror in sync (if one exists with equivalent checks) is a separate,
  Windows-workflow-specific follow-up, not part of this plan. Do not edit
  it here.
- Any check targeting the "reinterpret_cast bound to a by-value `uint32_t`
  offset parameter" evasion (e.g. what `PlayerTAB.cpp`'s pre-migration
  `ReadEquipmentSlots` did — passing a resolved offset as a plain function
  parameter instead of naming `RuntimeOffsets::X` on the read line). This
  evades checks 2 and 5 today and is not one of the three named gaps this
  plan closes; flagging it is out of scope here.
- Adding checks for anything not explicitly named in
  `docs/plans/36-adoption-overview.md`'s audit findings.
- Editing `.cpp`/`.h` files to make checks 9-11 pass — that is plans
  39-42's job, already merged by the time this plan runs.
