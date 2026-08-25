# 29 — Internal Guardrail Update

## Goal
Extend `internal/tools/check-raw-access.sh` with two new checks that prevent
regression of the work done in plans 24-27:

1. **No hardcoded CameraManager offsets** in `gui/tabs/` -- catches
   `OFF_CM_*` or `0x28`/`0x50` paired with "CameraManager" outside
   RuntimeOffsets.
2. **No uncached il2cpp_class_get_method_from_name** in `features/` --
   direct calls that are not going through `Il2CppHook::ResolveMethod` or
   `Il2CppHook::ResolveMethodCached`.

These checks codify the encapsulation boundaries established by plans 24-27
so they cannot silently regress.

## Dependencies
- **Plans 24, 25, 26, 27 should ideally be merged first** so the checks pass
  on the current code. If this plan runs before them, the new checks will
  fail (which is the point -- they are guardrails for migration, not gates).
- No file conflicts with other plans.

Files touched:
- `internal/tools/check-raw-access.sh` (extend with 2 new checks)

## Current state
`check-raw-access.sh` has 6 checks:
1. Local AddrOk copies
2. Open-coded offset reads (reinterpret_cast + RuntimeOffsets)
3. Private IL2CPP container layout constants
4. Bare MH_CreateHook
5. Offset aliasing
6. Inline AddrOk bounds

All currently pass clean (exit 0).

## Target design
Add checks 7 and 8:

### Check 7 -- Hardcoded camera offsets in gui/
Detect `OFF_CM_` or `constexpr.*0x28.*Transform\|constexpr.*0x50.*Camera`
patterns in `gui/tabs/`. These belong in RuntimeOffsets.

### Check 8 -- Direct il2cpp_class_get_method_from_name in features/
Detect bare `il2cpp_class_get_method_from_name` calls in `features/` that
are not going through Il2CppHook. The sanctioned path is
`Il2CppHook::ResolveMethod` or `Il2CppHook::ResolveMethodCached`. A
same-line `raw-access-ok` marker exempts justified exceptions (e.g., a
field-iterator that needs the class pointer for other reasons).

Note: `gui/` is excluded from check 8 because CameraTAB and other GUI
diagnostic tabs legitimately resolve Unity engine methods for display
purposes, and those go through Resolver::Protection::SafeRuntimeInvoke.

## Steps

### Step 1 -- Add check 7 (camera offsets)
File: `internal/tools/check-raw-access.sh`

Add after check 6:
```bash
# 7. Hardcoded CameraManager offsets (use RuntimeOffsets::CM_Transform / CM_UnityCam).
check "hardcoded camera offset" -E 'OFF_CM_TRANSFORM|OFF_CM_UNITY_CAM' "$root/gui"
```

### Step 2 -- Add check 8 (method resolution)
File: `internal/tools/check-raw-access.sh`

Add after check 7:
```bash
# 8. Direct il2cpp_class_get_method_from_name in features/ (use Il2CppHook::ResolveMethod*).
hits8="$(grep -rnF 'il2cpp_class_get_method_from_name' "$root/features" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits8" ]; then
  echo "FORBIDDEN [direct method resolution in features/]:"
  echo "$hits8"
  fail=1
fi
```

**Verify:** `bash internal/tools/check-raw-access.sh`
If plans 24 and 27 are already merged, this should exit 0.
If not, it will report the violations that those plans will fix.

## Verification
```bash
# After plans 24-27 are merged:
bash internal/tools/check-raw-access.sh
# Expected: exit 0

# Spot-check that the new checks actually catch violations:
# (Temporarily add a test line to verify, then remove)
echo 'il2cpp_class_get_method_from_name(k, "test", 0);' > /tmp/test_guard.cpp
grep -nF 'il2cpp_class_get_method_from_name' /tmp/test_guard.cpp
# Expected: matches (confirming the grep pattern works)
rm /tmp/test_guard.cpp
```

## Out of scope
- Adding checks for `Resolver::FindClass` calls in features/ -- those are
  class lookups, not method lookups, and are legitimately needed in some
  places.
- Adding ESLint rules for the client side -- no ESLint config exists.
- Checking gui/ for il2cpp_class_get_method_from_name -- GUI diagnostic
  tabs have legitimate uses.
