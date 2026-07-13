@echo off
setlocal EnableExtensions
title codexh startup

cd /d "%~dp0"

set "ELECTRON_PACKAGE_DIR=%cd%\node_modules\electron"
set "ELECTRON_CLI=%ELECTRON_PACKAGE_DIR%\cli.js"
:found_electron

set "EVITE_CLI=%cd%\node_modules\electron-vite\bin\electron-vite.js"
if not exist "%EVITE_CLI%" (
  for /f "delims=" %%I in ('dir /b /s "node_modules\electron-vite.js" 2^>nul') do (
    set "EVITE_CLI=%%I"
    goto :found_evite
  )
)
:found_evite

if not exist "%ELECTRON_CLI%" (
  echo ERROR: Electron package was not found.
  echo Run npm install or pnpm install in this folder first.
  pause
  exit /b 1
)

for /f "usebackq delims=" %%I in (`node -e "process.stdout.write(require('./node_modules/electron'))"`) do (
  set "ELECTRON_EXE=%%I"
)

if not defined ELECTRON_EXE (
  echo ERROR: Electron runtime could not be resolved.
  pause
  exit /b 1
)

if not exist "%cd%\tmp" mkdir "%cd%\tmp"
set "USER_DATA_DIR=%cd%\tmp\electron-profile"
set "DIST_DIR=%cd%\dist"
set "DIST_MAIN=%DIST_DIR%\main\index.js"
set "DIST_PRELOAD=%DIST_DIR%\preload\index.cjs"
set "DIST_RENDERER_DIR=%DIST_DIR%\renderer"
set "DIST_RENDERER_INDEX=%DIST_RENDERER_DIR%\index.html"

:build
if not exist "%EVITE_CLI%" (
  echo ERROR: electron-vite was not found, and no dist bundle is available.
  echo Run npm install or pnpm install, then rebuild the project.
  pause
  exit /b 1
)

for %%I in ("%EVITE_CLI%") do set "EVITE_BIN_DIR=%%~dpI"
for %%I in ("%EVITE_BIN_DIR%..") do set "EVITE_PKG_DIR=%%~fI"
for %%I in ("%EVITE_PKG_DIR%\..") do set "EVITE_PNPM_NODE_MODULES=%%~fI"
set "EVITE_LOCAL_NODE_MODULES=%EVITE_PKG_DIR%\node_modules"
if defined NODE_PATH (
  set "NODE_PATH=%EVITE_LOCAL_NODE_MODULES%;%EVITE_PNPM_NODE_MODULES%;%cd%\node_modules\.pnpm\node_modules;%NODE_PATH%"
) else (
  set "NODE_PATH=%EVITE_LOCAL_NODE_MODULES%;%EVITE_PNPM_NODE_MODULES%;%cd%\node_modules\.pnpm\node_modules"
)

echo [1/3] Cleaning previous dist...
if exist "%DIST_DIR%" (
  rmdir /s /q "%DIST_DIR%"
  if exist "%DIST_DIR%" (
    echo ERROR: failed to remove old dist folder. Close any process locking files under dist and try again.
    pause
    exit /b 1
  )
)

echo [2/3] Building fresh dist...
node "%EVITE_CLI%" build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :build_failed
if not exist "%DIST_MAIN%" goto :error
if not exist "%DIST_PRELOAD%" goto :error
if not exist "%DIST_RENDERER_INDEX%" goto :error
goto :launch

:launch
echo [3/3] Launching codexh with freshly built dist...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$target = [System.IO.Path]::GetFullPath('%ELECTRON_EXE%');" ^
  "$running = Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) };" ^
  "if ($running) { $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800 }"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$argsList = @('.', '--user-data-dir=%USER_DATA_DIR%'); Start-Process -FilePath '%ELECTRON_EXE%' -WorkingDirectory '%cd%' -ArgumentList $argsList"
exit /b 0

:build_failed
echo.
echo ERROR: build failed, so codexh will not launch a stale dist bundle.
echo Fix the build issue and run this script again.
pause
exit /b 1

:error
echo.
echo ERROR: startup failed. Fresh dist artifacts are incomplete.
pause
exit /b 1
