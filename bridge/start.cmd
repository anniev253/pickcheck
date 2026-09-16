@echo off
title Pick Check bridge
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist config.json (
  echo config.json is missing. Copy config.example.json to config.json and fill in the Cultivera login.
  pause
  exit /b 1
)
:loop
node server.js
echo.
echo Bridge stopped. Restarting in 5 seconds (close this window to quit)...
timeout /t 5 >nul
goto loop
