@echo off
setlocal EnableExtensions
call "%~dp0run_kmem_update.bat" BACKUP %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
