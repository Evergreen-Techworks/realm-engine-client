#!/usr/bin/env bash
# Guardrail: forbidden raw-access patterns in feature/GUI code.
#
# The internal encapsulation program (docs/plans/00-overview.md) gave the
# cross-cutting primitives a home. This ratchet keeps the migration one-way:
# once features/ and gui/ read memory through Mem::, walk containers through
# Il2CppC::, install hooks through Il2CppHook::, and talk to game objects
# through Game::, new code cannot quietly re-introduce a local AddrOk copy, an
# open-coded offset read, a private dict-layout constant, a bare MH_CreateHook,
# an offset ALIAS that hides a raw read from check 2 (check 5), an inline
# copy of the AddrOk ceiling bound (check 6), a method-resolution call in
# gui/ (check 9), a private per-field resolution (check 10), or a raw
# hex-offset pointer cast (check 11). Any hit exits nonzero.
#
# Sanctioned homes (these are WHERE the primitives live, so they are NOT in
# scope below): core/runtime/MemRead.h, core/il2cpp/Il2CppContainers.*,
# platform/hooks/Il2CppHook.*, and the rest of core/runtime/* infrastructure.
# Scope here is features/ + gui/ only.
#
# Hot-loop escape hatch: a raw *reinterpret_cast read that must stay raw for a
# documented reason (e.g. a per-frame field sweep inside one shared __try whose
# fault must abort the whole sweep — see ProjectileRuntimeReader.cpp) is
# exempted from check 2 by putting `raw-access-ok` in a comment ON THE SAME
# LINE (checks 5 and 6 honor the same same-line marker). There is deliberately
# no whole-file exemption: every kept raw read must carry its own marker so a
# NEW un-marked read is still caught.
#
# Usage:  internal/tools/check-raw-access.sh   (exit 0 = clean, 1 = violation)
set -u

root="$(cd "$(dirname "$0")/../src" && pwd)"
fail=0

# check <label> <grep-args...> : any hit is a failure.
check() {
  local label="$1"; shift
  local hits; hits="$(grep -rn "$@" 2>/dev/null)"
  if [ -n "$hits" ]; then
    echo "FORBIDDEN [$label]:"
    echo "$hits"
    fail=1
  fi
}

scope_feat=("$root/features" "$root/gui")

# 1. Local pointer-validity copies (use Mem::AddrOk).
check "local AddrOk" -E 'bool (AddrOk|AddrValid)\(' "${scope_feat[@]}"

# 2. Open-coded offset reads (use Mem::TryRead/ReadOr or Game:: wrappers).
#    Kept hot-loop reads carrying a same-line `raw-access-ok` marker are exempt.
hits2="$(grep -rnE 'reinterpret_cast<[^>]*>\([^;]*RuntimeOffsets::' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits2" ]; then
  echo "FORBIDDEN [raw offset read]:"
  echo "$hits2"
  fail=1
fi

# 3. Private IL2CPP container layout constants (use Il2CppC::).
check "dict layout consts" -E 'kDict_|kOffDict|OFF_DICT_|kEntryStride|kEntrySize|OFF_ARR_|kArr_(MaxLen|Data)' "${scope_feat[@]}"

# 4. Bare MinHook installs (use Il2CppHook::InstallMinHook).
#    platform/hooks/ (the sanctioned home) is out of scope by construction.
check "bare MH_CreateHook" -F 'MH_CreateHook' "${scope_feat[@]}"

# 5. Offset aliasing — binding a local name to a RuntimeOffsets:: member by
#    reference to hide the read site from check 2. Reading RuntimeOffsets::X
#    directly (or passing it straight into Mem::TryRead) is fine and never needs
#    an alias. A same-line `raw-access-ok` marker exempts the rare justified case.
hits5="$(grep -rnE '(&|\bconst[^=]*&)[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*RuntimeOffsets::' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits5" ]; then
  echo "FORBIDDEN [offset aliasing]:"
  echo "$hits5"
  fail=1
fi

# 6. Inline AddrOk bounds — the numeric ceiling literal open-coded outside the
#    sanctioned home (core/runtime/MemRead.h). Use Mem::AddrOk. A same-line
#    `raw-access-ok` marker exempts the rare justified case.
hits6="$(grep -rnF '0x7FFFFFFFFFFF' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits6" ]; then
  echo "FORBIDDEN [inline AddrOk bound]:"
  echo "$hits6"
  fail=1
fi

# 7. Hardcoded CameraManager offsets (use RuntimeOffsets::CM_Transform / CM_UnityCam).
check "hardcoded camera offset" -E 'OFF_CM_TRANSFORM|OFF_CM_UNITY_CAM' "$root/gui"

# 8. Direct il2cpp_class_get_method_from_name in features/ (use Il2CppHook::ResolveMethod*).
hits8="$(grep -rnF 'il2cpp_class_get_method_from_name' "$root/features" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits8" ]; then
  echo "FORBIDDEN [direct method resolution in features/]:"
  echo "$hits8"
  fail=1
fi

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

exit $fail
