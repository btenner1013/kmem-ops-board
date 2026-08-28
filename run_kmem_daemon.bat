@echo off
setlocal EnableExtensions

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
cd /d "%REPO%"

set "ROLE=%~1"
if not defined ROLE set "ROLE=%KMEM_UPDATER_ROLE%"
if /I not "%ROLE%"=="PRIMARY" if /I not "%ROLE%"=="BACKUP" (
  echo ERROR: Specify updater role PRIMARY or BACKUP.
  echo Example: run_kmem_daemon.bat PRIMARY
  pause
  exit /b 2
)

if exist "%REPO%\nms_credentials_local.bat" (
  call "%REPO%\nms_credentials_local.bat"
) else (
  echo WARNING: local NMS credentials were not found; public feeds remain available.
)

py -3 kmem_updater.py --daemon --interval 600 --role "%ROLE%"
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
