@echo off
cd /d "%~dp0"
echo Starting Redmun Lead Generator...
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies... This may take a minute.
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed
        echo Make sure Node.js is installed and added to PATH
        echo Visit: https://nodejs.org/
        pause
        exit /b 1
    )
)

echo.
echo Opening web browser... 
timeout /t 2 /nobreak
start http://localhost:3000

echo.
echo Starting server at http://localhost:3000
echo Press Ctrl+C to stop.
echo.

node leadGen.js
pause
