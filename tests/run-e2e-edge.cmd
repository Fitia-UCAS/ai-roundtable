@echo off
setlocal
set "NODE_EXE=node"
if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"

set "NODE_PATH=C:\Users\aFei\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
if exist "%NODE_PATH%\playwright" goto run
set "NODE_PATH=%APPDATA%\npm\node_modules"
if exist "%NODE_PATH%\playwright" goto run
set "NODE_PATH="

:run
"%NODE_EXE%" "%~dp0e2e-edge-autotest.js" %*
