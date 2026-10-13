@echo off
REM One-time setup: installs dependencies and builds web + server.
REM Run from anywhere — it cd's to the project root itself.
cd /d "%~dp0\.."

where node >nul 2>nul || (echo ERROR: Node.js is not installed. Install Node 24 LTS from https://nodejs.org, then re-run this script. & exit /b 1)
for /f "tokens=*" %%v in ('node --version') do set NODEV=%%v
echo Node version: %NODEV%
echo (v2 needs Node 23.4+ for the built-in sqlite; Node 24 LTS recommended)

where pnpm >nul 2>nul || (echo Installing pnpm... & npm install -g pnpm || exit /b 1)

call pnpm install || exit /b 1
call pnpm build || exit /b 1

echo.
echo Setup done. Start the app with:  scripts\windows-run.bat
