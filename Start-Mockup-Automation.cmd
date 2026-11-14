@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-Mockup-Automation.ps1"
if errorlevel 1 (
  echo.
  echo Mockup Automation did not start. Review the message above and logs\launcher-error.log.
  pause
)
