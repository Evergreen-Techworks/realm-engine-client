@echo off
REM Local override — sets correct WSL user + project path before syncing.
set "WSL_DISTRO=Debian"
set "WSL_USER=jesse"
set "WSL_PARENT=home\jesse\realm-engine-client"
call "%~dp0sync-and-build.bat"
