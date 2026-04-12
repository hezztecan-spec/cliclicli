@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "CLIENT_DIR=%%~fI"
set "VENV_DIR=%CLIENT_DIR%\.venv"
set "TASK_NAME=RemoteControlClient"
set "START_SCRIPT=%SCRIPT_DIR%start_client.bat"

echo [1/4] Проверка Python...
where py >nul 2>nul
if %errorlevel% neq 0 (
  echo Python launcher ^(py^) не найден. Установите Python 3 и повторите.
  exit /b 1
)

echo [2/4] Создание виртуального окружения...
if not exist "%VENV_DIR%\Scripts\python.exe" (
  py -3 -m venv "%VENV_DIR%"
  if %errorlevel% neq 0 (
    echo Не удалось создать virtualenv.
    exit /b 1
  )
)

echo [3/4] Установка зависимостей...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
if %errorlevel% neq 0 (
  echo Не удалось обновить pip.
  exit /b 1
)

"%VENV_DIR%\Scripts\python.exe" -m pip install -r "%CLIENT_DIR%\requirements.txt"
if %errorlevel% neq 0 (
  echo Не удалось установить зависимости.
  exit /b 1
)

echo [4/4] Регистрация автозапуска...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
schtasks /Create /SC ONLOGON /TN "%TASK_NAME%" /TR "\"%START_SCRIPT%\"" /RL LIMITED /F
if %errorlevel% neq 0 (
  echo Не удалось создать задачу автозапуска.
  exit /b 1
)

echo.
echo Установка завершена.
echo Для ручного запуска используйте:
echo "%START_SCRIPT%"
echo.
echo Автозапуск создан через Task Scheduler с именем:
echo %TASK_NAME%
endlocal

