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
# gui/ (check 9), a private per-field resolution (check 10), a raw
# hex-offset pointer cast (check 11), a hand-rolled MinHook lifecycle call
# — MH_Initialize / MH_DisableHook / MH_RemoveHook / … — outside
# Il2CppHook::EnsureRuntime / UninstallMinHook (check 15), a private
# BeeByte alias-map scan that re-implements class resolution instead of
# calling GameClasses::Resolve (check 16), a private tile-memo / tile-key
# copy under features/movement instead of Movement::TileSensor (check 17), or
# a hand-written RuntimeOffsets::PosX/PosY read instead of the typed
# Game::Entity::TryPos / TryPosFinite accessor (check 18), or a bare-name
# include of an autoaim header / a resurrected killaura|autofire|autobreak
# sibling directory (check 19). The bare-name form only ever resolved because
# $(ProjectDir)src\features\combat\autoaim used to sit in
# <AdditionalIncludeDirectories>; docs/plans/106 deleted that entry and it must
# NOT be reintroduced — every autoaim header is included by its full subpath,
# features/combat/autoaim/<core|shoot|modes|ui>/<Header>.h.
# Any hit exits nonzero.
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
# SOLE IMPLEMENTATION. This file carries all 18 checks and there is no Windows
# mirror: the former PowerShell copy that used to sit beside it had drifted to
# 6 of them and was deleted in docs/plans/104. On Windows, build-and-test.bat
# shells into WSL (`wsl bash -c "... bash tools/check-raw-access.sh"`) to run
# THIS file, and prints a loud GUARDRAIL SKIPPED if wsl.exe is unavailable. Add
# new checks here only — do not start a second implementation in another
# language.
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
#     offset). Forbidden across all of features/ + gui/; a same-line
#     raw-access-ok marker exempts a justified case.
hits10="$(grep -rnF 'il2cpp_class_get_field_from_name' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'raw-access-ok')"
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

# 13. Shoot/aim method tokens outside their sanctioned homes. AimHooks HOOKS
#     these; ShootRuntime CALLS them. A third site means someone re-bound the
#     shoot path privately instead of routing through those two.
hits13="$(grep -rnE 'ELCBJAFBLJG|EHGHCACPAGH|PMIANFBMMNN' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autoaim/shoot/AimHooks.cpp' | grep -v 'autoaim/shoot/ShootRuntime.cpp' \
  | grep -v 'raw-access-ok')"
if [ -n "$hits13" ]; then
  echo "FORBIDDEN [private shoot-method binding]:"; echo "$hits13"; fail=1
fi

# 14. KillAura's forced-target override has exactly ONE owner (auto-break-walls).
#     A second caller would silently fight it for the target.
hits14="$(grep -rn 'KillAura::SetForcedTargetId' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'autoaim/modes/AutoBreakWalls.cpp' | grep -v 'raw-access-ok')"
if [ -n "$hits14" ]; then
  echo "FORBIDDEN [second forced-target owner]:"; echo "$hits14"; fail=1
fi

# 15. Bare MinHook lifecycle calls in features/ + gui/. Check 4 already bans
#     MH_CreateHook; this closes the other two thirds of the same concern.
#     Use Il2CppHook::EnsureRuntime / InstallMinHook / UninstallMinHook. The
#     process-wide teardown (MH_DisableHook(MH_ALL_HOOKS) + MH_Uninitialize)
#     lives in platform/hooks/InitHooks.cpp and is out of scope by
#     construction. A same-line raw-access-ok marker exempts a justified case.
hits15="$(grep -rnE '\bMH_(Initialize|Uninitialize|EnableHook|DisableHook|RemoveHook|ApplyQueued|QueueEnableHook|QueueDisableHook)\b' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits15" ]; then
  echo "FORBIDDEN [bare MinHook lifecycle]:"; echo "$hits15"; fail=1
fi

# 16. Private BeeByte alias-map scans in features/ + gui/. Resolving a class
#     by scanning Beebyte::GetMap() is GameClasses::Resolve's job — a private
#     copy is how WorldTAB and ProjectileTracking ended up resolving the SAME
#     class with different robustness. Reading the map for DISPLAY
#     (Beebyte::Deobf in the inspector UI) is fine and not matched here.
hits16="$(grep -rnF 'Beebyte::GetMap' "${scope_feat[@]}" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits16" ]; then
  echo "FORBIDDEN [private BeeByte alias scan]:"; echo "$hits16"; fail=1
fi

# 17. Private tile-memo / tile-key copies under features/movement. The hazard
#     memo and the tile-key packing live in
#     features/movement/sensors/TileSensor.h; before that they were duplicated
#     byte-for-byte across four sensor modules (one of which used a different
#     container). A same-line raw-access-ok marker exempts a justified case.
hits17="$(grep -rnE 'kMemoSlots|kMemoEmpty|\bMemoFind\(|\bMemoInsert\(|uint32_t TileKey\(int' "$root/features/movement" 2>/dev/null \
  | grep -v 'sensors/TileSensor' | grep -v 'raw-access-ok')"
if [ -n "$hits17" ]; then
  echo "FORBIDDEN [private tile memo/key]:"; echo "$hits17"; fail=1
fi

# 18. Hand-written entity-position reads in features/ + gui/. PosX/PosY have
#     a typed accessor (Game::Entity::TryPos / TryPosFinite in
#     game/objects/GameObjects.h); pairing a raw void* with the two offset
#     keys is what this program removed. The documented hot-loop __try sweeps
#     keep their same-line raw-access-ok markers and are exempt. TestTAB.cpp's
#     PosX/PosY uses are teleport WRITES (Mem::TryWrite), gated by plan 105's
#     TeleportOffsetsTrusted() — they carry their own same-line markers now, so
#     the temporary whole-file exclusion this check used to carry is gone.
hits18="$(grep -rnE 'RuntimeOffsets::Pos[XY]' "${scope_feat[@]}" 2>/dev/null \
  | grep -v 'raw-access-ok')"
if [ -n "$hits18" ]; then
  echo "FORBIDDEN [hand-written entity position read]:"; echo "$hits18"; fail=1
fi

# 19. The aim/shoot family is ONE directory: features/combat/autoaim, grouped
#     into core/ shoot/ modes/ ui/ (docs/plans/106). Two things creep back:
#     (a) a bare-name include of an autoaim header, which only ever worked
#         because features\combat\autoaim used to be on the include path;
#     (b) a new sibling directory (killaura/, autofire/, autobreak/) or a stale
#         path to one.
hits19a="$(grep -rnE '#include "(AutoAim|AimHooks|AimMath|TargetSelector|WeaponProfile|ShootRuntime|ProjNoclip|FeatAutoAim|FeatMagnetAim|KillAura|AutoFire|AutoBreakWalls)\.h"' \
  "${scope_feat[@]}" "$root/platform" 2>/dev/null | grep -v 'raw-access-ok')"
if [ -n "$hits19a" ]; then
  echo "FORBIDDEN [bare-name autoaim include — use features/combat/autoaim/<group>/X.h]:"
  echo "$hits19a"; fail=1
fi
hits19b="$(grep -rnE 'features/combat/(killaura|autofire|autobreak)/' "$root" 2>/dev/null)"
if [ -n "$hits19b" ]; then
  echo "FORBIDDEN [retired autoaim sibling directory]:"
  echo "$hits19b"; fail=1
fi

exit $fail
