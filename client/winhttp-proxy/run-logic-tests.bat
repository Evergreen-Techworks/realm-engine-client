@echo off
REM ===========================================================================
REM  run-logic-tests.bat - run the host logic tests from Windows.
REM  Compiles with g++ inside WSL; takes about a second. The distro is named
REM  explicitly because "Debian-OLD" is the CURRENT checkout despite its name,
REM  while the default "Debian" is stale - see build-windows.bat.
REM ===========================================================================
setlocal
if "%RE_WSL_DISTRO%"=="" set "RE_WSL_DISTRO=Debian-OLD"
set "REPO=/home/jesse/realm-engine-client"

wsl -d %RE_WSL_DISTRO% -- bash -c "cd '%REPO%' && client/winhttp-proxy/run-logic-tests.sh"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" ( echo. & echo [win] TESTS FAILED ^(exit %RC%^). ) else ( echo. & echo [win] tests passed. )
REM Unconditional pause: these wrappers exist to be double-clicked, and the
REM window must stay open long enough to read the result. For scripted or
REM piped use, call the .sh directly from WSL instead.
pause
exit /b %RC%
