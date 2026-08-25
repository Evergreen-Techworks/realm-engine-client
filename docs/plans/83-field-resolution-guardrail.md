# 83 — Guardrail: Forbid Private Field-Offset Resolution in features/

## Goal
After this plan, `internal/tools/check-raw-access.sh` fails if any file under
`features/` calls `il2cpp_field_get_offset` (and, closing the movement-dir loophole,
`il2cpp_class_get_field_from_name` in the movement dodge tree). This ratchets the
plan-82 cleanup in place so a future feature cannot quietly re-introduce a private,
off-registry offset resolver — all field-offset resolution must go through
`RuntimeOffsets`. This is a guardrail-only change; it touches no source and cannot
change runtime behavior.

## Dependencies
- **Plan 82 must be merged first.** Its deletion of `EnsureHbeakSpeedMulFieldOffset`
  removes the only `il2cpp_field_get_offset` in `features/` and the only
  `il2cpp_class_get_field_from_name` in `features/movement/`. Until 82 lands, the new
  checks would flag existing code and the ratchet would (correctly) fail — so this
  plan cannot be verified before 82.
- Files touched: `internal/tools/check-raw-access.sh` only. Independent of plan 81.

## Current state
`internal/tools/check-raw-access.sh`:
- **Check 10** forbids `il2cpp_class_get_field_from_name` in `features/` + `gui/`, but
  explicitly EXEMPTS the dodge dirs:
  ```bash
  hits10="$(grep -rnF 'il2cpp_class_get_field_from_name' "${scope_feat[@]}" 2>/dev/null \
    | grep -v 'raw-access-ok' \
    | grep -vE '/movement/(repp|pjdodge|dodge|zdodge|udodge)/')"
  ```
  That exemption is why plan 82's now-deleted resolver was never caught.
- There is **no** check for `il2cpp_field_get_offset` — the deeper primitive. It is
  the exact call a private resolver uses after `il2cpp_class_get_field_from_name`, and
  after plan 82 there are zero occurrences of it in `features/` (confirmed: the only
  one was in `ProjectileTracking.cpp`).

Baseline confirmation commands (run BEFORE editing; both must already be empty once 82
is merged):
```bash
command grep -rn 'il2cpp_field_get_offset' internal/src/features/                       # -> empty
command grep -rn 'il2cpp_class_get_field_from_name' internal/src/features/movement/     # -> empty
```
If either is non-empty, STOP — plan 82 is not fully merged; do not proceed.

## Target design
Add one new check and tighten check 10. Follow the file's existing `check`/`hits`
idiom (a same-line `raw-access-ok` marker stays honored as the documented escape
hatch, consistent with every other check).

New check (append near the other IL2CPP-primitive checks, after check 11):
```bash
# 12. Direct il2cpp_field_get_offset in features/ (resolve offsets through the
#     RuntimeOffsets table, not a private per-feature resolver). This is the
#     primitive a parallel offset resolver uses; keeping it out of features/
#     forces all field-offset resolution through the self-healing registry.
#     A same-line raw-access-ok marker exempts a justified case.
hits12="$(grep -rnF 'il2cpp_field_get_offset' "$root/features" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits12" ]; then
  echo "FORBIDDEN [private field-offset resolution]:"
  echo "$hits12"
  fail=1
fi
```

Tighten check 10: remove the `/movement/(repp|pjdodge|dodge|zdodge|udodge)/`
exclusion so `il2cpp_class_get_field_from_name` is forbidden across ALL of
`features/` + `gui/`, matching the now-clean tree. New check 10 body:
```bash
hits10="$(grep -rnF 'il2cpp_class_get_field_from_name' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'raw-access-ok')"
```
Update check 10's comment to drop the movement-dir carve-out note.

## Steps

1. **Confirm the tree is clean (precondition).** Run the two baseline greps above;
   both must be empty. If not, stop — 82 is incomplete.

2. **Add check 12.** Append the `il2cpp_field_get_offset` block after check 11 in
   `internal/tools/check-raw-access.sh` (before `exit $fail`). Run:
   ```bash
   bash internal/tools/check-raw-access.sh   # expect exit 0
   ```

3. **Tighten check 10.** Remove the movement-dir `grep -vE` exclusion and update the
   comment. Run:
   ```bash
   bash internal/tools/check-raw-access.sh   # expect exit 0
   ```

4. **Prove the guardrail bites (negative test, then revert).** Temporarily append a
   line `il2cpp_field_get_offset(fi);` to any file under `internal/src/features/`
   (e.g. a comment-free scratch line in `ProjectileTracking.cpp`), run
   `bash internal/tools/check-raw-access.sh`, confirm it now exits non-zero and prints
   `FORBIDDEN [private field-offset resolution]`, then remove the temporary line and
   confirm exit 0 again. Do NOT commit the temporary line.

## Verification
```bash
bash internal/tools/check-raw-access.sh       # exit 0 with the checks in place
# The tree the guardrail protects is clean:
command grep -rn 'il2cpp_field_get_offset' internal/src/features/                       # -> empty
command grep -rn 'il2cpp_class_get_field_from_name' internal/src/features/ internal/src/gui/   # -> empty (excluding raw-access-ok markers)
```
Success = guardrail exit 0 on the current tree, and a non-zero exit when a
`il2cpp_field_get_offset` call is temporarily added under `features/` (step 4).

## Out of scope
- Do NOT modify any source file. This plan edits only the guardrail script.
- Do NOT touch the other checks (1–9, 11), their scopes, or the `raw-access-ok`
  escape-hatch mechanism.
- Do NOT extend the ban to `il2cpp_field_get_value`/`il2cpp_field_set_value` or to
  `core/` — offset resolution is the concern here; core/runtime is the sanctioned
  home and stays exempt.
