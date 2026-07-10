@echo off
setlocal EnableExtensions
title codexh startup

cd /d "%~dp0"

set "ELECTRON_EXE=%cd%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo ERROR: Electron runtime was not found.
  echo Run npm install or pnpm install in this folder first.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\electron-vite.CMD" (
  echo ERROR: electron-vite was not found.
  echo Run npm install or pnpm install in this folder first.
  pause
  exit /b 1
)

echo [1/2] Building codexh...
call node_modules\.bin\electron-vite.CMD build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :error

echo [2/2] Launching codexh...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target = [System.IO.Path]::GetFullPath('%ELECTRON_EXE%');" ^
  "$running = Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) };" ^
  "if ($running) { $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800 }"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath '%ELECTRON_EXE%' -WorkingDirectory '%cd%' -ArgumentList '.'"
exit /b 0

:error
echo.
echo ERROR: startup failed.
pause
exit /b 1
