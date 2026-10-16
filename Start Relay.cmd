@echo off
cd /d "%~dp0"
if exist "target\release\relay.exe" (
  start "" "target\release\relay.exe"
  exit /b 0
)
if exist "target\debug\relay.exe" (
  start "" "target\debug\relay.exe"
  exit /b 0
)
echo Starting Relay in development mode. The first Rust build can take a few minutes.
call npm.cmd run desktop
if errorlevel 1 pause
