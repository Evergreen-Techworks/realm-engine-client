#!/usr/bin/env bash
# Compile the internal DLL from WSL by driving the Windows VS2022 MSBuild.
#
# Verified working: builds x64/Debug realm-engine.dll clean (0 warnings, 0 errors)
# from a Debian WSL2 shell against the Windows-side Visual Studio 2022 install.
#
# Gotcha this wrapper handles, discovered the hard way:
#   MSVC cl.exe cannot write the PCH / obj intermediates onto the
#   \\wsl.localhost\ 9P path (C1083 on the .pch). Fix: redirect IntDir
#   and OutDir onto the native C: drive. Source is still read over UNC fine.
#
# Prereq: the generated IL2CPP headers must be present in
#   internal/src/game/generated/  (il2cpp-types.h, il2cpp-functions.h,
#   il2cpp-types-ptr.h, il2cpp-api-functions.h, il2cpp-api-functions-ptr.h,
#   il2cpp-metadata-version.h). They are ~94 MB, gitignored, and regenerated
#   per game build with Il2CppInspectorPro (see repo SETUP.md).
#
# Usage:  internal/tools/wsl-build.sh [Debug|Release]
set -euo pipefail

CONFIG="${1:-Debug}"
DISTRO="${WSL_DISTRO_NAME:-Debian}"
REPO_WIN="\\\\wsl.localhost\\${DISTRO}\\home\\jesse\\realm-engine-client\\internal"
SLN="${REPO_WIN}\\il2cpp-dll-injection.sln"
OUT="C:\\rebuild\\${CONFIG}"

VSWHERE="/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
# Derive MSBuild from the install root (robust across VS version bumps, e.g. the
# 2022 -> "18" in-place upgrade that moved the install path). The `-find` form is
# avoided: its component metadata can go stale after an in-place upgrade and
# return nothing.
INSTALL_WIN="$("$VSWHERE" -latest -property installationPath | tr -d '\r')"
INSTALL_WSL="$(printf '%s' "$INSTALL_WIN" | sed 's|^C:|/mnt/c|; s|\\|/|g')"
MSBUILD_WSL="$INSTALL_WSL/MSBuild/Current/Bin/MSBuild.exe"
if [[ ! -f "$MSBUILD_WSL" ]]; then
  MSBUILD_WSL="$(find "$INSTALL_WSL/MSBuild" -name MSBuild.exe -path '*Bin*' 2>/dev/null | head -1)"
fi
if [[ -z "$MSBUILD_WSL" || ! -f "$MSBUILD_WSL" ]]; then
  echo "ERROR: MSBuild.exe not found under $INSTALL_WSL (VS install moved?)." >&2
  exit 1
fi

GEN="$(dirname "$0")/../src/game/generated/il2cpp-types.h"
if [[ ! -f "$GEN" ]]; then
  echo "ERROR: generated IL2CPP headers missing (internal/src/game/generated/)." >&2
  echo "       Regenerate per SETUP.md before building." >&2
  exit 1
fi

echo "=== Building ${CONFIG} | x64  (out: ${OUT}) ==="
"$MSBUILD_WSL" "$SLN" \
  /p:Configuration="${CONFIG}" /p:Platform=x64 \
  /p:IntDir="${OUT}\\obj\\" /p:OutDir="${OUT}\\bin\\" \
  /m /v:minimal /nologo /clp:Summary
echo "=== realm-engine.dll -> ${OUT}\\bin\\realm-engine.dll ==="
