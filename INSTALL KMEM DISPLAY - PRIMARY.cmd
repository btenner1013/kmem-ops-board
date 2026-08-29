@echo off
setlocal EnableExtensions

set "CHECK_ONLY="
set "LOCAL_DISPLAY="

:parse
if "%~1"=="" goto run
if /I "%~1"=="--check" (
  if defined CHECK_ONLY goto usage
  set "CHECK_ONLY=1"
  shift
  goto parse
)
if /I "%~1"=="--local-display" (
  if defined LOCAL_DISPLAY goto usage
  set "LOCAL_DISPLAY=1"
  shift
  goto parse
)
goto usage

:run
set "PS_ARGS="
if defined CHECK_ONLY set "PS_ARGS=%PS_ARGS% -CheckOnly"
if defined LOCAL_DISPLAY set "PS_ARGS=%PS_ARGS% -EnableLocalDisplay"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_primary_display.ps1" %PS_ARGS%
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo.
  echo KMEM PRIMARY INSTALL FAILED. Review the message above.
  pause
)
if "%RESULT%"=="0" if not defined CHECK_ONLY pause
exit /b %RESULT%

:usage
echo Usage:
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd --check
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd --local-display
echo   INSTALL KMEM DISPLAY - PRIMARY.cmd --check --local-display
exit /b 2
