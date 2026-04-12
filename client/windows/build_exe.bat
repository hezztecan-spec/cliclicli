@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "CLIENT_DIR=%%~fI"
set "VENV_DIR=%CLIENT_DIR%\.build-venv"
set "DIST_DIR=%CLIENT_DIR%\dist"

where py >nul 2>nul
if %errorlevel% neq 0 (
  echo Python launcher ^(py^) не найден. Установите Python 3.
  exit /b 1
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  py -3 -m venv "%VENV_DIR%"
  if %errorlevel% neq 0 (
    echo Не удалось создать build virtualenv.
    exit /b 1
  )
)

"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
if %errorlevel% neq 0 exit /b 1

"%VENV_DIR%\Scripts\python.exe" -m pip install requests pyinstaller
if %errorlevel% neq 0 exit /b 1

cd /d "%CLIENT_DIR%"
"%VENV_DIR%\Scripts\pyinstaller.exe" --noconfirm --clean --onefile --noconsole --name rclient client.py
if %errorlevel% neq 0 (
  echo Сборка EXE не удалась.
  exit /b 1
)

echo.
echo EXE собран:
echo %DIST_DIR%\rclient.exe
echo.
echo Для установки на клиенте:
echo %DIST_DIR%\rclient.exe --install

endlocal
