@echo off
setlocal EnableExtensions EnableDelayedExpansion
title CodeXH Windows package

cd /d "%~dp0"

if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

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
set "PNPM_EXE=%DEPENDENCIES_DIR%\bin\fallback\pnpm.cmd"
if not exist "%PNPM_EXE%" (
  set "PNPM_EXE="
  for /f "delims=" %%I in ('where pnpm 2^>nul') do if not defined PNPM_EXE set "PNPM_EXE=%%I"
)

set "EVITE_CLI=%cd%\node_modules\electron-vite\bin\electron-vite.js"
set "BUILDER_CLI=%cd%\node_modules\electron-builder\cli.js"
set "ICON_SCRIPT=%cd%\scripts\generate-app-icon.mjs"
set "SKILLS_SCRIPT=%cd%\scripts\stage-bundled-skills.mjs"
if not exist "%EVITE_CLI%" goto :install_dependencies
if not exist "%BUILDER_CLI%" goto :install_dependencies
goto :check_scripts

:install_dependencies
if not defined PNPM_EXE (
  echo ERROR: Project dependencies are missing and pnpm was not found.
  echo Install pnpm or open this project in CodeXH, then run this script again.
  pause
  exit /b 1
)
echo Dependencies are missing. Installing them now...
call "%PNPM_EXE%" install --no-frozen-lockfile
if errorlevel 1 goto :failed
if not exist "%EVITE_CLI%" goto :dependencies_missing
if not exist "%BUILDER_CLI%" goto :dependencies_missing

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

echo [1/4] Generating application icon...
"%NODE_EXE%" "%ICON_SCRIPT%"
if errorlevel 1 goto :failed

echo [2/4] Staging bundled skills...
"%NODE_EXE%" "%SKILLS_SCRIPT%"
if errorlevel 1 goto :failed

echo [3/4] Building CodeXH...
"%NODE_EXE%" "%EVITE_CLI%" build --config apps\desktop\electron.vite.config.ts
if errorlevel 1 goto :failed

echo [4/4] Creating NSIS installer...
"%NODE_EXE%" "%BUILDER_CLI%" --win nsis
if errorlevel 1 goto :failed

set "INSTALLER="
for %%F in ("%cd%\release\*.exe") do set "INSTALLER=%%~fF"
if not defined INSTALLER (
  echo ERROR: The package command completed but no installer was found in release.
  pause
  exit /b 1
)

set "SHA256="
for /f "tokens=1" %%H in ('certutil -hashfile "%INSTALLER%" SHA256 ^| findstr /r "^[0-9A-F][0-9A-F]"') do set "SHA256=%%H"

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

:failed
echo.
echo ERROR: Packaging failed. No installer was published.
pause
exit /b 1
