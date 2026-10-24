#requires -RunAsAdministrator
# ============================================================================
# sign-air.ps1 — Authenticode code signing for AIR binaries (Phase W5).
#
# Signs AIR binaries with Authenticode for Windows SmartScreen compatibility.
# Requires a code signing certificate (.pfx file).
#
# Usage:
#   .\scripts\sign-air.ps1 -CertPath <path> -CertPassword <password>
#   .\scripts\sign-air.ps1 -CertPath <path> -CertPassword <password> -TimestampServer http://timestamp.digicert.com
# ============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CertPath,

    [Parameter(Mandatory = $true)]
    [string]$CertPassword,

    [Parameter(Mandatory = $false)]
    [string]$TimestampServer = 'http://timestamp.digicert.com',

    [Parameter(Mandatory = $false)]
    [string]$Description = 'AIR Runtime Daemon',

    [Parameter(Mandatory = $false)]
    [string]$DescriptionUrl = 'https://github.com/dperry713/AI_runtime',

    [Parameter(Mandatory = $false)]
    [switch]$VerboseSign
)

$ErrorActionPreference = 'Stop'

# Files to sign
$filesToSign = @(
    Join-Path $PSScriptRoot '..\dist\service\main.js',
    Join-Path $PSScriptRoot '..\dist\shell\main.js',
    Join-Path $PSScriptRoot '..\native\air-sandbox\target\release\air-sandbox.exe',
)

# Filter to existing files
$existingFiles = @()
foreach ($file in $filesToSign) {
    if (Test-Path $file) {
        $existingFiles += $file
    } else {
        Write-Warning "File not found, skipping: $file"
    }
}

if ($existingFiles.Count -eq 0) {
    Write-Error "No files found to sign. Build the project first."
    exit 1
}

Write-Host "Signing $($existingFiles.Count) file(s) with Authenticode..."
Write-Host "  Certificate: $CertPath"
Write-Host "  Timestamp server: $TimestampServer"

# Sign each file
foreach ($file in $existingFiles) {
    Write-Host "Signing: $file"
    
    $signArgs = @(
        '/a',                           # Append signature
        '/fd', 'SHA256',                # File digest algorithm
        '/td', 'SHA256',                # Timestamp digest algorithm
        '/tr', $TimestampServer,        # Timestamp server
        '/d', $Description,             # Description
        '/du', $DescriptionUrl,         # Description URL
        '/f', $CertPath,                # Certificate file
        '/p', $CertPassword,            # Certificate password
        $file                           # File to sign
    )

    $signResult = & signtool.exe @signArgs 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to sign $file: $signResult"
        exit 1
    }
    
    if ($VerboseSign) {
        Write-Host $signResult
    } else {
        Write-Host "  Signed successfully"
    }
}

Write-Host ""
Write-Host "All files signed successfully."
Write-Host ""
Write-Host "To verify signatures:"
Write-Host "  signtool.exe /v /pa <file>"
