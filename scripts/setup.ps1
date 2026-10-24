#requires -Version 5.1
<#
.SYNOPSIS  One-Click Auto-Installer and Setup Wizard for AIR (AI Runtime).
.PARAMETER NonInteractive  Skips interactive prompts (e.g., for CI/CD or automated scripts).
.PARAMETER LaunchGui       Automatically launch the AIR Control Center GUI upon completion.
#>
[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$LaunchGui
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Split-Path $PSScriptRoot -Parent)
Set-Location $repoRoot

function Log-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Log-Pass($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Log-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

Write-Host "=====================================================================" -ForegroundColor Blue
Write-Host "  AIR - AI Runtime Auto-Installer (Windows)" -ForegroundColor White
Write-Host "=====================================================================" -ForegroundColor Blue

# 1. Check Tooling
Log-Step "Verifying Prerequisites"

# Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js not found. Please install Node.js 22 LTS or later from https://nodejs.org"
}
$nodeVersion = (node -v).TrimStart('v')
$nodeMajor = [int]$nodeVersion.Split('.')[0]
if ($nodeMajor -lt 22) {
    throw "Node.js 22 LTS or later is required (detected v$nodeVersion)."
}
Log-Pass "Node.js v$nodeVersion detected"

# Git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git for Windows not found. Please install Git from https://git-scm.com"
}
Log-Pass "Git detected"

# 2. Setup AIR_HOME
Log-Step "Initializing AIR_HOME Directory Structure"
$airHome = if ($env:AIR_HOME) { $env:AIR_HOME } else { Join-Path $env:LOCALAPPDATA 'AIR' }
$directories = @(
    'config',
    'agents',
    'journal\segments',
    'memory',
    'logs\crash',
    'run',
    'tmp'
)
foreach ($dir in $directories) {
    $fullPath = Join-Path $airHome $dir
    if (-not (Test-Path $fullPath)) {
        New-Item -ItemType Directory -Force -Path $fullPath | Out-Null
    }
}
Log-Pass "AIR_HOME initialized at $airHome"

# 3. Initialize Default Configuration
Log-Step "Checking Configuration"
$configPath = Join-Path $airHome 'config\air.config.json'
if (-not (Test-Path $configPath)) {
    $exampleConfig = Join-Path $repoRoot 'config\air.config.example.json'
    if (Test-Path $exampleConfig) {
        Copy-Item $exampleConfig $configPath
        Log-Pass "Created default configuration from example at $configPath"
    }
} else {
    Log-Pass "Configuration exists at $configPath"
}

# 4. Install Dependencies
Log-Step "Installing NPM Dependencies"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
Log-Pass "Dependencies up to date"

# 5. Build Project
Log-Step "Building TypeScript Binaries"
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
Log-Pass "Compilation successful (dist/ ready)"

# 6. Create Desktop & Start Menu Shortcuts
Log-Step "Creating Application Shortcuts"
try {
    $wscript = New-Object -ComObject WScript.Shell
    $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { (Get-Command pwsh).Source } else { (Get-Command powershell).Source }

    # Desktop shortcut
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $desktopShortcutPath = Join-Path $desktopPath 'AIR Control Center.lnk'
    $shortcut = $wscript.CreateShortcut($desktopShortcutPath)
    $shortcut.TargetPath = $psExe
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$repoRoot'; node dist/shell/main.js gui`""
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.Description = "AIR - AI Runtime Control Center & Interactive GUI"
    $shortcut.Save()
    Log-Pass "Desktop shortcut created: $desktopShortcutPath"

    # Start Menu shortcut
    $startMenuPrograms = [Environment]::GetFolderPath('Programs')
    if (Test-Path $startMenuPrograms) {
        $startMenuShortcutPath = Join-Path $startMenuPrograms 'AIR Control Center.lnk'
        $shortcutSm = $wscript.CreateShortcut($startMenuShortcutPath)
        $shortcutSm.TargetPath = $psExe
        $shortcutSm.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$repoRoot'; node dist/shell/main.js gui`""
        $shortcutSm.WorkingDirectory = $repoRoot
        $shortcutSm.Description = "AIR - AI Runtime Control Center & Interactive GUI"
        $shortcutSm.Save()
        Log-Pass "Start Menu shortcut created: $startMenuShortcutPath"
    }
} catch {
    Log-Warn "Could not create Windows shell shortcuts: $($_.Exception.Message)"
}

# 7. Verification Summary
Log-Step "Setup Verification"
& (Join-Path $PSScriptRoot 'doctor.ps1')

Write-Host "`n=====================================================================" -ForegroundColor Green
Write-Host "  AIR Runtime is ready to use!" -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Green
Write-Host "You can now run:"
Write-Host "  1. AIR Control Center GUI : node dist/shell/main.js gui  (or double-click the Desktop shortcut)"
Write-Host "  2. AIR CLI Shell          : node dist/shell/main.js"
Write-Host "  3. AIR Daemon Service     : node dist/service/main.js"
Write-Host ""

if ($LaunchGui -or (-not $NonInteractive -and ($Host.UI.RawUI -ne $null))) {
    $resp = if ($LaunchGui) { 'Y' } else { Read-Host "Would you like to launch the AIR Control Center GUI now? (Y/N)" }
    if ($resp -match '^(y|yes)$') {
        Write-Host "Launching AIR Control Center..." -ForegroundColor Cyan
        Start-Process $psExe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$repoRoot'; node dist/shell/main.js gui`""
    }
}
