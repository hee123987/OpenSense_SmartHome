@echo off
title OpenSense SmartHome Web Dashboard Loader

rem 1. Set current directory to folder path
cd /d "%~dp0"

rem 2. Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Python is not installed or not in PATH.
    echo Opening index.html directly instead...
    timeout /t 3 >nul
    start index.html
    exit /b
)

rem 3. Start Python HTTP Server
echo [1/2] Starting Python HTTP server on port 8000...
start "" /B python -m http.server 8000

rem 4. Open Web Dashboard in browser
echo [2/2] Opening http://localhost:8000 in your browser...
timeout /t 2 >nul
start http://localhost:8000

echo.
echo ====================================================================
echo   OpenSense SmartHome Dashboard Server is running!
echo   * URL: http://localhost:8000
echo   * To stop the server, close this command prompt window.
echo ====================================================================
echo.

:loop
pause
goto loop
