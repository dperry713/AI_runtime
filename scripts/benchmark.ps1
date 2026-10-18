#requires -Version 7.0
<#
.SYNOPSIS
  Repeats AIR's deterministic benchmark suite and writes a machine-readable report.
.DESCRIPTION
  Measures wall-clock duration per suite run and emits p50/p95 and pass/fail
  status. This is a harness-level benchmark; it does not claim to measure model
  quality or interactive GUI accuracy.
.PARAMETER Iterations
  Number of full suite repetitions (1-20). Default: 3.
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 20)]
  [int]$Iterations = 3
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$logDir = Join-Path (Get-Location) 'var/test-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runStamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssZ')
$runResults = [System.Collections.Generic.List[object]]::new()

function Get-Percentile {
  param([double[]]$Values, [double]$Percentile)
  if ($Values.Count -eq 0) { return 0.0 }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($Percentile * $sorted.Count) - 1
  $index = [Math]::Max(0, [Math]::Min($index, $sorted.Count - 1))
  return [Math]::Round([double]$sorted[$index], 2)
}

for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
  $logPath = Join-Path $logDir "benchmark-$runStamp-$iteration.log"
  Write-Host "==> Benchmark iteration $iteration/$Iterations" -ForegroundColor Cyan
  $watch = [System.Diagnostics.Stopwatch]::StartNew()

  # Do not pipe npm's output through another native process; preserve its exit code.
  & npm run test:benchmark 2>&1 | Tee-Object -FilePath $logPath
  $exitCode = $LASTEXITCODE
  $watch.Stop()

  $runResults.Add([pscustomobject]@{
    iteration = $iteration
    passed = ($exitCode -eq 0)
    exitCode = $exitCode
    durationMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 2)
    log = [System.IO.Path]::GetRelativePath((Get-Location).Path, $logPath)
  })

  if ($exitCode -ne 0) {
    Write-Host "Benchmark iteration $iteration failed (exit $exitCode)." -ForegroundColor Red
  }
}

$durations = [double[]]@($runResults | ForEach-Object { $_.durationMs })
$passedRuns = @($runResults | Where-Object { $_.passed }).Count
$commit = (& git rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0) { $commit = 'unknown' }
$branchName = $env:GITHUB_HEAD_REF
if ([string]::IsNullOrWhiteSpace($branchName)) { $branchName = (& git branch --show-current 2>$null) }
if ([string]::IsNullOrWhiteSpace($branchName)) { $branchName = 'unknown' }

$report = [ordered]@{
  schemaVersion = 1
  suite = 'air-runtime-deterministic-benchmark'
  generatedAtUtc = [DateTime]::UtcNow.ToString('o')
  commit = "$commit".Trim()
  branch = "$branchName".Trim()
  iterations = $Iterations
  passedRuns = $passedRuns
  failedRuns = ($Iterations - $passedRuns)
  passRate = [Math]::Round($passedRuns / $Iterations, 4)
  durationMs = [ordered]@{
    p50 = Get-Percentile -Values $durations -Percentile 0.50
    p95 = Get-Percentile -Values $durations -Percentile 0.95
    min = [Math]::Round(($durations | Measure-Object -Minimum).Minimum, 2)
    max = [Math]::Round(($durations | Measure-Object -Maximum).Maximum, 2)
  }
  runs = @($runResults)
  limitations = @(
    'Wall-clock duration includes Node/Vitest startup and is not pure runtime latency.',
    'Mock-provider task success is deterministic and does not estimate live-model accuracy.',
    'GUI, visual grounding, and hardware-resource benchmarks require a dedicated interactive Windows runner.'
  )
}

$reportPath = Join-Path $logDir 'benchmark-report.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $reportPath
Write-Host "Benchmark report: $reportPath" -ForegroundColor Cyan
Write-Host ("Pass rate: {0:P0}; p50: {1} ms; p95: {2} ms" -f $report.passRate, $report.durationMs.p50, $report.durationMs.p95)

if ($passedRuns -ne $Iterations) { exit 1 }
exit 0
