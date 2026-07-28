@echo off
setlocal EnableExtensions

set "BOARD_URL=http://localhost:8765/"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --kiosk "%BOARD_URL%" --edge-kiosk-type=fullscreen --no-first-run
) else (
  start "" "%BOARD_URL%"
)
