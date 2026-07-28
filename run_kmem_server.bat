@echo off
setlocal EnableExtensions

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

cd /d "%REPO%"

echo ==================================================
echo Starting KMEM Ops Board local web server
echo Folder: %REPO%
echo URL: http://localhost:8765/
echo ==================================================

py -3 -m http.server 8765 --bind 127.0.0.1
