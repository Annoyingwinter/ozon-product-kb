$ErrorActionPreference = "Stop"

param(
  [int]$TimeoutMs = 180000,
  [switch]$KeepOpen
)

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$args = @(
  "scripts/alphashop-agent.js",
  "--platform", "ozon",
  "--timeout-ms", "$TimeoutMs"
)

if ($KeepOpen) {
  $args += "--keep-open"
}

Write-Host "Running Ozon pipeline..." -ForegroundColor Cyan
& node @args
if ($LASTEXITCODE -ne 0) {
  throw "Pipeline run failed with exit code $LASTEXITCODE."
}

$latestAnalysis = Get-ChildItem -Path (Join-Path $repoRoot "output") -Filter "*.analysis.json" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$latestReport = Get-ChildItem -Path (Join-Path $repoRoot "output") -Filter "*.report.md" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

Write-Host ""
Write-Host "Latest outputs:" -ForegroundColor Green
if ($latestAnalysis) {
  Write-Host "Analysis: $($latestAnalysis.FullName)"
}
if ($latestReport) {
  Write-Host "Report:   $($latestReport.FullName)"
}

if (Test-Path (Join-Path $repoRoot "output")) {
  Start-Process explorer.exe (Join-Path $repoRoot "output") | Out-Null
}
