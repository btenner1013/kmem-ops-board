@echo off
cd /d "C:\Users\btenn\Documents\KMEM-Ops-Board-Local\kmem-ops-board"

if exist "nms_credentials_local.bat" (
    call "nms_credentials_local.bat"
) else (
    echo WARNING: nms_credentials_local.bat not found. NMS NOTAMS may use last-known-good data. >> local_update_log.txt
)

py update_weather_local.py >> local_update_log.txt 2>&1