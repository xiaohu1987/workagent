@echo off
setlocal EnableExtensions
title codexh startup

cd /d "%~dp0"

if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

set "NODE_EXE="
for /d %%D in ("%USERPROFILE%\.cache\codex-runtimes\*") do (
  if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fD\dependencies\node\bin\node.exe"
)
if not defined NODE_EXE (
  for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
  echo ERROR: Node.js was not found.
  echo Install Node.js 22 or later, then run this script again.
  pause
  exit /b 1
)

for %%I in ("%NODE_EXE%") do set "NODE_BIN=%%~dpI"
for %%I in ("%NODE_BIN%\..\..") do set "DEPENDENCIES_DIR=%%~fI"
set "PATH=%NODE_BIN%;%PATH%"
set "PNPM_EXE="
set "PNPM_USES_COREPACK=0"
for /f "delims=" %%I in ('where corepack.cmd 2^>nul') do if not defined PNPM_EXE (
  set "PNPM_EXE=%%I"
  set "PNPM_USES_COREPACK=1"
)
if not defined PNPM_EXE (
  set "PNPM_EXE=%DEPENDENCIES_DIR%\bin\fallback\pnpm.cmd"
)
if not exist "%PNPM_EXE%" (
  set "PNPM_EXE="
  for /f "delims=" %%I in ('where pnpm.cmd 2^>nul') do if not defined PNPM_EXE set "PNPM_EXE=%%I"
)

set "ELECTRON_PACKAGE_DIR=%cd%\node_modules\electron"
set "ELECTRON_CLI=%ELECTRON_PACKAGE_DIR%\cli.js"
set "ELECTRON_EXE=%ELECTRON_PACKAGE_DIR%\dist\electron.exe"
set "ELECTRON_INSTALL=%ELECTRON_PACKAGE_DIR%\install.js"
:found_electron

set "EVITE_CLI=%cd%\node_modules\electron-vite\bin\electron-vite.js"
if not exist "%EVITE_CLI%" (
  for /f "delims=" %%I in ('dir /b /s "node_modules\electron-vite.js" 2^>nul') do (
    set "EVITE_CLI=%%I"
    goto :found_evite
  )
)
:found_evite

echo Checking project dependencies...
"%NODE_EXE%" --input-type=module -e "import{existsSync,readFileSync}from'node:fs';import{join}from'node:path';const p=JSON.parse(readFileSync('package.json','utf8'));const names=[...Object.keys(p.dependencies??{}),...Object.keys(p.devDependencies??{})];const missing=names.filter(name=>!existsSync(join('node_modules',name,'package.json')));if(missing.length){console.error('Missing dependencies: '+missing.join(', '));process.exit(1)}"
if not errorlevel 1 goto :dependencies_ready
if not defined PNPM_EXE goto :dependencies_missing
echo Stopping the previous Electron instance before updating dependencies...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = [System.IO.Path]::GetFullPath('%ELECTRON_EXE%');" ^
  "Get-Process -Name electron -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.Path -and ($_.Path -ieq $exe) } |" ^
  "  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Milliseconds 400"
echo Installing missing project dependencies...
if "%PNPM_USES_COREPACK%"=="1" (
  call "%PNPM_EXE%" pnpm install --no-frozen-lockfile --prefer-offline
) else (
  call "%PNPM_EXE%" install --no-frozen-lockfile --prefer-offline
)
if errorlevel 1 goto :dependency_install_failed

:dependencies_ready
if not exist "%ELECTRON_CLI%" (
  echo ERROR: Electron package was not found.
  echo Dependency installation did not provide Electron.
  pause
  exit /b 1
)

if exist "%ELECTRON_EXE%" goto :electron_ready
if not exist "%ELECTRON_INSTALL%" goto :electron_install_failed
echo Installing the Electron runtime...
"%NODE_EXE%" "%ELECTRON_INSTALL%"
if errorlevel 1 goto :electron_install_failed
if not exist "%ELECTRON_EXE%" goto :electron_install_failed

:electron_ready

if not exist "%cd%\tmp" mkdir "%cd%\tmp"
if not exist "%cd%\log" mkdir "%cd%\log"
set "USER_DATA_DIR=%cd%\tmp\electron-profile"
set "STDOUT_LOG=%cd%\log\electron.stdout.log"
set "STDERR_LOG=%cd%\log\electron.stderr.log"
set "DIST_DIR=%cd%\dist"
set "DIST_MAIN=%DIST_DIR%\main\index.js"
set "DIST_PRELOAD=%DIST_DIR%\preload\index.cjs"
set "DIST_RENDERER_DIR=%DIST_DIR%\renderer"
set "DIST_RENDERER_INDEX=%DIST_RENDERER_DIR%\index.html"

:check_dist
if /i "%~1"=="--skip-build" (
  if exist "%DIST_MAIN%" if exist "%DIST_PRELOAD%" if exist "%DIST_RENDERER_INDEX%" goto :launch
  goto :error
)

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

echo [1/2] Building the latest dist...
"%NODE_EXE%" "%EVITE_CLI%" build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :build_failed
if not exist "%DIST_MAIN%" goto :error
if not exist "%DIST_PRELOAD%" goto :error
if not exist "%DIST_RENDERER_INDEX%" goto :error
goto :launch

:launch
echo [2/2] Launching codexh...
REM Avoid Get-CimInstance/WMI here: it can hang indefinitely on some Windows hosts.
echo Stopping previous Electron instance if running...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = [System.IO.Path]::GetFullPath('%ELECTRON_EXE%');" ^
  "Get-Process -Name electron -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.Path -and ($_.Path -ieq $exe) } |" ^
  "  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Milliseconds 400"
echo Starting Electron...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$argsList = @('.', '--user-data-dir=%USER_DATA_DIR%'); Start-Process -FilePath '%ELECTRON_EXE%' -WorkingDirectory '%cd%' -ArgumentList $argsList -RedirectStandardOutput '%STDOUT_LOG%' -RedirectStandardError '%STDERR_LOG%'"
if errorlevel 1 goto :launch_failed
echo Launched. You can close this window.
exit /b 0

:dependencies_missing
echo.
echo ERROR: Project dependencies are missing and pnpm was not found.
echo Install pnpm or open this project in CodeXH, then run this script again.
pause
exit /b 1

:dependency_install_failed
echo.
echo ERROR: Project dependency installation failed.
pause
exit /b 1

:electron_install_failed
echo.
echo ERROR: Electron runtime installation failed.
echo Check the network connection or ELECTRON_MIRROR setting, then try again.
pause
exit /b 1

:launch_failed
echo.
echo ERROR: Electron could not be started. See log\electron.stderr.log for details.
pause
exit /b 1

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
