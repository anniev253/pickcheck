@echo off
setlocal
title Pick Check - install as a Windows service
rem Runs the bridge as a Windows service so it starts at boot, before anyone logs in, and restarts if it crashes.
rem Right-click > "Run as administrator". Safe to rerun: it replaces an existing PickCheck service.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause & exit /b 1
)
if not exist config.json (
  echo config.json is missing. Copy it from the old PC ^(or config.example.json^) into this folder first.
  pause & exit /b 1
)
for /f "delims=" %%p in ('where node') do set "NODE=%%p"

echo.
echo === Installing NSSM (service wrapper) ===
where nssm >nul 2>nul || winget install --id NSSM.NSSM --accept-source-agreements --accept-package-agreements --silent
where nssm >nul 2>nul || set "PATH=%PATH%;%LOCALAPPDATA%\Microsoft\WinGet\Links"
where nssm >nul 2>nul || (echo   NSSM did not install. Download it from https://nssm.cc and put nssm.exe in this folder, then rerun. & pause & exit /b 1)
echo   ok

echo.
echo === Registering the PickCheck service ===
if not exist logs mkdir logs
nssm stop PickCheck >nul 2>nul
nssm remove PickCheck confirm >nul 2>nul
nssm install PickCheck "%NODE%" "server.js"
nssm set PickCheck AppDirectory "%~dp0"
nssm set PickCheck DisplayName "Pick Check bridge"
nssm set PickCheck Description "Oleum Orders: Cultivera bridge for the scanner gun (https://oleumorders.com)"
nssm set PickCheck Start SERVICE_AUTO_START
nssm set PickCheck AppStdout "%~dp0logs\bridge.log"
nssm set PickCheck AppStderr "%~dp0logs\bridge.log"
nssm set PickCheck AppRotateFiles 1
nssm set PickCheck AppRotateBytes 5000000
nssm set PickCheck AppExit Default Restart
nssm set PickCheck AppRestartDelay 5000
rem The service runs as the logged-in user so it can read the OneDrive-synced Inventory Key and config.json in this profile.
set /p SVCPASS="  Windows password for %USERNAME% (needed so the service can read your OneDrive folder; press Enter to run as SYSTEM instead): "
if not "%SVCPASS%"=="" (
  nssm set PickCheck ObjectName ".\%USERNAME%" "%SVCPASS%"
) else (
  echo   Running as SYSTEM. Set "locations.file" in config.json to the full path of Inventory Key.xlsx, e.g. C:\Users\%USERNAME%\OneDrive - OLEUMLABS\Inventory Key.xlsx
)
set "SVCPASS="
nssm start PickCheck
timeout /t 5 >nul
nssm status PickCheck
echo.
echo   Log: %~dp0logs\bridge.log
echo   Test: http://localhost:8080/api/health

echo.
echo === Removing the old Startup-folder shortcut (the service replaces it) ===
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Pick Check bridge.lnk" >nul 2>nul
echo   ok

echo.
echo Done. The bridge now runs as a Windows service. Do NOT also run start.cmd, or the two will fight over port 8080.
echo To stop/start:  nssm stop PickCheck   /   nssm start PickCheck      To remove:  nssm remove PickCheck confirm
pause
