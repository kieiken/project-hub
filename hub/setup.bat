@echo off
rem Project Hub (Windows): run hub/setup.sh with the bash that comes with Git for Windows.
setlocal
set "PF86=%ProgramFiles(x86)%"
set "BASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if "%BASH%"=="" if exist "%PF86%\Git\bin\bash.exe" set "BASH=%PF86%\Git\bin\bash.exe"
if "%BASH%"=="" if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if "%BASH%"=="" (
  echo Git for Windows was not found. Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)
"%BASH%" "%~dp0setup.sh"
echo.
pause
