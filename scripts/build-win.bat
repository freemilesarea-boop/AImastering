@echo off
:: =============================================================================
:: build-win.bat — Louver Mastering AI — Windows distribution build
::
:: Requirements (run on Windows 10/11):
::   - Node.js >= 20  https://nodejs.org
::   - pnpm >= 9      npm install -g pnpm
::   - Python >= 3.10 https://www.python.org/downloads/
::
:: Usage:
::   scripts\build-win.bat
::
:: Output:
::   apps\desktop\out\
::     Louver-Mastering-AI-Setup-<version>.exe   (NSIS installer)
::     latest.yml                                (electron-updater metadata)
::
:: C-08 fix (audit 2026-05): portable target was dropped in v3.4.4 because
:: portable .exe can't self-update.  This script now builds the NSIS
:: installer to match the production CI pipeline + dist:win npm script.
:: =============================================================================

setlocal enabledelayedexpansion
echo ====================================================
echo   Louver Mastering AI -- Windows Build
echo ====================================================
echo.

set ROOT=%~dp0..
set DESKTOP=%ROOT%\apps\desktop
set PYTHON_SVC=%ROOT%\services\python-audio
set BIN_DIR=%DESKTOP%\public\bin
set VENV=%PYTHON_SVC%\.venv

:: ── 1. Python venv + dependencies ─────────────────────────────────────────────
echo [1/5] Setting up Python environment...
if not exist "%VENV%" (
  python -m venv "%VENV%"
  if errorlevel 1 ( echo ERROR: python -m venv failed & exit /b 1 )
)
"%VENV%\Scripts\pip" install -q --upgrade pip
"%VENV%\Scripts\pip" install -q -r "%PYTHON_SVC%\requirements.txt"
"%VENV%\Scripts\pip" install -q pyinstaller
echo   OK

:: ── 2. PyInstaller ────────────────────────────────────────────────────────────
echo.
echo [2/5] Building Python engine with PyInstaller...
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
cd /d "%PYTHON_SVC%"
"%VENV%\Scripts\pyinstaller" ^
  --clean ^
  --noconfirm ^
  --onefile ^
  --name engine ^
  --distpath "%BIN_DIR%" ^
  --workpath "%TEMP%\louver-pyinstaller-build" ^
  --specpath "%TEMP%\louver-pyinstaller-spec" ^
  --hidden-import soundfile ^
  --hidden-import numpy ^
  --collect-all soundfile ^
  --collect-all numpy ^
  --collect-all numpy.fft ^
  --exclude-module tkinter ^
  --exclude-module pytest ^
  --exclude-module matplotlib ^
  app\main.py
if errorlevel 1 ( echo ERROR: PyInstaller failed & exit /b 1 )
echo   OK: %BIN_DIR%\engine.exe

:: ── 3. FFmpeg binaries ────────────────────────────────────────────────────────
echo.
echo [3/5] Copying FFmpeg binaries...
cd /d "%DESKTOP%"
node scripts\prebuild.cjs
if errorlevel 1 ( echo ERROR: prebuild failed & exit /b 1 )

:: ── 4. Node.js dependencies ───────────────────────────────────────────────────
echo.
echo [4/5] Installing Node.js dependencies...
cd /d "%ROOT%"
pnpm install --frozen-lockfile
if errorlevel 1 ( echo ERROR: pnpm install failed & exit /b 1 )

:: ── 5. Build + package ────────────────────────────────────────────────────────
echo.
echo [5/5] Building and packaging...
cd /d "%DESKTOP%"
pnpm build
if errorlevel 1 ( echo ERROR: pnpm build failed & exit /b 1 )
:: Portable-only target — see electron-builder.yml.  NSIS is intentionally
:: disabled because of Windows MAX_PATH issues with pnpm peer-dep paths.
pnpm exec electron-builder --win nsis --x64 --publish never
if errorlevel 1 ( echo ERROR: electron-builder failed & exit /b 1 )

echo.
echo ====================================================
echo   Build complete!
echo   Output: %DESKTOP%\out\
dir "%DESKTOP%\out\*.exe" /b 2>nul
echo ====================================================
endlocal
