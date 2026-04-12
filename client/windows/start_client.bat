@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "CLIENT_DIR=%%~fI"
set "PYTHON_EXE=%CLIENT_DIR%\.venv\Scripts\python.exe"
set "CLIENT_SCRIPT=%CLIENT_DIR%\client.py"

if not exist "%PYTHON_EXE%" (
  exit /b 1
)

cd /d "%CLIENT_DIR%"
"%PYTHON_EXE%" "%CLIENT_SCRIPT%"

endlocal

