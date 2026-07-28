@echo off
rem Copy this file to nms_credentials_local.bat and replace the placeholders.
rem Never commit, email, or share the completed credential file.

set "NMS_CLIENT_ID=PASTE_YOUR_FAA_NMS_CLIENT_ID_HERE"
set "NMS_CLIENT_SECRET=PASTE_YOUR_FAA_NMS_CLIENT_SECRET_HERE"

rem Leave this disabled unless a trusted local certificate problem requires it.
rem set "NMS_ALLOW_INSECURE_SSL_FALLBACK=1"
