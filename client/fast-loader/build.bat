@echo off
setlocal
set MH=..\..\internal\vendor\minhook
set SPLASH=..\winhttp-proxy\src

if not exist build mkdir build

cl /nologo /LD /O2 /MT /W3 /EHsc /std:c++17 ^
  /D_WIN32_WINNT=0x0A00 /DWIN32_LEAN_AND_MEAN ^
  /I "%SPLASH%" /I "%MH%" ^
  dllmain.cpp ^
  "%SPLASH%\splash_logic.cpp" ^
  "%SPLASH%\il2cpp_min.cpp" ^
  "%SPLASH%\splash_bypass.cpp" ^
  "%MH%\hook.c" "%MH%\buffer.c" "%MH%\trampoline.c" "%MH%\hde\hde64.c" ^
  /Febuild\fast-loader.dll ^
  /link /DLL user32.lib

if errorlevel 1 exit /b 1
echo [build] OK -^> build\fast-loader.dll
endlocal
