@echo off
rem Re-registers the cloudflared Windows service with its config file (needs Administrator).
rem Windows services do not read config.yml from the user profile, so the path must be on the command line.
set "CFEXE=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CFEXE%" for /f "delims=" %%p in ('where cloudflared 2^>nul') do set "CFEXE=%%p"
set "CFG=%USERPROFILE%\.cloudflared\config.yml"
if "%USERPROFILE%"=="%SystemRoot%\system32\config\systemprofile" set "CFG=C:\Users\annv1\.cloudflared\config.yml"
echo Using %CFEXE%
echo Config %CFG%
sc config cloudflared binPath= "\"%CFEXE%\" --config \"%CFG%\" tunnel run"
sc config cloudflared start= auto
sc stop cloudflared >nul 2>nul
timeout /t 3 >nul
sc start cloudflared
timeout /t 10 >nul
"%CFEXE%" tunnel info pickcheck
echo.
echo If a connection is listed above, https://oleumorders.com is live.
pause
