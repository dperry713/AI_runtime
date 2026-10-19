#requires -Version 7.0
<#
.SYNOPSIS
  Repeats AIR's deterministic benchmark suite and writes a machine-readable report.
.DESCRIPTION
  Records suite pass rate, wall-clock p50/p95, and sampled Node child-process
  memory/CPU observations. Resource figures are approximate sampled measurements,
  not a substitute for Windows Performance Recorder or per-action telemetry.
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

$npmCommand = Get-Command npm.cmd -ErrorAction Stop
for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
  $logPath = Join-Path $logDir "benchmark-$runStamp-$iteration.log"
  $stdoutPath = "$logPath.stdout.tmp"
  $stderrPath = "$logPath.stderr.tmp"
  $baselineNodeIds = @((Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id))
  $cpuByPid = @{}
  $peakWorkingSetBytes = [int64]0
  $peakNodeProcessCount = 0

  Write-Host "==> Benchmark iteration $iteration/$Iterations" -ForegroundColor Cyan
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $npmCommand.Source -ArgumentList @('run', 'test:benchmark') -NoNewWindow -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

  while (-not $process.HasExited) {
    $nodes = @(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $baselineNodeIds })
    $peakNodeProcessCount = [Math]::Max($peakNodeProcessCount, $nodes.Count)
    $workingSet = [int64]0
    foreach ($nodeProcess in $nodes) {
      $workingSet += [int64]$nodeProcess.WorkingSet64
      if ($null -ne $nodeProcess.CPU) {
        $cpuByPid[[string]$nodeProcess.Id] = [double]$nodeProcess.CPU
      }
    }
    $peakWorkingSetBytes = [Math]::Max($peakWorkingSetBytes, $workingSet)
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }

  $process.WaitForExit()
  $watch.Stop()
  $exitCode = $process.ExitCode
  $stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { '' }
  $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { '' }
  @($stdout, $stderr) -join [Environment]::NewLine | Set-Content -Encoding utf8 $logPath
  Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

  $cpuSeconds = [double](($cpuByPid.Values | Measure-Object -Sum).Sum)
  if ([double]::IsNaN($cpuSeconds)) { $cpuSeconds = 0.0 }
  $runResults.Add([pscustomobject]@{
    iteration = $iteration
    passed = ($exitCode -eq 0)
    exitCode = $exitCode
    durationMs = [Math]::Round($watch.Elapsed.TotalMilliseconds, 2)
    sampledNodeCpuMs = [Math]::Round($cpuSeconds * 1000, 2)
    peakSampledNodeWorkingSetBytes = $peakWorkingSetBytes
    peakSampledNodeProcessCount = $peakNodeProcessCount
    log = [System.IO.Path]::GetRelativePath((Get-Location).Path, $logPath)
  })

  if ($exitCode -ne 0) {
    Write-Host "Benchmark iteration $iteration failed (exit $exitCode)." -ForegroundColor Red
    Write-Host "See $logPath" -ForegroundColor Yellow
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
  resources = [ordered]@{
    peakSampledNodeWorkingSetBytes = [Math]::Max(0, [int64](($runResults | Measure-Object peakSampledNodeWorkingSetBytes -Maximum).Maximum))
    peakSampledNodeProcessCount = [Math]::Max(0, [int](($runResults | Measure-Object peakSampledNodeProcessCount -Maximum).Maximum))
    sampledNodeCpuMsAcrossRuns = [Math]::Round([double](($runResults | Measure-Object sampledNodeCpuMs -Sum).Sum), 2)
  }
  runs = @($runResults)
  limitations = @(
    'Wall-clock duration includes npm, Node, and Vitest startup; it is not pure model or action latency.',
    'Resource measurements sample new Node processes every 100 ms and may miss short-lived processes or non-Node/native allocations.',
    'Mock-provider task success is deterministic and does not estimate live-model accuracy.',
    'GUI, visual grounding, and multi-monitor benchmarks require a dedicated interactive Windows runner.'
  )
}

$reportPath = Join-Path $logDir 'benchmark-report.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $reportPath
Write-Host "Benchmark report: $reportPath" -ForegroundColor Cyan
Write-Host ("Pass rate: {0:P0}; p50: {1} ms; p95: {2} ms; sampled peak Node memory: {3:N1} MiB" -f $report.passRate, $report.durationMs.p50, $report.durationMs.p95, ($report.resources.peakSampledNodeWorkingSetBytes / 1MB))

if ($passedRuns -ne $Iterations) { exit 1 }
exit 0
