#requires -Version 5.1
<#
.SYNOPSIS  Runs a test suite kind and captures output to var\test-logs\.
.PARAMETER Kind  unit | integration | e2e | chaos | security | perf | eval | coverage | all
#>
[CmdletBinding()]
param([ValidateSet('unit', 'integration', 'e2e', 'chaos', 'security', 'perf', 'eval', 'coverage', 'all')][string]$Kind = 'all')

$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$logDir = Join-Path 'var' 'test-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$kinds = if ($Kind -eq 'all') { @('unit', 'integration', 'e2e', 'security', 'chaos') } else { @($Kind) }
$failed = $false
foreach ($k in $kinds) {
    $log = Join-Path $logDir "$k-$stamp.log"
    Write-Host "==> npm run test:$k" -ForegroundColor Cyan
    npm run "test:$k" 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { $failed = $true; Write-Host "FAILED: $k (log: $log)" -ForegroundColor Red }
}
if ($failed) { exit 1 }
Write-Host 'ALL REQUESTED SUITES PASSED' -ForegroundColor Green
