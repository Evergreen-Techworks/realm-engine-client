@echo off
setlocal enabledelayedexpansion

REM run-electron-dev.bat — mirror the client from WSL, then run Electron dev mode.
REM
REM This script used to build whatever tree the .bat happened to sit in
REM (cd /d "%~dp0.."), so launching the copy inside an old Windows snapshot
REM quietly ran stale source. It now pulls from WSL first, the same way
REM dev-build.bat does for the DLL.
REM
REM Env-var overrides:
REM   WSL_DISTRO   WSL distro name          (default: Debian-OLD)
REM   WSL_USER     WSL login user           (default: auto via wsl whoami)
REM   WSL_PARENT   project root in WSL      (default: auto-detect realm-engine-client)
REM   WIN_BASE     Windows working tree     (default: C:\realm-engine)
REM   CLIENT_DIR   client folder name       (default: client)
REM   NO_SYNC=1    skip the sync, just run  (offline / already-synced)

REM -- Env defaults ------------------------------------------------------------
if "!WSL_DISTRO!"==""  set "WSL_DISTRO=Debian-OLD"
if "!WSL_USER!"=="" (
    for /f "delims=" %%I in ('wsl -d !WSL_DISTRO! whoami 2^>nul') do set "WSL_USER=%%I"
    if "!WSL_USER!"=="" set "WSL_USER=%USERNAME%"
)
REM realm-engine-client (this repo) is checked FIRST -- ~/realm-engine is a
REM different project (bot pipeline) that also has a client/ folder, so it
REM must never win the auto-detect when both trees exist.
if "!WSL_PARENT!"=="" (
    if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    )
)
if "!WIN_BASE!"==""    set "WIN_BASE=C:\realm-engine"
if "!CLIENT_DIR!"==""  set "CLIENT_DIR=client"

if "!NO_SYNC!"=="1" (
    echo [dev] NO_SYNC=1 -- skipping sync, running !WIN_BASE!\!CLIENT_DIR! as-is.
    goto :build
)

REM -- Detect the WSL mount ----------------------------------------------------
set "WSL_BASE="
if not "!WSL_PARENT!"=="" (
    if exist "\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!" set "WSL_BASE=\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!"
    if exist "\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"          set "WSL_BASE=\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"
)

if "!WSL_BASE!"=="" (
    echo.
    echo ERROR: Cannot find the source tree in WSL.
    echo   Looked under: \\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\
    echo   Is the !WSL_DISTRO! distro running?  Try:  wsl -d !WSL_DISTRO! -e true
    echo   Or set WSL_DISTRO / WSL_USER / WSL_PARENT before running this script.
    pause
    exit /b 1
)

echo [sync] Source: !WSL_BASE!\!CLIENT_DIR!
echo [sync] Dest  : !WIN_BASE!\!CLIENT_DIR!
echo.

REM node_modules / dist / release stay local so the Windows install survives.
REM assets MUST stay local too: dev-build.bat places the freshly compiled DLL
REM there. Mirroring WSL assets here restored a stale checked-out DLL every time
REM the app launched, undoing a successful native build immediately before inject.
REM This .bat is excluded because it may be the file currently executing --
REM cmd reads a batch file as it runs, and overwriting it mid-run corrupts it.
robocopy "!WSL_BASE!\!CLIENT_DIR!" "!WIN_BASE!\!CLIENT_DIR!" ^
    /MIR /R:3 /W:2 /NFL /NDL /NP /NJH /NJS ^
    /XD node_modules dist release assets .git .vs "electron\native\build" ^
    /XF run-electron-dev.bat
if !ERRORLEVEL! GEQ 8 (
    echo.
    echo ERROR: sync failed with robocopy code !ERRORLEVEL!.
    pause
    exit /b 1
)
echo [sync] Done.
echo.

:build
if not exist "!WIN_BASE!\!CLIENT_DIR!\package.json" (
    echo.
    echo ERROR: no package.json at !WIN_BASE!\!CLIENT_DIR! -- nothing to run.
    pause
    exit /b 1
)

pushd "!WIN_BASE!\!CLIENT_DIR!"

REM tsc.cmd is the Windows shim -- if it is missing the tree only has the
REM Linux-side install (or none at all), so pull Windows deps.
if exist "node_modules\.bin\tsc.cmd" (
    echo [dev] Windows deps present - skipping npm install.
) else (
    echo [dev] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Make sure Node.js is installed.
        popd
        pause
        exit /b 1
    )
)

echo [dev] Preparing SDK and native dev stubs...
call npm run build:sdk
if errorlevel 1 (
    echo.
    echo ERROR: SDK build failed.
    popd
    pause
    exit /b 1
)

call npm run build:native
if errorlevel 1 (
    echo.
    echo ERROR: native dev preparation failed.
    popd
    pause
    exit /b 1
)

echo [dev] Starting Realm Engine in Electron dev mode...
call npm run electron
set "RC=!ERRORLEVEL!"
popd

if !RC! NEQ 0 (
    echo.
    echo ERROR: electron exited with code !RC!.
    pause
    exit /b !RC!
)

endlocal
