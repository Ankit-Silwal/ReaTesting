@echo off
cd /d "%~dp0"
if exist "target\debug\relay-test-api.exe" (
  "target\debug\relay-test-api.exe"
) else (
  call npm.cmd run api
)
if errorlevel 1 pause
