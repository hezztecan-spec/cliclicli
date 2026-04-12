@echo off
setlocal

set "TASK_NAME=RemoteControlClient"

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
echo Автозапуск удален: %TASK_NAME%

endlocal

