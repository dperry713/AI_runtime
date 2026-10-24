@echo off
setlocal enabledelayedexpansion
title AIR Runtime Setup

echo =====================================================================
echo  AIR — AI Runtime for Windows
echo  Auto-Installer and Environment Setup
echo =====================================================================
echo.

:: Detect PowerShell 7 (pwsh) or fall back to Windows PowerShell
where pwsh >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PS_EXE=pwsh"
) else (
    set "PS_EXE=powershell"
)

echo [*] Launching installer with %PS_EXE%...
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Setup encountered an error. See output above.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [*] AIR Runtime setup completed successfully!
pause
