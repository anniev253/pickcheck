@echo off
setlocal
title Pick Check - STAND DOWN (stop serving from this PC)
rem Stops this PC's bridge and removes its tunnel service, so another machine (the warehouse PC) serves alone.
rem Right-click > "Run as administrator".

cd /d "%~dp0"
echo.
echo === Stopping the bridge ===
where nssm >nul 2>nul && nssm stop PickCheck >nul 2>nul
for /f "tokens=2" %%p in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST 2^>nul ^| find /I "PID:"') do taskkill /F /PID %%p >nul 2>nul
taskkill /F /FI "WINDOWTITLE eq Pick Check bridge*" >nul 2>nul
echo   bridge stopped

echo.
echo === Removing the tunnel service from this PC ===
taskkill /F /IM cloudflared.exe >nul 2>nul
cloudflared service uninstall >nul 2>nul || "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" service uninstall >nul 2>nul
sc query cloudflared >nul 2>nul && (echo   tunnel service still present - run this window as administrator) || (echo   tunnel service removed)

echo.
echo === Tunnel connections remaining (should be the warehouse PC only) ===
timeout /t 5 >nul
where cloudflared >nul 2>nul && cloudflared tunnel info pickcheck 2>nul | findstr /R "^[0-9a-f]*-"
"%ProgramFiles(x86)%\cloudflared\cloudflared.exe" tunnel info pickcheck 2>nul | findstr /R "^[0-9a-f]*-"
echo.
pause
