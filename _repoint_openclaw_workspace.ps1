param(
  [string]$Workspace = 'C:\Users\More\.openclaw\.openclaw\workspace',
  [string]$Backup = 'C:\Users\More\.openclaw\.openclaw\workspace-openclaw-backup',
  [string]$Target = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
)

$ErrorActionPreference = 'Stop'

if (Test-Path -LiteralPath $Backup) {
  Remove-Item -LiteralPath $Backup -Recurse -Force
}

if (Test-Path -LiteralPath $Workspace) {
  Rename-Item -LiteralPath $Workspace -NewName 'workspace-openclaw-backup'
}

New-Item -ItemType Junction -Path $Workspace -Target $Target | Out-Null

Write-Host "Workspace re-pointed to $Target"
