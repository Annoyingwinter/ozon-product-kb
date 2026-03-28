param(
  [switch]$SkipRefresh,
  [int]$TimeoutMs = 60000
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipRefresh) {
  Write-Host "`n[1/2] Refreshing 1688 session (visible browser, pass captcha if needed)..." -ForegroundColor Cyan
  Write-Host "      Will auto-close after verification. Timeout: $($TimeoutMs/1000)s" -ForegroundColor DarkGray
  & node scripts/refresh-1688-session.js --timeout-ms $TimeoutMs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Session refresh failed. You can retry or use -SkipRefresh." -ForegroundColor Yellow
  } else {
    Write-Host "[OK] Session refreshed successfully." -ForegroundColor Green
  }
  Start-Sleep -Seconds 2
}

Write-Host "`n[2/2] Running headless product selection..." -ForegroundColor Cyan
& node scripts/select-1688-for-ozon.js --headless
if ($LASTEXITCODE -ne 0) {
  Write-Host "[!] Selection failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host "`n[Done] Check output/ for results." -ForegroundColor Green
