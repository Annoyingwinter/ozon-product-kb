param(
  [string]$Platform = "ozon",
  [int]$TimeoutMs = 180000,
  [int]$Limit = 3,
  [int]$MonitorLimit = 6,
  [int]$MonitorWaitReplyMs = 15000,
  [int]$MonitorIntervalMs = 180000,
  [int]$MonitorCycles = 9999,
  [switch]$IncludeWatch,
  [switch]$IncludeEnglishOnly,
  [switch]$Headless,
  [switch]$KeepOpen,
  [switch]$SkipSelect,
  [switch]$NoMonitor
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$args = @(
  "scripts/select-and-inquire.js",
  "--platform", "$Platform",
  "--timeout-ms", "$TimeoutMs",
  "--limit", "$Limit",
  "--monitor-limit", "$MonitorLimit",
  "--monitor-wait-reply-ms", "$MonitorWaitReplyMs",
  "--monitor-interval-ms", "$MonitorIntervalMs",
  "--monitor-cycles", "$MonitorCycles"
)

if ($IncludeWatch) {
  $args += "--include-watch"
}
if ($IncludeEnglishOnly) {
  $args += "--include-english-only"
}
if ($Headless) {
  $args += "--headless"
}
if ($KeepOpen) {
  $args += "--keep-open"
}
if ($SkipSelect) {
  $args += "--skip-select"
}
if ($NoMonitor) {
  $args += "--no-monitor"
}

Write-Host "Running selection + supplier inquiry automation..." -ForegroundColor Cyan
& node @args
if ($LASTEXITCODE -ne 0) {
  throw "Selection + inquiry automation failed with exit code $LASTEXITCODE."
}

if (Test-Path (Join-Path $repoRoot "output")) {
  Start-Process explorer.exe (Join-Path $repoRoot "output") | Out-Null
}
