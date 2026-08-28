@echo off
setlocal EnableExtensions

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
cd /d "%REPO%"

set "ROLE=%~1"
if not defined ROLE set "ROLE=%KMEM_UPDATER_ROLE%"
if /I not "%ROLE%"=="PRIMARY" if /I not "%ROLE%"=="BACKUP" (
  echo ERROR: Specify updater role PRIMARY or BACKUP.
  echo Example: run_kmem_update.bat PRIMARY
  exit /b 2
)

set "EXTRA="
if not "%~3"=="" (
  echo ERROR: Too many updater arguments.
  exit /b 2
)
if "%~2"=="" goto arguments_ok
if /I "%ROLE%"=="BACKUP" if /I "%~2"=="--force-failover" set "EXTRA=--force-failover"
if /I "%ROLE%"=="PRIMARY" if /I "%~2"=="--require-owned-cycle" set "EXTRA=--require-owned-cycle"
if not defined EXTRA (
  echo ERROR: Invalid updater option for role %ROLE%.
  exit /b 2
)

:arguments_ok

if exist "%REPO%\nms_credentials_local.bat" (
  call "%REPO%\nms_credentials_local.bat"
) else (
  echo WARNING: local NMS credentials were not found; public feeds remain available.
)

py -3 kmem_updater.py --role "%ROLE%" %EXTRA%
set "RESULT=%ERRORLEVEL%"
exit /b %RESULT%
