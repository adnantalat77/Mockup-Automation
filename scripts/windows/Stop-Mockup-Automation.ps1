param([string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path $AppRoot 'logs\runtime.json'
if (!(Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Output 'Mockup Automation is not recorded as running.'; exit 0 }
try {
  $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  if (!$state.shutdownToken -or !$state.port -or !$state.pid) { throw 'Runtime state is incomplete; do not force-start another instance.' }
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.port)/api/runtime/shutdown" -Headers @{ 'X-Local-Shutdown-Token' = $state.shutdownToken } -TimeoutSec 5 | Out-Null
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if (!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $statePath -Force; Write-Output 'Mockup Automation stopped gracefully.'; exit 0 }
    Start-Sleep -Milliseconds 250
  }
  throw 'Graceful shutdown did not complete within 15 seconds. The process and data-directory lock were left intact.'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
