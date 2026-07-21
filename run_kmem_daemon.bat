@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO=C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board"

cd /d "%REPO%"

echo ==================================================
echo Starting Continuous KMEM Ops Board Updater
echo Repo: %REPO%
echo ==================================================

if exist "%REPO%\nms_credentials_local.bat" (
  call "%REPO%\nms_credentials_local.bat"
) else (
  echo WARNING: nms_credentials_local.bat not found. Continuing with public feeds.
)

py update_weather_local.py --daemon --interval 600

pause
