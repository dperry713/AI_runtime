#requires -Version 5.1
<#
.SYNOPSIS  First-time setup for AIR: verifies tooling, initializes git, installs dependencies, creates AIR_HOME, runs checks.
.PARAMETER SkipInstall  Skip npm install (use when node_modules is already present).
.PARAMETER SkipCheck    Skip `npm run check` at the end.
#>
[CmdletBinding()]
param([switch]$SkipInstall, [switch]$SkipCheck)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

Step 'Checking Node.js (need >= 22)'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found. Install Node 22 LTS from https://nodejs.org' }
$nodeVersion = (node -v).TrimStart('v')
if ([int]$nodeVersion.Split('.')[0] -lt 22) { throw "Node 22+ required, found v$nodeVersion" }
Write-Host "Node v$nodeVersion OK"

Step 'Checking git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git not found. Install Git for Windows.' }
if (-not (Test-Path '.git')) { git init -b main | Out-Null; Write-Host 'Initialized git repository (branch main)' }

if (-not $SkipInstall) {
    Step 'Installing dependencies'
    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $hasDeps = $null -ne $pkg.PSObject.Properties['dependencies']
    if (-not $hasDeps) {
        $deps = @('zod', 'pino', 'pino-roll', 'ulid', 'better-sqlite3', 'execa', 'commander', 'fast-glob', 'yaml')
        $dev = @('typescript', 'vitest', '@vitest/coverage-v8', 'fast-check', 'eslint', '@eslint/js', 'typescript-eslint',
            '@types/node', '@types/better-sqlite3', 'tsx', 'dependency-cruiser', 'prettier')
        npm install --save @deps
        if ($LASTEXITCODE -ne 0) { throw 'npm install (dependencies) failed' }
        npm install --save-dev @dev
        if ($LASTEXITCODE -ne 0) { throw 'npm install (devDependencies) failed' }
        Write-Host 'Dependencies installed; commit package-lock.json.'
    } else {
        npm install
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
}

Step 'Creating AIR_HOME directories'
$airHome = if ($env:AIR_HOME) { $env:AIR_HOME } else { Join-Path $env:LOCALAPPDATA 'AIR' }
foreach ($d in 'config', 'agents', 'journal\segments', 'memory', 'logs\crash', 'run', 'tmp') {
    New-Item -ItemType Directory -Force -Path (Join-Path $airHome $d) | Out-Null
}
Write-Host "AIR_HOME = $airHome"

Step 'Creating repo scratch dirs (var\)'
foreach ($d in 'logs', 'test-tmp', 'test-logs', 'check-logs') {
    New-Item -ItemType Directory -Force -Path (Join-Path 'var' $d) | Out-Null
}

Step 'Running doctor'
& (Join-Path $PSScriptRoot 'doctor.ps1')

if (-not $SkipCheck) {
    Step 'Running npm run check'
    & (Join-Path $PSScriptRoot 'check.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host 'CHECK FAILED - see output above; record it in BUILD_STATUS.md.' -ForegroundColor Red; exit 1 }
}

Write-Host "`nBootstrap complete. Next: update BUILD_STATUS.md (P0-T06 result) and follow NEXT UP." -ForegroundColor Green
