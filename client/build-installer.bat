echo off
REM ============================================================================
REM  Realm Engine - build the Windows installer (ADMIN BUILD).
REM
REM  Run this on the Windows build machine (needs Visual Studio / MSBuild for
REM  the C++ DLL).
REM
REM  The repo lives in the WSL filesystem (\\wsl.localhost\...). cmd.exe cannot
REM  use a UNC path as the current directory, so this script uses `pushd`, which
REM  auto-maps the UNC path to a temporary drive letter for the build.
REM
REM  NOTE: building across the WSL 9p share from Windows works but is SLOW.
REM  If builds are painfully slow, clone the repo onto a real Windows drive
REM  (e.g. C:\dev\realm-engine) and run this from there instead.
REM
REM  Usage:
REM    build-installer.bat        admin installer + portable (all admin features enabled)
REM ============================================================================
setlocal
 
REM pushd maps a UNC path to a temp drive letter and cd's into it.
pushd "%~dp0"
if errorlevel 1 (
  echo [ERROR] Could not enter "%~dp0".
  goto :fail
)
 
if not exist "package.json" (
  echo [ERROR] No package.json in "%cd%".
  echo         pushd did not land in the client folder as expected.
  goto :fail
)
echo Building in: "%cd%"
 
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found on PATH. Install Node.js and reopen the terminal.
  goto :fail
)
 
REM Preflight: node_modules installed under Linux/WSL cannot build on Windows.
REM A Windows install creates .cmd shims (e.g. tsc.cmd); a Linux one does not.
if exist "node_modules" if not exist "node_modules\.bin\tsc.cmd" (
  echo [ERROR] node_modules was installed under Linux/WSL -- unusable on Windows.
  echo         ^(no node_modules\.bin\tsc.cmd; esbuild/electron are Linux binaries^)
  echo.
  echo   Fix: build from a NATIVE Windows checkout, not the \\wsl.localhost path.
  echo        Run  setup-windows-build.bat  once to mirror the repo to a local
  echo        Windows folder and install Windows deps, then build from there.
  goto :fail
)
 
echo === Building ADMIN — native + JS (all admin features enabled^) ===
call npm run build:native
if errorlevel 1 goto :buildfail
call npm run build:admin
if errorlevel 1 goto :buildfail
 
echo === Packaging ADMIN installer + portable ===
call npx electron-builder --win nsis portable
if errorlevel 1 goto :buildfail
 
if not exist "release\*.exe" (
  echo.
  echo [ERROR] No .exe produced in release\ -- build did not package.
  goto :fail
)
 
echo.
echo === BUILD OK ===
echo Output: "%cd%\release"
echo.
dir /b "release\*.exe"
echo.
echo Done. Run the Setup .exe to install, or the portable .exe directly.
popd
pause
exit /b 0
 
:buildfail
echo.
echo [ERROR] Build failed. Scroll up for the first error.
echo         Common causes: MSBuild/Visual Studio not installed, the
echo         internal DLL repo missing next to the client folder, or
echo         npm dependencies not installed ^(run: npm install^).
 
:fail
echo.
popd
pause
exit /b 1
 