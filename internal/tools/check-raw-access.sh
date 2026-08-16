#!/usr/bin/env bash
# Guardrail: forbidden raw-access patterns in feature/GUI code.
#
# The internal encapsulation program (docs/plans/00-overview.md) gave the
# cross-cutting primitives a home. This ratchet keeps the migration one-way:
# once features/ and gui/ read memory through Mem::, walk containers through
# Il2CppC::, install hooks through Il2CppHook::, and talk to game objects
# through Game::, new code cannot quietly re-introduce a local AddrOk copy, an
# open-coded offset read, a private dict-layout constant, or a bare
# MH_CreateHook. Any hit exits nonzero.
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
# LINE. There is deliberately no whole-file exemption: every kept raw read must
# carry its own marker so a NEW un-marked read is still caught.
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

exit $fail
