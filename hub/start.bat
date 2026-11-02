@echo off
rem Project Hub: keep the existing server/root; open only after owner verification.
setlocal DisableDelayedExpansion
chcp 65001 >NUL
cd /d "%~dp0"
if "%HUB_PORT%"=="" set "HUB_PORT=4545"
where node >NUL 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer and run this again.
  pause
  exit /b 1
)
node app/open-browser.cjs --probe >NUL 2>&1
if not errorlevel 1 (
  start "" /b node app/open-browser.cjs
  exit /b 0
)
rem Wait only for verified readiness; the helper exchanges a private launch ticket.
start "" /b node app/open-browser.cjs --wait
node server.js
echo.
echo Project Hub stopped. Paste the messages above if startup failed.
pause
