@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Stop-Mockup-Automation.ps1"
if errorlevel 1 (
  echo.
  echo Mockup Automation did not stop cleanly. Do not start another instance.
  pause
)
