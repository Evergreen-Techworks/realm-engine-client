@echo off
REM ===========================================================================
REM  build-windows.bat - run the WSL build from Windows (double-click safe).
REM
REM  The real work lives in build-windows.sh, which must run inside WSL: it
REM  needs bash, and run-logic-tests.sh needs g++.
REM
REM  IMPORTANT: this box has TWO Debian distros and the names are misleading.
REM  "Debian-OLD" is the CURRENT one - it holds the live checkout. The DEFAULT
REM  distro, plain "Debian", is the stale one: an older checkout at the SAME
REM  path (/home/jesse/realm-engine-client) with no winhttp-proxy directory at
REM  all. A bare `wsl ...` picks the default and silently builds the wrong
REM  tree, so -d is always passed explicitly. Override with
REM  set RE_WSL_DISTRO=<name> if the repo ever moves.
REM
REM  Args are passed through: build-windows.bat --install
REM ===========================================================================
setlocal
if "%RE_WSL_DISTRO%"=="" set "RE_WSL_DISTRO=Debian-OLD"
set "REPO=/home/jesse/realm-engine-client"

echo [win] distro: %RE_WSL_DISTRO%
wsl -d %RE_WSL_DISTRO% -- bash -c "cd '%REPO%' && client/winhttp-proxy/build-windows.sh %*"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [win] FAILED with exit code %RC%.
) else (
    echo.
    echo [win] done.
)
REM Unconditional pause: these wrappers exist to be double-clicked, and the
REM window must stay open long enough to read the result. For scripted or
REM piped use, call the .sh directly from WSL instead.
pause
exit /b %RC%
