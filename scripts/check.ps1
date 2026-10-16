#requires -Version 5.1
<#
.SYNOPSIS  Runs `npm run check` and tees output to var\check-logs\check-<timestamp>.log
#>
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$logDir = Join-Path 'var' 'check-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("check-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

npm run check 2>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE
if ($code -eq 0) { Write-Host "CHECK PASSED (log: $log)" -ForegroundColor Green }
else { Write-Host "CHECK FAILED exit=$code (log: $log)" -ForegroundColor Red }
exit $code
