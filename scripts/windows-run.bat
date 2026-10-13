@echo off
REM Start Rekap Visite v2. Keep this window open while the app is running.
cd /d "%~dp0\.."

REM ---------------------------------------------------------------------------
REM POINT THIS AT THE SAME master_data.json YOUR V1 USES (one source of truth).
REM Example:  set REKAP_MASTER=C:\rekap-v1\master_data.json
REM (default below = master_data.json in the v2 project folder)
REM ---------------------------------------------------------------------------
set REKAP_MASTER=%~dp0..\master_data.json

set PORT=8787
set REKAP_DB=%~dp0..\data\rekap.db
set REKAP_POLL_MS=60000
set REKAP_CLEANUP=1

echo Starting Rekap Visite v2
echo   URL : http://localhost:%PORT%
echo   Data: %REKAP_MASTER%
echo.
node server\dist\index.js
