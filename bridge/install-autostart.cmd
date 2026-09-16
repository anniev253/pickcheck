@echo off
rem Creates a Startup-folder shortcut so the bridge launches (minimized) whenever this user logs into Windows.
set "TARGET=%~dp0start.cmd"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Pick Check bridge.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Pick Check bridge (Cultivera -> scanner gun)'; $s.Save()"
if errorlevel 1 (
  echo Could not create the startup shortcut.
) else (
  echo Done. The bridge will start automatically at login. Shortcut: "%LINK%"
)
pause
