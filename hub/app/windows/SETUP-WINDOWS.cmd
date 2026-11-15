@echo off
setlocal DisableDelayedExpansion
set NODE_OPTIONS=
set NODE_PATH=
cd /d "%~dp0"
where.exe node.exe >nul 2>nul
if errorlevel 1 (
  echo Project Hub setup needs Node.js 22.13 or later. No software was installed.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -STA -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('Node.js 22.13 or later is required. No software was installed.','Project Hub')"
  pause
  exit /b 1
)
node.exe "%~dp0hub\release-app\install-windows.cjs"
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
