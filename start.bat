@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Get the LTS build from https://nodejs.org, install it, then run this file again.
  echo.
  pause
  exit /b
)

node server.js

echo.
echo   The program has stopped. Press any key to close this window.
pause >nul
