@echo off
setlocal enableextensions
rem ===========================================================================
rem  Realm Engine - build + BootGate test
rem  Builds version.dll (Release^|x64), optionally deploys it next to
rem  GameAssembly.dll, then tails the trace log so you can WATCH the boot loop
rem  ([BootGate] state -> ... / [BootGate] audit ...) confirm which offsets are
rem  stale. Run this from anywhere; it locates itself via %~dp0.
rem
rem  Requires: Visual Studio 2022 with "Desktop development with C++"
rem  (toolset v145). Nothing else to install.
rem ===========================================================================

set "ROOT=%~dp0"
set "SLN=%ROOT%il2cpp-dll-injection.sln"
set "CONFIG=Release"
set "PLATFORM=x64"
set "OUTDLL=%ROOT%x64\%CONFIG%\version.dll"
set "TRACELOG=%LOCALAPPDATA%\RotMG Exalt DLL Trace.log"

rem --- Optional: set RE_GAME_DIR to your game folder to auto-deploy version.dll.
rem     e.g.  set "RE_GAME_DIR=C:\Program Files ^(x86^)\Steam\steamapps\common\RotMG Exalt"
set "GAME_DIR=%RE_GAME_DIR%"

echo(
echo === [1/3] Locating MSBuild ===
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo ERROR: vswhere not found. Install Visual Studio 2022 with the
  echo        "Desktop development with C++" workload, then re-run.
  goto :end
)
set "MSBUILD="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe`) do set "MSBUILD=%%i"
if not defined MSBUILD (
  echo ERROR: MSBuild.exe not found via vswhere.
  goto :end
)
echo Using: %MSBUILD%

echo(
echo === [2/3] Building %CONFIG% ^| %PLATFORM% ===
"%MSBUILD%" "%SLN%" /p:Configuration=%CONFIG% /p:Platform=%PLATFORM% /m /v:minimal /nologo
if errorlevel 1 (
  echo(
  echo BUILD FAILED - see the errors above.
  goto :end
)
if not exist "%OUTDLL%" (
  echo ERROR: build succeeded but %OUTDLL% is missing.
  goto :end
)
echo(
echo BUILD OK -^> %OUTDLL%

echo(
echo === [2.5/3] Raw-access guardrails ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\check-raw-access.ps1"
if errorlevel 1 ( echo GUARDRAIL FAILURE - see above & exit /b 1 )
echo Guardrails OK - no forbidden raw access in features/ or gui/.

if defined GAME_DIR (
  if exist "%GAME_DIR%\GameAssembly.dll" (
    echo Deploying version.dll to "%GAME_DIR%"
    copy /y "%OUTDLL%" "%GAME_DIR%\version.dll" >nul
    if errorlevel 1 (
      echo WARNING: copy failed - is the game running? Close it and re-run.
    ) else (
      echo Deployed.
    )
  ) else (
    echo NOTE: RE_GAME_DIR is set but GameAssembly.dll is not there - skipping deploy.
  )
) else (
  echo(
  echo To auto-deploy next time, set RE_GAME_DIR to your game folder, e.g.:
  echo     set "RE_GAME_DIR=C:\Program Files ^(x86^)\Steam\steamapps\common\RotMG Exalt"
  echo Otherwise copy the DLL above next to GameAssembly.dll yourself.
)

echo(
echo === [3/3] Watching the trace log for the BootGate loop ===
echo Log: %TRACELOG%
echo Launch the game now. Expect lines like:
echo     [BootGate] state -^> Resolving offsets...
echo     [BootGate] audit ^(metadata-only^): N critical anchor^(s^) stale
echo     [BootGate] audit: STALE anchor 'HBEAKBIHANL' ^(Projectile instance^) [CRITICAL]
echo     [BootGate] state -^> Ready
echo Press Ctrl+C to stop watching.
echo(
powershell -NoProfile -ExecutionPolicy Bypass -Command "while(-not (Test-Path -LiteralPath $env:TRACELOG)){Write-Host '(waiting for the DLL to create the log...)'; Start-Sleep -Seconds 1}; Get-Content -LiteralPath $env:TRACELOG -Wait -Tail 0 | Select-String -Pattern 'BootGate','RuntimeOffsets','ResolveProjClass'"

:end
echo(
pause
endlocal
