@echo off
setlocal
title Pick Check - TAKE OVER serving oleumorders.com from this PC
rem Emergency failover: makes THIS PC serve https://oleumorders.com (bridge + tunnel).
rem Use when the warehouse PC is down. Right-click > "Run as administrator".
rem Needs: Node.js, this folder with config.json, and the tunnel files in %USERPROFILE%\.cloudflared
rem (cert.pem, config.yml, <tunnel-id>.json). Annie's laptop has all of these.
rem When the warehouse PC is back, run standdown.cmd here so only one machine serves.

cd /d "%~dp0"
set "CFG=%USERPROFILE%\.cloudflared"

echo.
echo === 1/4  Checks ===
where node >nul 2>nul || (echo   Node.js is not installed. Install the LTS version from https://nodejs.org and rerun. & pause & exit /b 1)
if not exist config.json (echo   config.json is missing in %~dp0 & pause & exit /b 1)
if not exist "%CFG%\cert.pem" (echo   Tunnel files not found in %CFG%. Copy cert.pem, config.yml and the tunnel .json there and rerun. & pause & exit /b 1)
findstr /C:"127.0.0.1:8080" "%CFG%\config.yml" >nul || findstr /C:"localhost:8080" "%CFG%\config.yml" >nul || (echo   %CFG%\config.yml does not point at port 8080. & pause & exit /b 1)
echo   ok

echo.
echo === 2/4  Starting the bridge ===
where nssm >nul 2>nul
if not errorlevel 1 (
  nssm status PickCheck >nul 2>nul && (nssm start PickCheck >nul 2>nul & echo   started the PickCheck service) || goto :window
) else (
  goto :window
)
goto :bridgedone
:window
tasklist /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul && (echo   a bridge is already running) || (start "Pick Check bridge" /MIN cmd /c "%~dp0start.cmd" & echo   started start.cmd in a minimized window - do not close it)
:bridgedone
timeout /t 6 >nul
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri http://127.0.0.1:8080/ -Method Head -UseBasicParsing -TimeoutSec 8).StatusCode | Out-Null; 'bridge answering on 8080' } catch { 'bridge NOT answering on 8080 - check the bridge window / logs\bridge.log'; exit 1 }"
if errorlevel 1 (pause & exit /b 1)

echo.
echo === 3/4  Tunnel service ===
where cloudflared >nul 2>nul || winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements --silent
where cloudflared >nul 2>nul || set "PATH=%PATH%;%ProgramFiles%\cloudflared;%ProgramFiles(x86)%\cloudflared;%LOCALAPPDATA%\Microsoft\WinGet\Links"
for /f "delims=" %%p in ('where cloudflared') do set "CFEXE=%%p"
sc query cloudflared >nul 2>nul || cloudflared service install >nul 2>nul
sc config cloudflared binPath= "\"%CFEXE%\" --config \"%CFG%\config.yml\" tunnel run" >nul
sc config cloudflared start= auto >nul
taskkill /F /IM cloudflared.exe >nul 2>nul
timeout /t 2 >nul
sc start cloudflared >nul 2>nul
timeout /t 10 >nul
echo   tunnel connections now:
cloudflared tunnel info pickcheck 2>nul | findstr /R "^[0-9a-f]*-"

echo.
echo === 4/4  Done ===
echo This PC is now serving https://oleumorders.com. Keep it on and connected.
echo When the warehouse PC is back, run standdown.cmd here.
pause
