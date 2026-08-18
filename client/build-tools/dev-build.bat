@echo off
setlocal enabledelayedexpansion

REM dev-build.bat — Fast DLL dev iteration: sync internal from WSL, build, deploy to game.
REM
REM Usage:
REM   dev-build.bat           (default: Debug|x64)
REM   dev-build.bat release   (Release|x64 — no console, stripped)
REM
REM Env-var overrides:
REM   WSL_DISTRO=Debian  WSL_USER=<auto>  WSL_PARENT=<auto>  WIN_BASE=C:\realm-engine  INTERNAL_DIR=<auto>

REM ── Pick build configuration ────────────────────────────────────────────────
set "BUILD_CONFIG=Debug"
if /I "%~1"=="release" set "BUILD_CONFIG=Release"
echo [dev] Build configuration: !BUILD_CONFIG!^|x64

REM ── Env defaults ────────────────────────────────────────────────────────────────
if "!WSL_DISTRO!"==""   set "WSL_DISTRO=Debian"
if "!WSL_USER!"=="" (
    for /f "delims=" %%I in ('wsl -d !WSL_DISTRO! whoami 2^>nul') do set "WSL_USER=%%I"
    if "!WSL_USER!"=="" set "WSL_USER=%USERNAME%"
)
if "!WSL_PARENT!"=="" (
    REM Prefer realm-engine-client (this repo) — ~/realm-engine is a different
    REM project (bot pipeline) that also has client/, then fall back to legacy LFG.
    if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine-client\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine-client"
    ) else if exist "\\wsl.localhost\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    ) else if exist "\\wsl$\!WSL_DISTRO!\home\!WSL_USER!\realm-engine\client" (
        set "WSL_PARENT=home\!WSL_USER!\realm-engine"
    ) else (
        set "WSL_PARENT=home\!WSL_USER!\LFG"
    )
)
if "!WIN_BASE!"==""     set "WIN_BASE=C:\realm-engine"

REM ── Detect WSL mount ────────────────────────────────────────────────────────
set "WSL_BASE="
if exist "\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!" set "WSL_BASE=\\wsl.localhost\!WSL_DISTRO!\!WSL_PARENT!"
if exist "\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"          set "WSL_BASE=\\wsl$\!WSL_DISTRO!\!WSL_PARENT!"

REM ── Resolve internal repo name (canonical 'internal' or legacy 'DebugInternal') ─
if "!INTERNAL_DIR!"=="" (
    REM Prefer canonical 'internal'; fall back to legacy 'DebugInternal'
    REM only when the new repo is missing. Without if-else, both branches
    REM fired and the legacy name overrode the canonical one.
    if not "!WSL_BASE!"=="" (
        if exist "!WSL_BASE!\internal" (
            set "INTERNAL_DIR=internal"
        ) else if exist "!WSL_BASE!\DebugInternal" (
            set "INTERNAL_DIR=DebugInternal"
        )
    )
    if "!INTERNAL_DIR!"=="" (
        if exist "!WIN_BASE!\internal" (
            set "INTERNAL_DIR=internal"
        ) else if exist "!WIN_BASE!\DebugInternal" (
            set "INTERNAL_DIR=DebugInternal"
        )
    )
)
if "!INTERNAL_DIR!"=="" set "INTERNAL_DIR=internal"

REM ── Sync internal from WSL (skip if WSL unreachable) ────────────────────────
if "!WSL_BASE!"=="" (
    echo [dev] WSL mount not found; skipping sync. Building from existing !WIN_BASE!\!INTERNAL_DIR!.
) else (
    echo [dev] Syncing !INTERNAL_DIR! from WSL...
    robocopy "!WSL_BASE!\!INTERNAL_DIR!" "!WIN_BASE!\!INTERNAL_DIR!" ^
        /MIR /R:3 /W:2 /NFL /NDL /NP /NJH /NJS ^
        /XD x64 .vs .git
    if !ERRORLEVEL! GEQ 8 (
        echo [dev] ERROR: !INTERNAL_DIR! sync failed ^(code !ERRORLEVEL!^).
        pause
        exit /b 1
    )
)

REM ── Ensure game is closed so we can overwrite version.dll ───────────────────
tasklist /FI "IMAGENAME eq RotMG Exalt.exe" | find /I "RotMG Exalt.exe" >nul
if !ERRORLEVEL! EQU 0 (
    echo [dev] RotMG Exalt is running. Closing it so we can overwrite version.dll...
    taskkill /F /IM "RotMG Exalt.exe" >nul 2>&1
    timeout /t 1 /nobreak >nul
)

REM ── Locate MSBuild ──────────────────────────────────────────────────────────
set "MSBUILD="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "!VSWHERE!" (
    for /f "delims=" %%I in ('"!VSWHERE!" -latest -prerelease -find MSBuild\**\Bin\MSBuild.exe 2^>nul') do (
        if not defined MSBUILD if exist "%%I" set "MSBUILD=%%I"
    )
)
for %%V in (18 2026 2022) do (
    for %%E in (Community Professional Enterprise BuildTools) do (
        if not defined MSBUILD if exist "C:\Program Files\Microsoft Visual Studio\%%V\%%E\MSBuild\Current\Bin\MSBuild.exe" (
            set "MSBUILD=C:\Program Files\Microsoft Visual Studio\%%V\%%E\MSBuild\Current\Bin\MSBuild.exe"
        )
        if not defined MSBUILD if exist "C:\Program Files (x86)\Microsoft Visual Studio\%%V\%%E\MSBuild\Current\Bin\MSBuild.exe" (
            set "MSBUILD=C:\Program Files (x86)\Microsoft Visual Studio\%%V\%%E\MSBuild\Current\Bin\MSBuild.exe"
        )
    )
)
if "!MSBUILD!"=="" (
    echo [dev] ERROR: MSBuild not found under Visual Studio 2026/2022 or Build Tools.
    pause
    exit /b 1
)
echo [dev] MSBuild: !MSBUILD!

REM ── Build ───────────────────────────────────────────────────────────────────

echo [dev] Clearing x64 build cache for a clean compile...
if exist "!WIN_BASE!\!INTERNAL_DIR!\x64\!BUILD_CONFIG!" (
    rmdir /S /Q "!WIN_BASE!\!INTERNAL_DIR!\x64\!BUILD_CONFIG!" 2>nul
)

echo [dev] Building DLL...
"!MSBUILD!" "!WIN_BASE!\!INTERNAL_DIR!\il2cpp-dll-injection.sln" ^
    /t:Rebuild /p:Configuration=!BUILD_CONFIG! /p:Platform=x64 ^
    /m /v:minimal /nologo
if !ERRORLEVEL! NEQ 0 (
    echo [dev] ERROR: MSBuild failed ^(code !ERRORLEVEL!^).
    pause
    exit /b !ERRORLEVEL!
)

set "BUILT_DLL=!WIN_BASE!\!INTERNAL_DIR!\x64\!BUILD_CONFIG!\version.dll"
set "BUILT_PDB=!WIN_BASE!\!INTERNAL_DIR!\x64\!BUILD_CONFIG!\version.pdb"
if not exist "!BUILT_DLL!" (
    echo [dev] ERROR: Built DLL not found at !BUILT_DLL!
    pause
    exit /b 1
)

REM ── Deploy straight to the game folder ──────────────────────────────────────
set "GAME_DIR=%LOCALAPPDATA%\RealmOfTheMadGod\Production"
if not exist "!GAME_DIR!" (
    echo [dev] ERROR: Game folder not found: !GAME_DIR!
    pause
    exit /b 1
)

echo [dev] Deploying version.dll to !GAME_DIR!...
copy /Y "!BUILT_DLL!" "!GAME_DIR!\version.dll" >nul
if !ERRORLEVEL! NEQ 0 (
    echo [dev] ERROR: Copy failed. Is the game still holding the DLL open?
    pause
    exit /b 1
)

if exist "!BUILT_PDB!" (
    copy /Y "!BUILT_PDB!" "!GAME_DIR!\version.pdb" >nul
    echo [dev] PDB deployed — you can now open crash dumps in Visual Studio and see symbols.
)

echo.
echo [dev] Done.
if /I "!BUILD_CONFIG!"=="Debug" (
    echo [dev] Debug build — when the game starts, a console window will open for DLL logs.
) else (
    echo [dev] Release build — no console; crash logs only via WER + dmp.
)
echo [dev] Launch RotMG to test. Skip running the bot-client if you want to test the DLL in isolation.
echo.
pause
endlocal
