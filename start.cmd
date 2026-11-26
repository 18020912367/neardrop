@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  goto :finished
)

if defined NEARDROP_NODE (
  if exist "%NEARDROP_NODE%" (
    "%NEARDROP_NODE%" server.js
    goto :finished
  )
)

echo.
echo Node.js was not found.
echo Install Node.js 18 or newer from https://nodejs.org/ and run this file again.
echo If Node.js is available in a non-standard location, set NEARDROP_NODE to its node.exe path.
echo.

:finished
if errorlevel 1 pause
