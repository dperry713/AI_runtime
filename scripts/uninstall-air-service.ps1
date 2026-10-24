#requires -RunAsAdministrator
# ============================================================================
# uninstall-air-service.ps1 — Uninstalls the `aird` Windows Service (Phase W5).
#
# Stops and removes the AIR Runtime daemon service from the Service Control
# Manager (SCM).
#
# Usage:
#   .\scripts\uninstall-air-service.ps1 [-ServiceName <name>]
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ServiceName = 'aird'
)

$ErrorActionPreference = 'Stop'

Write-Host "Uninstalling AIR Runtime Daemon service..."
Write-Host "  Service name: $ServiceName"

# Check if service exists.
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existingService) {
    Write-Host "Service '$ServiceName' is not installed. Nothing to do."
    exit 0
}

# Stop the service if running.
if ($existingService.Status -eq 'Running') {
    Write-Host "Stopping service '$ServiceName'..."
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 2000
}

# Delete the service.
Write-Host "Removing service '$ServiceName'..."
sc.exe delete $ServiceName | Out-Null

# Verify deletion.
$remainingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($remainingService) {
    Write-Error "Failed to remove service '$ServiceName'."
    exit 1
}

Write-Host "Service '$ServiceName' uninstalled successfully."
