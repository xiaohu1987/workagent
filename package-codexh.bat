@echo off
setlocal EnableExtensions EnableDelayedExpansion
title CodeXH Windows package

cd /d "%~dp0"

rem Set CODEXH_PACKAGE_NO_PAUSE=1 when running unattended (CI, scheduled jobs, agents).
set "PAUSE_CMD=pause"
if defined CODEXH_PACKAGE_NO_PAUSE set "PAUSE_CMD=rem"

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
  %PAUSE_CMD%
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
set "LOCK_REPORT_SCRIPT=%cd%\scripts\report-package-locks.ps1"
if not exist "%EVITE_CLI%" goto :install_dependencies
if not exist "%BUILDER_CLI%" goto :install_dependencies
goto :check_runtime_dependencies

:install_dependencies
if defined DEPENDENCIES_INSTALL_ATTEMPTED goto :dependencies_missing
if not defined PNPM_EXE (
  echo ERROR: Project dependencies are missing and pnpm was not found.
  echo Install pnpm or open this project in CodeXH, then run this script again.
  %PAUSE_CMD%
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
call :stop_codexh_instances
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
  %PAUSE_CMD%
  exit /b 1
)
if not exist "%SKILLS_SCRIPT%" (
  echo ERROR: The bundled skills staging script was not found.
  %PAUSE_CMD%
  exit /b 1
)
if not exist "%PLUGINS_SCRIPT%" (
  echo ERROR: The bundled plugins staging script was not found.
  %PAUSE_CMD%
  exit /b 1
)
if not exist "%WINDOWS_ICON_SCRIPT%" (
  echo ERROR: The Windows icon tool preparation script was not found.
  %PAUSE_CMD%
  exit /b 1
)

call :stop_codexh_instances
call :prepare_package_output

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

rem A build that reports success yet leaves partial output would be packaged into a
rem broken installer, so check the three entry points the packaged app loads.
if not exist "%cd%\dist\main\index.js" goto :build_output_missing
if not exist "%cd%\dist\preload\index.cjs" goto :build_output_missing
if not exist "%cd%\dist\renderer\index.html" goto :build_output_missing

echo [6/6] Creating NSIS installer...
"%NODE_EXE%" "%BUILDER_CLI%" %BUILDER_ARGS%
if not errorlevel 1 goto :verify_package

if not defined USING_PROJECT_BUILDER_CACHE goto :failed
echo Packaging failed. Clearing the packaging tool cache and retrying once...
if exist "%ELECTRON_BUILDER_CACHE%" rmdir /s /q "%ELECTRON_BUILDER_CACHE%"
if defined BUILDER_OUTPUT goto :retry_with_fresh_output
goto :retry_packaging

rem A failed pass can leave an output directory whose app.asar is now held open by
rem another process, which would make the retry fail while cleaning it up. The retry
rem therefore builds into its own output directory.
:retry_with_fresh_output
set "PACK_OUT_DIR=%STAGING_ROOT%-retry-%RANDOM%%RANDOM%"
set "BUILDER_OUTPUT=%PACK_OUT_DIR%"
set "BUILDER_OUTPUT_FORWARD=%PACK_OUT_DIR:\=/%"
set "BUILDER_ARGS=--win nsis --publish never --config.directories.output=%BUILDER_OUTPUT_FORWARD%"

:retry_packaging
"%NODE_EXE%" "%BUILDER_CLI%" %BUILDER_ARGS%
if errorlevel 1 goto :failed
goto :verify_package

:verify_package
if not defined PACK_OUT_DIR set "PACK_OUT_DIR=%cd%\release"
if not defined ASAR_CLI (
  for /d %%D in ("%cd%\node_modules\.pnpm\@electron+asar@*") do if not defined ASAR_CLI if exist "%%~fD\node_modules\@electron\asar\bin\asar.js" set "ASAR_CLI=%%~fD\node_modules\@electron\asar\bin\asar.js"
)
if not defined ASAR_CLI goto :package_verification_failed
set "ASAR_FILE=%PACK_OUT_DIR%\win-unpacked\resources\app.asar"
set "ASAR_LIST=%TEMP%\codexh-codexh-asar-list.txt"
if not exist "%ASAR_FILE%" goto :package_verification_failed
"%NODE_EXE%" "%ASAR_CLI%" list "%ASAR_FILE%" > "%ASAR_LIST%"
if errorlevel 1 goto :package_verification_failed
"%NODE_EXE%" --input-type=module -e "import{readFileSync}from'node:fs';const list=readFileSync(process.argv[1],'utf8');const modules=['sql-escaper','pg-types','pg-pool','pg-protocol','pg-connection-string','pgpass','@azure\\identity','@azure\\core-auth','@azure\\keyvault-keys','@js-joda\\core','bl','js-md4','native-duplexpair','sprintf-js'];const missing=modules.filter(name=>list.includes('\\node_modules\\'+name)===false);if(missing.length){console.error('Missing packaged dependencies: '+missing.join(', '));process.exit(1)}" "%ASAR_LIST%"
if errorlevel 1 goto :package_verification_failed
if not exist "%PACK_OUT_DIR%\win-unpacked\resources\seed-plugins" goto :package_verification_failed
set "BACKGROUND_VIDEO_DIR=%PACK_OUT_DIR%\win-unpacked\resources\background-videos"
"%NODE_EXE%" --input-type=module -e "import{existsSync,readdirSync}from'node:fs';const source='apps/desktop/src/renderer/assets';const target=process.argv[1];const videos=readdirSync(source).filter(name=>name.toLowerCase().endsWith('.mp4'));const missing=videos.filter(name=>existsSync(target+'\\'+name)===false);if(videos.length===0){console.error('No background videos found in '+source);process.exit(1)}if(missing.length){console.error('Missing packaged background videos: '+missing.join(', '));process.exit(1)}console.log('Verified packaged background videos: '+videos.length)" "%BACKGROUND_VIDEO_DIR%"
if errorlevel 1 goto :package_verification_failed
goto :package_complete

:package_complete
if not defined PACK_OUT_DIR set "PACK_OUT_DIR=%cd%\release"

if /i not "%PACK_OUT_DIR%"=="%cd%\release" (
  echo Publishing installer artifacts from %PACK_OUT_DIR% to release...
  copy /y "%PACK_OUT_DIR%\*.exe" "%cd%\release\" >nul
  if errorlevel 1 goto :failed
  if exist "%PACK_OUT_DIR%\*.blockmap" copy /y "%PACK_OUT_DIR%\*.blockmap" "%cd%\release\" >nul
  if exist "%PACK_OUT_DIR%\latest.yml" copy /y "%PACK_OUT_DIR%\latest.yml" "%cd%\release\" >nul
)

set "INSTALLER="
rem release keeps the installers of earlier versions, so take the most recently built
rem one (dir /o-d sorts newest first) instead of whichever name sorts last.
for /f "delims=" %%F in ('dir /b /o-d "%cd%\release\*.exe" 2^>nul') do if not defined INSTALLER set "INSTALLER=%cd%\release\%%F"
if not defined INSTALLER (
  echo ERROR: The package command completed but no installer was found in release.
  %PAUSE_CMD%
  exit /b 1
)

set "SHA256="
for /f "skip=1 tokens=1" %%H in ('certutil -hashfile "%INSTALLER%" SHA256') do if not defined SHA256 set "SHA256=%%H"

echo.
echo Package completed.
echo Installer: %INSTALLER%
echo SHA256: %SHA256%
if defined BUILDER_OUTPUT echo Unpacked build: %PACK_OUT_DIR%\win-unpacked
echo.
echo Publish the installer URL and SHA256 in /api/version/latest before users update.
%PAUSE_CMD%
exit /b 0

:dependencies_missing
echo.
echo ERROR: Dependency installation completed but required packaging tools are still missing.
%PAUSE_CMD%
exit /b 1

:electron_install_failed
echo.
echo ERROR: Electron runtime installation failed.
echo Check the network connection or ELECTRON_MIRROR setting, then try again.
%PAUSE_CMD%
exit /b 1

:package_verification_failed
echo.
echo ERROR: The installer was created but required runtime files are missing from the package.
echo Check the dependency installation and package configuration before publishing it.
%PAUSE_CMD%
exit /b 1

:build_output_missing
echo.
echo ERROR: The build finished without producing a complete dist bundle, so nothing was
echo packaged. Expected dist\main\index.js, dist\preload\index.cjs and
echo dist\renderer\index.html. Run the build again - a partial bundle usually means the
echo build was interrupted or failed silently.
%PAUSE_CMD%
exit /b 1

:failed
echo.
echo ERROR: Packaging failed. No installer was published.
%PAUSE_CMD%
exit /b 1

:stop_codexh_instances
echo Stopping any running CodeXH instance from this project...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$projectRoot = [System.IO.Path]::GetFullPath('%cd%') + [System.IO.Path]::DirectorySeparatorChar;" ^
  "$targets = @($projectRoot + 'release' + [System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::GetFullPath('%ELECTRON_EXE%'));" ^
  "$stopped = 0;" ^
  "Get-Process -ErrorAction SilentlyContinue | ForEach-Object {" ^
  "  $proc = $_;" ^
  "  $path = $null;" ^
  "  try { $path = $proc.Path } catch { }" ^
  "  if (-not $path) { return }" ^
  "  $hit = $false;" ^
  "  foreach ($target in $targets) { if ($target -and $path.StartsWith($target, [System.StringComparison]::OrdinalIgnoreCase)) { $hit = $true; break } }" ^
  "  if ($hit) { Write-Host ('  stopping ' + $proc.ProcessName + ' (PID ' + $proc.Id + ')'); Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; $stopped += 1 }" ^
  "};" ^
  "if ($stopped -eq 0) { Write-Host '  no running instance found' } else { Start-Sleep -Milliseconds 600 }"
exit /b 0

rem Decides where electron-builder writes its output. Normally that is release, but a
rem leftover release\win-unpacked cannot be removed while another process still holds
rem its app.asar open, and electron-builder would then fail with EBUSY on app.asar.
rem In that case packaging runs from a staging directory outside the project, which no
rem workspace scanner keeps open, so the directory stays reusable. The installer is
rem copied back into release either way.
:prepare_package_output
set "BUILDER_OUTPUT="
set "BUILDER_ARGS=--win nsis --publish never"
set "PACK_OUT_DIR=%cd%\release"

rem Reclaim staging directories left behind by earlier runs. They only ever hold build
rem scratch data, so removing them is safe; ones still held open are left untouched.
for /d %%D in ("%cd%\release\packed*") do call :reclaim_staging_dir "%%~fD"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%TEMP%"
set "STAGING_ROOT=%LOCALAPPDATA%\CodeXH\package-output"
call :reclaim_staging_dir "%STAGING_ROOT%"

if not exist "%cd%\release\win-unpacked" exit /b 0

set "STALE_ASAR=%cd%\release\win-unpacked\resources\app.asar"
call :probe_locked "%STALE_ASAR%"
if defined LOCKED_PATH goto :prepare_package_output_locked

:prepare_package_output_reclaim
rem Seeded skills ship a .git directory whose pack files are read-only, and rd cannot
rem delete read-only files, so clear the attributes first.
attrib -R -S -H /S /D "%cd%\release\win-unpacked\*" >nul 2>&1
rd /s /q "%cd%\release\win-unpacked" >nul 2>&1
if not exist "%cd%\release\win-unpacked" exit /b 0

:prepare_package_output_locked
echo.
echo WARNING: release\win-unpacked cannot be replaced - a file inside it is held open by
echo          another process. Usual causes: a running CodeXH window, a file preview in
echo          an editor, or a workspace indexer that keeps app.asar open.
call :report_package_lock "%STALE_ASAR%"
echo          Building in a staging directory outside the project instead.
echo          The installer is still published into release.

set "PACK_OUT_DIR=%STAGING_ROOT%"
if not exist "%PACK_OUT_DIR%\win-unpacked" goto :prepare_package_output_ready
set "PACK_OUT_DIR=%STAGING_ROOT%-%RANDOM%%RANDOM%"

:prepare_package_output_ready
set "BUILDER_OUTPUT=%PACK_OUT_DIR%"
set "BUILDER_OUTPUT_FORWARD=%PACK_OUT_DIR:\=/%"
set "BUILDER_ARGS=--win nsis --publish never --config.directories.output=%BUILDER_OUTPUT_FORWARD%"
echo          Output directory: %PACK_OUT_DIR%
exit /b 0

rem Best-effort listing of the processes holding the locked file. Never fails the build.
:report_package_lock
if not exist "%LOCK_REPORT_SCRIPT%" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCK_REPORT_SCRIPT%" -Path "%~1"
exit /b 0

rem Sets LOCKED_PATH when the given file is held open by another process. Renaming a
rem file requires the same delete access that electron-builder needs, so that is used
rem as the probe; it is undone immediately when it succeeds, so nothing is modified.
:probe_locked
set "LOCKED_PATH="
if not exist "%~1" exit /b 0
rem A probe file left behind by an interrupted run would make ren fail below and look
rem like a lock, so drop it first (a no-op when it does not exist).
del "%~dp1lockprobe.tmp" >nul 2>&1
ren "%~1" "lockprobe.tmp" >nul 2>&1
if errorlevel 1 (
  set "LOCKED_PATH=%~1"
  exit /b 0
)
ren "%~dp1lockprobe.tmp" "%~nx1" >nul 2>&1
exit /b 0

rem Removes one staging directory from an earlier run. A file that is still held open
rem would make the removal stop halfway and leave a crippled directory behind, so the
rem lock is probed first and the directory is left untouched when it is locked.
:reclaim_staging_dir
if not exist "%~1" exit /b 0
call :probe_locked "%~1\win-unpacked\resources\app.asar"
if defined LOCKED_PATH (
  echo          Keeping staging directory - a file in it is held open: %~1
  exit /b 0
)
rem Seeded skills ship a .git directory whose pack files are read-only, and rd cannot
rem delete read-only files, so clear the attributes first.
attrib -R -S -H /S /D "%~1\*" >nul 2>&1
rd /s /q "%~1" >nul 2>&1
if exist "%~1" (
  echo          Keeping staging directory - could not be fully removed: %~1
) else (
  echo          Reclaimed staging directory: %~1
)
exit /b 0
