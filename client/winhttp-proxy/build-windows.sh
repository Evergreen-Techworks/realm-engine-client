#!/usr/bin/env bash
# Build winhttp.dll from WSL by driving the Windows MSVC toolchain.
#
# Why this exists: build.bat needs an "x64 Native Tools" environment, and cmd.exe
# cannot cd into a \\wsl$\ UNC path — so the sources have to be staged onto the
# Windows drive first. This does that, builds, and copies the DLL back.
#
#   ./build-windows.sh              build; artifact lands in build/winhttp.dll
#   ./build-windows.sh --install    also overwrite client/assets/winhttp.dll
#   ./build-windows.sh --keep       leave the staging tree for inspection
#   ./build-windows.sh --no-test    skip the host logic tests
#
# client/assets/winhttp.dll is the file GameHooker deploys next to the game exe
# (see src/hooker/GameHooker.ts). It is git-tracked, so --install is opt-in
# rather than the default: a plain build never dirties a tracked binary.
set -euo pipefail

cd "$(dirname "$0")"
PROXY_DIR="$PWD"
REPO_ROOT="$(cd ../.. && pwd)"

INSTALL=0
KEEP=0
RUN_TESTS=1
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --keep)    KEEP=1 ;;
    --no-test) RUN_TESTS=0 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── Host logic tests first: they are ~1s and catch the cheap failures ─────────
if [ "$RUN_TESTS" -eq 1 ]; then
  echo "[build] running host logic tests..."
  ./run-logic-tests.sh
  echo
fi

# ── Locate the Windows toolchain ─────────────────────────────────────────────
# Derived from the install root rather than hardcoded, so a VS version bump
# (2022 -> 18 -> whatever is next) does not break this script.
VSWHERE="/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
if [ ! -f "$VSWHERE" ]; then
  echo "[build] ERROR: vswhere.exe not found at $VSWHERE" >&2
  echo "[build] Is Visual Studio with 'Desktop development with C++' installed?" >&2
  exit 1
fi

INSTALL_WIN="$("$VSWHERE" -latest -property installationPath | tr -d '\r')"
if [ -z "$INSTALL_WIN" ]; then
  echo "[build] ERROR: vswhere reported no Visual Studio installation." >&2
  exit 1
fi
INSTALL_WSL="$(printf '%s' "$INSTALL_WIN" | sed 's|^C:|/mnt/c|; s|\\|/|g')"
VCVARS_WSL="$INSTALL_WSL/VC/Auxiliary/Build/vcvars64.bat"
if [ ! -f "$VCVARS_WSL" ]; then
  echo "[build] ERROR: vcvars64.bat not found under $INSTALL_WSL" >&2
  exit 1
fi
VCVARS_WIN="$INSTALL_WIN\\VC\\Auxiliary\\Build\\vcvars64.bat"
echo "[build] toolchain: $INSTALL_WIN"

# ── Stage onto the Windows drive ─────────────────────────────────────────────
# build.bat resolves MinHook as ..\..\internal\vendor\minhook, so the staged
# tree has to preserve that shape.
STAGE_WIN='C:\BuildTmp\winhttp-proxy'
STAGE_WSL='/mnt/c/BuildTmp/winhttp-proxy'

cleanup() { [ "$KEEP" -eq 1 ] || rm -rf "$STAGE_WSL"; }
trap cleanup EXIT

rm -rf "$STAGE_WSL"
mkdir -p "$STAGE_WSL/client" "$STAGE_WSL/internal/vendor"
cp -r "$PROXY_DIR" "$STAGE_WSL/client/"
cp -r "$REPO_ROOT/internal/vendor/minhook" "$STAGE_WSL/internal/vendor/"
rm -rf "$STAGE_WSL/client/winhttp-proxy/.testbuild" "$STAGE_WSL/client/winhttp-proxy/build"

# A wrapper .bat is required: passing the quoted vcvars path straight through
# `cmd.exe /c` from a POSIX shell mangles the quoting and fails to find it.
cat > "$STAGE_WSL/go.bat" <<EOF
@echo off
call "$VCVARS_WIN" >nul
if errorlevel 1 exit /b 1
cd /d $STAGE_WIN\\client\\winhttp-proxy
call build.bat
exit /b %errorlevel%
EOF

echo "[build] compiling..."
( cd "$STAGE_WSL" && cmd.exe /c go.bat )

ARTIFACT="$STAGE_WSL/client/winhttp-proxy/winhttp.dll"
if [ ! -f "$ARTIFACT" ]; then
  echo "[build] ERROR: build reported success but winhttp.dll is missing." >&2
  exit 1
fi

mkdir -p "$PROXY_DIR/build"
cp "$ARTIFACT" "$PROXY_DIR/build/winhttp.dll"
echo "[build] OK -> client/winhttp-proxy/build/winhttp.dll ($(stat -c%s "$PROXY_DIR/build/winhttp.dll") bytes)"

if [ "$INSTALL" -eq 1 ]; then
  cp "$PROXY_DIR/build/winhttp.dll" "$REPO_ROOT/client/assets/winhttp.dll"
  echo "[build] installed -> client/assets/winhttp.dll (git-tracked; commit it to ship)"
else
  echo "[build] not installed. Re-run with --install to overwrite client/assets/winhttp.dll."
fi

if [ "$KEEP" -eq 1 ]; then echo "[build] staging kept at $STAGE_WSL"; fi
exit 0
