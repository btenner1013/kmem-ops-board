@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "LOG=%REPO%\local_update_log.txt"

cd /d "%REPO%"

echo.>> "%LOG%"
echo ==================================================>> "%LOG%"
echo KMEM UPDATE START %DATE% %TIME%>> "%LOG%"
echo Repo: %REPO%>> "%LOG%"

echo Scheduled update: syncing repo before weather update...>> "%LOG%"
git fetch origin main >> "%LOG%" 2>&1
git pull --rebase origin main >> "%LOG%" 2>&1

if errorlevel 1 (
  echo PRE-UPDATE GIT PULL/REBASE FAILED. Continuing with local files.>> "%LOG%"
)

if exist "%REPO%\nms_credentials_local.bat" (
  call "%REPO%\nms_credentials_local.bat"
) else (
  echo WARNING: nms_credentials_local.bat not found.>> "%LOG%"
)

echo Running weather updater...>> "%LOG%"
py -3 update_weather_local.py >> "%LOG%" 2>&1

if errorlevel 1 (
  echo FIRST UPDATE RUN FAILED. Attempting git rebase recovery and one retry...>> "%LOG%"
  git fetch origin main >> "%LOG%" 2>&1
  git pull --rebase origin main >> "%LOG%" 2>&1

  echo Retrying weather updater...>> "%LOG%"
  py -3 update_weather_local.py >> "%LOG%" 2>&1
)

if errorlevel 1 (
  echo KMEM UPDATE FAILED AFTER RETRY %DATE% %TIME%>> "%LOG%"
  exit /b 1
)

echo KMEM UPDATE COMPLETE %DATE% %TIME%>> "%LOG%"
exit /b 0
