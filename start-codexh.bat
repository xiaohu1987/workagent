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
set "DIST_MAIN=%cd%\dist\main\index.js"
set "DIST_PRELOAD=%cd%\dist\preload\index.cjs"
set "DIST_RENDERER_DIR=%cd%\dist\renderer"
set "DIST_RENDERER_INDEX=%DIST_RENDERER_DIR%\index.html"

if /I "%CODEXH_FORCE_BUILD%"=="1" (
  set "BUILD_REASON=forced rebuild requested"
  goto :build
)

set "BUILD_DECISION="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$sourceFiles = @(); " ^
  "$sourceFiles += Get-ChildItem -LiteralPath '%cd%\apps\desktop\src' -Recurse -File; " ^
  "$sourceFiles += Get-ChildItem -LiteralPath '%cd%\packages' -Recurse -File; " ^
  "$sourceFiles += Get-Item -LiteralPath '%cd%\package.json','%cd%\pnpm-lock.yaml','%cd%\tsconfig.base.json' -ErrorAction SilentlyContinue; " ^
  "$latestSource = ($sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc; " ^
  "$main = Get-Item -LiteralPath '%DIST_MAIN%' -ErrorAction SilentlyContinue; " ^
  "$preload = Get-Item -LiteralPath '%DIST_PRELOAD%' -ErrorAction SilentlyContinue; " ^
  "$rendererFiles = @(Get-ChildItem -LiteralPath '%DIST_RENDERER_DIR%' -Recurse -File -ErrorAction SilentlyContinue); " ^
  "if (-not $main -or -not $preload -or $rendererFiles.Count -eq 0 -or -not (Test-Path -LiteralPath '%DIST_RENDERER_INDEX%')) { 'build:missing dist outputs'; exit }; " ^
  "$latestRenderer = ($rendererFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc; " ^
  "if ($main.LastWriteTimeUtc -lt $latestSource -or $preload.LastWriteTimeUtc -lt $latestSource -or $latestRenderer -lt $latestSource) { 'build:source newer than dist' } else { 'skip:dist up to date' }"` ) do (
  set "BUILD_DECISION=%%I"
)

if not defined BUILD_DECISION (
  set "BUILD_REASON=unable to determine bundle freshness"
  goto :build
)

if /I "%BUILD_DECISION:~0,5%"=="skip:" goto :launch_ready

set "BUILD_REASON=%BUILD_DECISION:~6%"

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

if defined BUILD_REASON (
  echo [1/2] Building codexh... (%BUILD_REASON%)
) else (
  echo [1/2] Building codexh...
)
node "%EVITE_CLI%" build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :build_failed
if not exist "%DIST_MAIN%" goto :error
goto :launch

:launch_ready
echo [1/2] Using existing dist bundle...

:launch
echo [2/2] Launching codexh...
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
echo ERROR: startup failed.
pause
exit /b 1
