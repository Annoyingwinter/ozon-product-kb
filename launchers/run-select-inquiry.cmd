@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-select-inquiry.ps1" %*
if errorlevel 1 (
  echo.
  echo Selection + inquiry automation failed.
  pause
  exit /b %errorlevel%
)
endlocal
