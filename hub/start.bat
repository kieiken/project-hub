@echo off
rem Project Hub (Windows): start the server and open the page in the browser.
rem Set HUB_LANG=zh-TW before calling this to use the Traditional Chinese UI.
setlocal
cd /d "%~dp0"
if "%HUB_PORT%"=="" set "HUB_PORT=4545"
set "URL=http://127.0.0.1:%HUB_PORT%"

rem Already running? Just open the page.
curl --noproxy * -fs -o NUL "%URL%/api/ping" >NUL 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

where node >NUL 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem Open the browser once the server answers (waits up to 20 seconds) without blocking the server.
start "" /b node -e "const u=process.argv[1];const h=require('http');let n=0;(function t(){h.get(u+'/api/ping',r=>{r.resume();require('child_process').spawn('rundll32.exe',['url.dll,FileProtocolHandler',u],{detached:true,stdio:'ignore'}).unref()}).on('error',()=>{if(++n<40)setTimeout(t,500)})})()" "%URL%"

node server.js
echo.
echo Project Hub stopped. If it did not start, paste the messages above to Claude.
pause
