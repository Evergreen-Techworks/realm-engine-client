@echo off
REM ============================================================================
REM build.bat - compile the source-available winhttp.dll proxy (x64).
REM This Batch File was AI generated. 
REM
REM Run this from an "x64 Native Tools Command Prompt for VS 2022" (so cl.exe is
REM on PATH and targeting x64 - the game is 64-bit, the shim must match).
REM
REM Output: winhttp.dll  (drop it next to "RotMG Exalt.exe", or point the
REM client's GameHooker at it by replacing client/assets/winhttp.dll).
REM ============================================================================
setlocal

if /I not "%VSCMD_ARG_TGT_ARCH%"=="x64" (
    echo [build] WARNING: this doesn't look like an x64 tools prompt.
    echo [build] Open "x64 Native Tools Command Prompt for VS 2022" and retry.
)

set MH=..\..\internal\vendor\minhook
set SRC=src\dllmain.cpp src\connect_hook.cpp src\splash_logic.cpp src\il2cpp_min.cpp src\splash_bypass.cpp
set MHSRC=%MH%\hook.c %MH%\buffer.c %MH%\trampoline.c %MH%\hde\hde64.c

cl /nologo /LD /O2 /MT /W3 /EHsc /std:c++17 ^
   /D_WIN32_WINNT=0x0A00 /DWIN32_LEAN_AND_MEAN ^
   /I src /I "%MH%" ^
   %SRC% %MHSRC% ^
   /Fewinhttp.dll ^
   /link /DLL ws2_32.lib user32.lib

if errorlevel 1 (
    echo [build] FAILED.
    exit /b 1
)

del /q *.obj 2>nul
echo [build] OK -^> winhttp.dll
endlocal
