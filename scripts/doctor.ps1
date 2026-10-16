#requires -Version 5.1
<#
.SYNOPSIS  Environment diagnostics for AIR development on Windows. Exit code 1 if any FAIL.
#>
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$script:fail = 0

function Report($level, $name, $detail) {
    $color = switch ($level) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ("[{0}] {1}: {2}" -f $level, $name, $detail) -ForegroundColor $color
    if ($level -eq 'FAIL') { $script:fail++ }
}

Report 'PASS' 'PowerShell' $PSVersionTable.PSVersion.ToString()

if (Get-Command node -ErrorAction SilentlyContinue) {
    $v = (node -v).TrimStart('v')
    if ([int]$v.Split('.')[0] -ge 22) { Report 'PASS' 'Node.js' "v$v" } else { Report 'FAIL' 'Node.js' "v$v (need >= 22)" }
} else { Report 'FAIL' 'Node.js' 'not found' }

if (Get-Command npm -ErrorAction SilentlyContinue) { Report 'PASS' 'npm' (npm -v) } else { Report 'FAIL' 'npm' 'not found' }
if (Get-Command git -ErrorAction SilentlyContinue) { Report 'PASS' 'git' ((git --version) -replace 'git version ', '') } else { Report 'FAIL' 'git' 'not found' }
if (Get-Command cargo -ErrorAction SilentlyContinue) { Report 'PASS' 'Rust (cargo)' ((cargo --version)) } else { Report 'WARN' 'Rust (cargo)' 'not found - required from P7-T02 (sandbox helper)' }

if ($repo -match 'OneDrive') { Report 'WARN' 'Repo location' "under OneDrive ($repo). Exclude node_modules/var from sync or move to C:\dev\AI_runtime (ADR-0003)" } else { Report 'PASS' 'Repo location' $repo }

$airHome = if ($env:AIR_HOME) { $env:AIR_HOME } else { Join-Path $env:LOCALAPPDATA 'AIR' }
if ($airHome -match 'OneDrive') { Report 'FAIL' 'AIR_HOME' "under OneDrive ($airHome) - SQLite/journal corruption risk" }
else {
    try {
        New-Item -ItemType Directory -Force -Path $airHome | Out-Null
        $probe = Join-Path $airHome '.write-probe'
        Set-Content -Path $probe -Value 'ok'; Remove-Item $probe -Force
        Report 'PASS' 'AIR_HOME writable' $airHome
    } catch { Report 'FAIL' 'AIR_HOME writable' $_.Exception.Message }
}

try {
    $lp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled
    if ($lp -eq 1) { Report 'PASS' 'Long paths' 'enabled' } else { Report 'WARN' 'Long paths' 'disabled (set LongPathsEnabled=1)' }
} catch { Report 'WARN' 'Long paths' 'could not read registry' }

try {
    $drive = (Get-Item $repo).PSDrive
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGb -ge 5) { Report 'PASS' 'Free disk' "$freeGb GB" } else { Report 'WARN' 'Free disk' "$freeGb GB (< 5 GB)" }
} catch { Report 'WARN' 'Free disk' 'could not determine' }

$ep = Get-ExecutionPolicy
if ($ep -in 'Restricted', 'AllSigned') { Report 'WARN' 'Execution policy' "$ep (scripts may be blocked; use Set-ExecutionPolicy -Scope CurrentUser RemoteSigned)" } else { Report 'PASS' 'Execution policy' "$ep" }

if (Test-Path (Join-Path $repo 'node_modules')) {
    Push-Location $repo
    node -e "require('better-sqlite3')(':memory:').close()" 2>$null
    if ($LASTEXITCODE -eq 0) { Report 'PASS' 'better-sqlite3' 'native module loads' } else { Report 'FAIL' 'better-sqlite3' 'failed to load (rebuild: npm rebuild better-sqlite3)' }
    Pop-Location
} else { Report 'WARN' 'node_modules' 'not installed yet (run scripts\bootstrap.ps1)' }

if ($script:fail -gt 0) { Write-Host "`n$($script:fail) check(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "`nDoctor finished: no failures." -ForegroundColor Green
