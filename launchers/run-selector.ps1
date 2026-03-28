param(
  [int]$Keywords = 8,
  [int]$Limit = 12,
  [switch]$Api
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$border = "=" * 50
Write-Host ""
Write-Host $border -ForegroundColor Cyan
Write-Host "  1688 -> Ozon 智能选品" -ForegroundColor White
Write-Host $border -ForegroundColor Cyan

if ($Api) {
  Write-Host "`n  模式: API (纯后台, 无浏览器)" -ForegroundColor Green
  $nodeArgs = @("scripts/select-1688-for-ozon.js", "--api", "--max-keywords", "$Keywords", "--limit", "$Limit")
} else {
  Write-Host "`n  模式: 浏览器采集" -ForegroundColor Yellow
  Write-Host "  提示: 遇到验证码时会弹窗提醒, 拖动滑块即可" -ForegroundColor DarkGray
  $nodeArgs = @("scripts/select-1688-for-ozon.js", "--max-keywords", "$Keywords", "--limit", "$Limit")
}

Write-Host "  关键词数: $Keywords  |  最大产品数: $Limit" -ForegroundColor DarkGray
Write-Host $border -ForegroundColor Cyan
Write-Host ""

& node @nodeArgs

if ($LASTEXITCODE -ne 0) {
  Write-Host "`n[!] 选品流程异常退出 (code $LASTEXITCODE)" -ForegroundColor Red

  # 完成通知 (失败)
  $notify = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("选品流程异常退出，请检查日志。", "选品助手", "OK", "Warning") | Out-Null'
  Start-Process powershell -ArgumentList "-NoProfile", "-Command", $notify -WindowStyle Hidden
  exit $LASTEXITCODE
}

# 统计结果
$latest = Get-ChildItem output/1688-ozon-selector-*.analysis.json -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  $data = Get-Content $latest.FullName -Raw | ConvertFrom-Json
  $count = ($data.products | Measure-Object).Count
  Write-Host ""
  Write-Host $border -ForegroundColor Green
  Write-Host "  选品完成!" -ForegroundColor Green
  Write-Host "  找到 $count 个候选产品" -ForegroundColor White
  Write-Host "  结果: $($latest.FullName)" -ForegroundColor DarkGray
  Write-Host $border -ForegroundColor Green

  # 完成通知 (成功)
  $msg = "选品完成! 找到 $count 个候选产品。"
  $notify = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$msg', '选品助手', 'OK', 'Information') | Out-Null"
  Start-Process powershell -ArgumentList "-NoProfile", "-Command", $notify -WindowStyle Hidden
} else {
  Write-Host "`n[完成] 未找到结果文件，请检查output/目录" -ForegroundColor Yellow
}
