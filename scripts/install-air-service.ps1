#requires -RunAsAdministrator
# ============================================================================
# install-air-service.ps1 — Installs `aird` as a Windows Service (Phase W5).
#
# Registers the AIR Runtime daemon (aird) as a Windows Service using the
# Service Control Manager (SCM). Configures:
#   - Service name: aird
#   - Display name: AIR Runtime Daemon
#   - Start type: Automatic
#   - Recovery: Restart on failure (30 second delay)
#   - Log on as: LocalSystem
#
# Prerequisites:
#   - AIR binaries built and available (aird.exe, air-sandbox.exe)
#   - Administrator privileges (required for SCM access)
#
# Usage:
#   .\scripts\install-air-service.ps1 [-AirExePath <path>] [-StartType Auto|Demand|Disabled]
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$AirExePath = '',

    [Parameter(Mandatory = $false)]
    [ValidateSet('Auto', 'Demand', 'Disabled')]
    [string]$StartType = 'Auto',

    [Parameter(Mandatory = $false)]
    [ValidateSet('Restart', 'None', 'Reboot')]
    [string]$FailureAction = 'Restart',

    [Parameter(Mandatory = $false)]
    [int]$RestartDelayMs = 30000,

    [Parameter(Mandatory = $false)]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'aird'
$DisplayName = 'AIR Runtime Daemon'
$Description = 'AIR - AI Runtime daemon. Hosts LLM-driven agents as managed, supervised, observable, policy-governed processes.'

# Determine the AIR executable path.
if (-not $AirExePath) {
    # Look for aird.exe in common locations.
    $candidatePaths = @(
        Join-Path $PSScriptRoot '..\dist\service\main.js',
        Join-Path $PSScriptRoot '..\dist\aird.exe',
        Join-Path $env:LOCALAPPDATA 'AIR\aird.exe',
        'C:\Program Files\AIR\aird.exe',
    )
    foreach ($candidate in $candidatePaths) {
        $resolved = Resolve-Path $candidate -ErrorAction SilentlyContinue
        if ($resolved) {
            $AirExePath = $resolved
            break
        }
    }
}

if (-not $AirExePath) {
    Write-Error "Could not locate aird.exe. Specify -AirExePath explicitly."
    exit 1
}

Write-Host "Installing AIR Runtime Daemon service..."
Write-Host "  Service name: $ServiceName"
Write-Host "  Executable:   $AirExePath"
Write-Host "  Start type:   $StartType"
Write-Host "  Failure action: $FailureAction (delay: $RestartDelayMs ms)"

# Check if service already exists.
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    if (-not $Force) {
        Write-Error "Service '$ServiceName' is already installed. Use -Force to reinstall."
        exit 1
    }
    Write-Host "Service '$ServiceName' already exists. Removing existing service..."
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1000
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Milliseconds 500
}

# Create the service.
$scArgs = @(
    'create',
    $ServiceName,
    "binPath= `"$AirExePath`"",
    "displayName= `"$DisplayName`"",
    "start= $StartType",
    'obj= LocalSystem',
)

Write-Host "Creating service..."
$createResult = & sc.exe @scArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to create service: $createResult"
    exit 1
}

# Set description.
sc.exe config $ServiceName displayName= `"$DisplayName`" | Out-Null
sc.exe config $ServiceName obj= LocalSystem type= own error= normal | Out-Null

# Configure recovery actions.
$resetPeriod = 86400 # 1 day in seconds
$action1 = "restart/$RestartDelayMs"
$action2 = "restart/$RestartDelayMs"
$action3 = "restart/$RestartDelayMs"

sc.exe failure $ServiceName reset= $resetPeriod actions= $action1/$action2/$action3 | Out-Null
sc.exe failure $ServiceName command= `"$AirExePath`" | Out-Null

Write-Host "Service '$ServiceName' installed successfully."
Write-Host ""
Write-Host "To start the service:   net start $ServiceName"
Write-Host "To stop the service:    net stop $ServiceName"
Write-Host "To query status:        sc query $ServiceName"
Write-Host "To uninstall:           .\scripts\uninstall-air-service.ps1"
