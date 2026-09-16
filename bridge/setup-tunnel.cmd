@echo off
setlocal
title Pick Check - Cloudflare Tunnel setup
rem Publishes the bridge (http://localhost:8080) as https://oleumorders.com through a free Cloudflare Tunnel.
rem Run this ONCE on the PC that runs the bridge. Right-click > "Run as administrator" (the tunnel installs as a Windows service).
rem
rem Before running: the domain below must be registered in (or added to) your Cloudflare account.
rem oleumlabs.com is NOT involved - its DNS stays at GoDaddy untouched.

set "HOSTNAME=oleumorders.com"
set "TUNNEL=pickcheck"
set "CFG=%USERPROFILE%\.cloudflared"

echo.
echo === 1/5  Checking config.json has a password ===
findstr /C:"\"appPassword\": \"\"" "%~dp0config.json" >nul 2>nul
if not errorlevel 1 (
  echo   appPassword is empty in config.json. Set a password first - once this is on the internet, anyone with the address could open it.
  pause
  exit /b 1
)
echo   ok

echo.
echo === 2/5  Installing cloudflared ===
where cloudflared >nul 2>nul || winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements --silent
where cloudflared >nul 2>nul || set "PATH=%PATH%;%ProgramFiles%\cloudflared;%ProgramFiles(x86)%\cloudflared;%LOCALAPPDATA%\Microsoft\WinGet\Links"
where cloudflared >nul 2>nul || (echo   cloudflared did not install. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and rerun. & pause & exit /b 1)
echo   ok

echo.
echo === 3/5  Cloudflare sign-in ===
if exist "%CFG%\cert.pem" (
  echo   Found existing credentials in %CFG% - no sign-in needed.
) else (
  echo   A browser window opens - sign in and pick the %HOSTNAME% zone.
  cloudflared tunnel login
)
if not exist "%CFG%\cert.pem" (echo   Sign-in did not complete. & pause & exit /b 1)
echo   ok

echo.
echo === 4/5  Creating the tunnel and DNS records ===
cloudflared tunnel list 2>nul | findstr /I " %TUNNEL% " >nul || cloudflared tunnel create %TUNNEL%
set "TUNNEL_ID="
for /f "tokens=1" %%i in ('cloudflared tunnel list ^| findstr /I " %TUNNEL% "') do set "TUNNEL_ID=%%i"
if "%TUNNEL_ID%"=="" (echo   Could not find the tunnel id. & pause & exit /b 1)
if not exist "%CFG%\%TUNNEL_ID%.json" (
  echo   The tunnel "%TUNNEL%" exists in Cloudflare but its credentials file %TUNNEL_ID%.json is not on this PC.
  echo   Copy the .cloudflared folder from the old PC, or delete the tunnel in Cloudflare ^(Zero Trust ^> Networks ^> Tunnels^) and rerun.
  pause & exit /b 1
)
> "%CFG%\config.yml" (
  echo tunnel: %TUNNEL_ID%
  echo credentials-file: %CFG%\%TUNNEL_ID%.json
  echo ingress:
  echo   - hostname: %HOSTNAME%
  echo     service: http://127.0.0.1:8080
  echo   - hostname: www.%HOSTNAME%
  echo     service: http://127.0.0.1:8080
  echo   - service: http_status:404
)
cloudflared tunnel route dns %TUNNEL% %HOSTNAME%
cloudflared tunnel route dns %TUNNEL% www.%HOSTNAME%
echo   ok  (tunnel %TUNNEL_ID% -> %HOSTNAME% and www.%HOSTNAME%)

echo.
echo === 5/5  Installing the tunnel as a Windows service (starts at boot) ===
cloudflared service uninstall >nul 2>nul
cloudflared service install
rem The Windows service does not read config.yml from the user profile, so register the config path explicitly.
for /f "delims=" %%p in ('where cloudflared') do set "CFEXE=%%p"
sc config cloudflared binPath= "\"%CFEXE%\" --config \"%CFG%\config.yml\" tunnel run" >nul
sc config cloudflared start= auto >nul
sc stop cloudflared >nul 2>nul
timeout /t 2 >nul
sc start cloudflared >nul 2>nul
timeout /t 8 >nul
cloudflared tunnel info %TUNNEL%
echo   ok

echo.
echo Done. Give it a minute, then open https://%HOSTNAME% on any phone or PC.
echo The bridge (start.cmd) must be running on this PC for the site to answer.
pause
