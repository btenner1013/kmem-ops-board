@echo off
setlocal EnableExtensions

set "MODE="
if "%~1"=="" goto run
if /I "%~1"=="--check" (
  if not "%~2"=="" goto usage
  set "MODE=-CheckOnly"
  goto run
)
goto usage

:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_primary_display.ps1" %MODE%
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo KMEM PRIMARY INSTALL FAILED. Review the message above.
  pause
)
if "%RESULT%"=="0" if not defined MODE pause
exit /b %RESULT%

:usage
echo Usage:
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd --check
exit /b 2
