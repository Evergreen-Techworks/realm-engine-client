@echo off
setlocal enabledelayedexpansion

REM First arg selects build type:  (default) installer+portable | "portable"
set "MODE=%~1"

REM sync-and-build.bat — mirror WSL source → Windows, then build the installer.
REM
REM Env-var overrides:
REM   WSL_DISTRO    WSL distro name            (default: Debian-OLD)
REM   WSL_USER      WSL login user             (default: auto via wsl whoami)
REM   WSL_PARENT    project root in WSL        (default: auto-detect ~/realm-engine-client, ~/realmengine or ~/realm-engine)
REM   WIN_BASE      Windows destination dir    (default: %USERPROFILE%\Desktop\test)
REM   CLIENT_DIR    client folder name         (default: auto)
REM   INTERNAL_DIR  internal folder name       (default: auto)

REM ── Defaults ────────────────────────────────────────────────────────────────
if "!WSL_DISTRO!"==""   set "WSL_DISTRO=Debian-OLD"
if "!WSL_USER!"=="" (
    for /f "delims=" %%I in ('wsl -d !WSL_DISTRO! whoami 2^>nul') do set "WSL_USER=%%I"
    if "!WSL_USER!"=="" set "WSL_USER=%USERNAME%"
)
REM realm-engine-client (this repo) is checked FIRST — ~/realm-engine is a
REM different project (bot pipeline) that also has a client/ folder, so it
REM must never win the auto-detect when both trees exist.
if "!WSL_PARENT!"=="" (
    if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realmengine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realmengine"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realmengine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realmengine"
    ) else if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    ) else (
        echo [sync] ERROR: Couldn't find realm-engine-client\client, realmengine\client or realm-engine\client under \\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\
        echo [sync] - Make sure WSL is running and your dev tree is at ~/realmengine/client
        echo [sync] - Or set WSL_PARENT manually before running this script.
        pause
        exit /b 1
    )
)
if "!WIN_BASE!"==""     set "WIN_BASE=%USERPROFILE%\Desktop\test"

REM ── Detect WSL mount path ───────────────────────────────────────────────────
set "WSL_BASE="
if exist "\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!" set "WSL_BASE=\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!"
if exist "\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"          set "WSL_BASE=\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"

if "!WSL_BASE!"=="" (
    echo [sync] ERROR: Cannot find WSL mount at \\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!
    echo [sync] Set WSL_DISTRO / WSL_USER / WSL_PARENT in your environment to override.
    pause
    exit /b 1
)

REM ── Detect repo names ───────────────────────────────────────────────────────
if "!CLIENT_DIR!"=="" (
    if exist "!WSL_BASE!\client" set "CLIENT_DIR=client"
)
if "!INTERNAL_DIR!"=="" (
    if exist "!WSL_BASE!\internal" set "INTERNAL_DIR=internal"
)

if "!CLIENT_DIR!"=="" (
    echo [sync] ERROR: 'client' not found under !WSL_BASE!
    pause
    exit /b 1
)
if "!INTERNAL_DIR!"=="" (
    echo [sync] ERROR: 'internal' not found under !WSL_BASE!
    pause
    exit /b 1
)

echo [sync] Source: !WSL_BASE!
echo [sync] Dest  : !WIN_BASE!
echo [sync] Repos : !CLIENT_DIR! + !INTERNAL_DIR!

REM ── Sync client ─────────────────────────────────────────────────────────────
echo.
echo [sync] Mirroring !CLIENT_DIR!...
robocopy "!WSL_BASE!\!CLIENT_DIR!" "!WIN_BASE!\!CLIENT_DIR!" ^
    /MIR /R:3 /W:2 /NFL /NDL /NP /NJH /NJS ^
    /XD node_modules dist release .git .vs "electron\native\build" ^
    /XF sync-and-build.bat
if !ERRORLEVEL! GEQ 8 (
    echo [sync] ERROR: !CLIENT_DIR! sync failed with code !ERRORLEVEL!
    pause
    exit /b 1
)

REM ── Sync internal ───────────────────────────────────────────────────────────
echo [sync] Mirroring !INTERNAL_DIR!...
robocopy "!WSL_BASE!\!INTERNAL_DIR!" "!WIN_BASE!\!INTERNAL_DIR!" ^
    /MIR /R:3 /W:2 /NFL /NDL /NP /NJH /NJS ^
    /XD x64 .vs .git
if !ERRORLEVEL! GEQ 8 (
    echo [sync] ERROR: !INTERNAL_DIR! sync failed with code !ERRORLEVEL!
    pause
    exit /b 1
)

echo [sync] Done.
echo.

REM ── Run the production build ────────────────────────────────────────────────
REM Export INTERNAL_DIR for build-prod.mjs so it finds the sibling regardless
REM of which name (internal / DebugInternal) is on disk.
set "INTERNAL_DIR=!WIN_BASE!\!INTERNAL_DIR!"

pushd "!WIN_BASE!\!CLIENT_DIR!"

REM Install Windows deps only when missing/incomplete (tsc.cmd = Windows shim).
if exist "node_modules\.bin\tsc.cmd" (
    echo [build] Windows deps present - skipping npm install.
) else (
    echo [build] Installing dependencies...
    call npm install
    if !ERRORLEVEL! NEQ 0 (
        echo [build] ERROR: npm install failed with code !ERRORLEVEL!
        popd
        pause
        exit /b !ERRORLEVEL!
    )
)

if /i "!MODE!"=="portable" (
    echo [build] Running npm run dist:portable...
    call npm run dist:portable
) else if /i "!MODE!"=="both" (
    echo [build] Running npm run dist ^(installer + portable^)...
    call npm run dist
) else (
    echo [build] Running npm run dist:installer ^(NSIS installer only^)...
    call npm run dist:installer
)
set "BUILD_RC=!ERRORLEVEL!"
popd

if !BUILD_RC! NEQ 0 (
    echo [build] ERROR: build failed with code !BUILD_RC!
    pause
    exit /b !BUILD_RC!
)

if not exist "!WIN_BASE!\!CLIENT_DIR!\release\*.exe" (
    echo [build] ERROR: no .exe in release\ -- build did not package.
    pause
    exit /b 1
)

echo.
echo [done] Build complete. Output in:
echo        "!WIN_BASE!\!CLIENT_DIR!\release"
dir /b "!WIN_BASE!\!CLIENT_DIR!\release\*.exe"
echo.
echo SEND TO USERS: the file named  "Realm Engine Setup ^<ver^>.exe"
echo   - they run it ONCE to install
echo   - it then launches instantly every time (no per-launch unpacking)
echo Do NOT send the portable exe -- that one re-extracts on every launch
echo and is why it was slow for users.
pause
endlocal
