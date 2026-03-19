param(
  [int]$Port = 18790
)

$paths = @(
  "C:\Users\More\.openclaw\openclaw.json",
  "C:\Users\More\.clawdbot\clawdbot.json"
)

$token = $null
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    continue
  }
  try {
    $cfg = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $candidate = [string]$cfg.gateway.auth.token
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $token = $candidate.Trim()
      break
    }
  } catch {
    continue
  }
}

if ([string]::IsNullOrWhiteSpace($token)) {
  throw "gateway token not found"
}

$url = "http://127.0.0.1:{0}/#token={1}" -f $Port, [System.Uri]::EscapeDataString($token)
Start-Process $url | Out-Null
Write-Host "Opened OpenClaw dashboard."
