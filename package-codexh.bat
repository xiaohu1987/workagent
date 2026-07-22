@echo off
setlocal EnableExtensions EnableDelayedExpansion
title CodeXH Windows package

cd /d "%~dp0"

if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_CACHE (
  set "ELECTRON_BUILDER_CACHE=%cd%\tmp\electron-builder-cache"
  set "USING_PROJECT_BUILDER_CACHE=1"
)

set "NODE_EXE="
for /f "delims=" %%I in ('dir /b /s "%USERPROFILE%\.cache\codex-runtimes\*\dependencies\node\bin\node.exe" 2^>nul') do set "NODE_EXE=%%I"
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
  for /f "delims=" %%I in ('where pnpm 2^>nul') do if not defined PNPM_EXE set "PNPM_EXE=%%I"
)

set "EVITE_CLI=%cd%\node_modules\electron-vite\bin\electron-vite.js"
set "BUILDER_CLI=%cd%\node_modules\electron-builder\cli.js"
set "ELECTRON_INSTALL=%cd%\node_modules\electron\install.js"
set "ELECTRON_EXE=%cd%\node_modules\electron\dist\electron.exe"
set "ASAR_CLI="
for /d %%D in ("%cd%\node_modules\.pnpm\@electron+asar@*") do if not defined ASAR_CLI if exist "%%~fD\node_modules\@electron\asar\bin\asar.js" set "ASAR_CLI=%%~fD\node_modules\@electron\asar\bin\asar.js"
set "ICON_SCRIPT=%cd%\scripts\generate-app-icon.mjs"
set "SKILLS_SCRIPT=%cd%\scripts\stage-bundled-skills.mjs"
set "PLUGINS_SCRIPT=%cd%\scripts\stage-bundled-plugins.mjs"
set "WINDOWS_ICON_SCRIPT=%cd%\scripts\prepare-windows-icon-tool.mjs"
if not exist "%EVITE_CLI%" goto :install_dependencies
if not exist "%BUILDER_CLI%" goto :install_dependencies
goto :check_runtime_dependencies

:install_dependencies
if defined DEPENDENCIES_INSTALL_ATTEMPTED goto :dependencies_missing
if not defined PNPM_EXE (
  echo ERROR: Project dependencies are missing and pnpm was not found.
  echo Install pnpm or open this project in CodeXH, then run this script again.
  pause
  exit /b 1
)
set "DEPENDENCIES_INSTALL_ATTEMPTED=1"
echo Dependencies are missing. Installing them now...
if "%PNPM_USES_COREPACK%"=="1" (
  call "%PNPM_EXE%" pnpm install --no-frozen-lockfile --prefer-offline --node-linker=hoisted
) else (
  call "%PNPM_EXE%" install --no-frozen-lockfile --prefer-offline --node-linker=hoisted
)
if errorlevel 1 goto :failed
if not exist "%EVITE_CLI%" goto :dependencies_missing
if not exist "%BUILDER_CLI%" goto :dependencies_missing
goto :check_runtime_dependencies

:check_runtime_dependencies
echo Checking packaged runtime dependencies...
"%NODE_EXE%" --input-type=module -e "const modules=['echarts','mysql2/promise','pg','tedious']; const results=await Promise.all(modules.map(async name=>{try{const resolved=await import.meta.resolve(name); if(/codexh-db-drivers/i.test(resolved)) throw new Error('resolved from temporary database-driver directory'); await import(name); return ''}catch(error){return 'ERROR: '+name+' failed: '+error.message}})); for(const message of results)if(message)console.error(message); process.exitCode=results.some(Boolean)?1:0;"
if not errorlevel 1 goto :check_packaging_layout
if defined DEPENDENCIES_INSTALL_ATTEMPTED goto :dependencies_missing
goto :install_dependencies

:check_packaging_layout
"%NODE_EXE%" --input-type=module -e "import{existsSync}from'node:fs';const modules=['sql-escaper','pg-types','pg-pool','pg-protocol','pg-connection-string','pgpass','@azure/identity','@azure/core-auth','@azure/keyvault-keys','@js-joda/core','bl','js-md4','native-duplexpair','sprintf-js'];const missing=modules.filter(name=>existsSync('node_modules/'+name+'/package.json')===false);if(missing.length){console.error('Packaging layout is missing: '+missing.join(', '));process.exit(1)}"
if not errorlevel 1 goto :check_electron_runtime
if defined PACKAGING_LAYOUT_ATTEMPTED goto :dependencies_missing
if not defined PNPM_EXE goto :dependencies_missing
set "PACKAGING_LAYOUT_ATTEMPTED=1"
echo Preparing the production dependency layout...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = [System.IO.Path]::GetFullPath('%ELECTRON_EXE%');" ^
  "Get-Process -Name electron -ErrorAction SilentlyContinue |" ^
  "  Where-Object { $_.Path -and ($_.Path -ieq $exe) } |" ^
  "  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Milliseconds 400"
if "%PNPM_USES_COREPACK%"=="1" (
  call "%PNPM_EXE%" pnpm install --no-frozen-lockfile --prefer-offline --node-linker=hoisted
) else (
  call "%PNPM_EXE%" install --no-frozen-lockfile --prefer-offline --node-linker=hoisted
)
if errorlevel 1 goto :failed
goto :check_packaging_layout

:check_electron_runtime
if not exist "%ELECTRON_INSTALL%" goto :dependencies_missing
if exist "%ELECTRON_EXE%" goto :check_scripts
echo Installing the Electron runtime...
"%NODE_EXE%" "%ELECTRON_INSTALL%"
if errorlevel 1 goto :electron_install_failed
if not exist "%ELECTRON_EXE%" goto :electron_install_failed

:check_scripts
if not exist "%ICON_SCRIPT%" (
  echo ERROR: The application icon generator was not found.
  pause
  exit /b 1
)
if not exist "%SKILLS_SCRIPT%" (
  echo ERROR: The bundled skills staging script was not found.
  pause
  exit /b 1
)
if not exist "%PLUGINS_SCRIPT%" (
  echo ERROR: The bundled plugins staging script was not found.
  pause
  exit /b 1
)
if not exist "%WINDOWS_ICON_SCRIPT%" (
  echo ERROR: The Windows icon tool preparation script was not found.
  pause
  exit /b 1
)

echo [1/6] Generating application icon...
"%NODE_EXE%" "%ICON_SCRIPT%"
if errorlevel 1 goto :failed

echo [2/6] Staging bundled skills...
"%NODE_EXE%" "%SKILLS_SCRIPT%"
if errorlevel 1 goto :failed

echo [3/6] Staging bundled plugins...
"%NODE_EXE%" "%PLUGINS_SCRIPT%"
if errorlevel 1 goto :failed

echo [4/6] Preparing Windows icon tool...
"%NODE_EXE%" "%WINDOWS_ICON_SCRIPT%"
if errorlevel 1 goto :failed

echo [5/6] Building CodeXH...
"%NODE_EXE%" "%EVITE_CLI%" build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :failed

echo [6/6] Creating NSIS installer...
"%NODE_EXE%" "%BUILDER_CLI%" --win nsis
if not errorlevel 1 goto :verify_package

if not defined USING_PROJECT_BUILDER_CACHE goto :failed
echo Packaging tool download failed. Clearing the project cache and retrying once...
if exist "%ELECTRON_BUILDER_CACHE%" rmdir /s /q "%ELECTRON_BUILDER_CACHE%"
"%NODE_EXE%" "%BUILDER_CLI%" --win nsis
if errorlevel 1 goto :failed
goto :verify_package

:verify_package
if not defined ASAR_CLI (
  for /d %%D in ("%cd%\node_modules\.pnpm\@electron+asar@*") do if not defined ASAR_CLI if exist "%%~fD\node_modules\@electron\asar\bin\asar.js" set "ASAR_CLI=%%~fD\node_modules\@electron\asar\bin\asar.js"
)
if not defined ASAR_CLI goto :package_verification_failed
set "ASAR_FILE=%cd%\release\win-unpacked\resources\app.asar"
set "ASAR_LIST=%TEMP%\codexh-codexh-asar-list.txt"
if not exist "%ASAR_FILE%" goto :package_verification_failed
"%NODE_EXE%" "%ASAR_CLI%" list "%ASAR_FILE%" > "%ASAR_LIST%"
if errorlevel 1 goto :package_verification_failed
"%NODE_EXE%" --input-type=module -e "import{readFileSync}from'node:fs';const list=readFileSync(process.argv[1],'utf8');const modules=['sql-escaper','pg-types','pg-pool','pg-protocol','pg-connection-string','pgpass','@azure\\identity','@azure\\core-auth','@azure\\keyvault-keys','@js-joda\\core','bl','js-md4','native-duplexpair','sprintf-js'];const missing=modules.filter(name=>list.includes('\\node_modules\\'+name)===false);if(missing.length){console.error('Missing packaged dependencies: '+missing.join(', '));process.exit(1)}" "%ASAR_LIST%"
if errorlevel 1 goto :package_verification_failed
if not exist "%cd%\release\win-unpacked\resources\seed-plugins" goto :package_verification_failed
goto :package_complete

:package_complete

set "INSTALLER="
for %%F in ("%cd%\release\*.exe") do set "INSTALLER=%%~fF"
if not defined INSTALLER (
  echo ERROR: The package command completed but no installer was found in release.
  pause
  exit /b 1
)

set "SHA256="
for /f "skip=1 tokens=1" %%H in ('certutil -hashfile "%INSTALLER%" SHA256') do if not defined SHA256 set "SHA256=%%H"

echo.
echo Package completed.
echo Installer: %INSTALLER%
echo SHA256: %SHA256%
echo.
echo Publish the installer URL and SHA256 in /api/version/latest before users update.
pause
exit /b 0

:dependencies_missing
echo.
echo ERROR: Dependency installation completed but required packaging tools are still missing.
pause
exit /b 1

:electron_install_failed
echo.
echo ERROR: Electron runtime installation failed.
echo Check the network connection or ELECTRON_MIRROR setting, then try again.
pause
exit /b 1

:package_verification_failed
echo.
echo ERROR: The installer was created but required runtime files are missing from the package.
echo Check the dependency installation and package configuration before publishing it.
pause
exit /b 1

:failed
echo.
echo ERROR: Packaging failed. No installer was published.
pause
exit /b 1
