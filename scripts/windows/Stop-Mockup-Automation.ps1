param([string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)

$ErrorActionPreference = 'Stop'
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
$statePath = Join-Path $AppRoot 'logs\runtime.json'
if (!(Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Output 'Mockup Automation is not recorded as running.'; exit 0 }
try {
  try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } catch { throw 'Runtime state is malformed; it cannot authorize shutdown.' }
  if ($state.schemaVersion -ne 2 -or !$state.instanceToken -or !$state.shutdownToken -or !$state.startupId -or !$state.port -or !$state.pid -or !$state.appRoot -or !$state.dataDir) { throw 'Runtime state is incomplete; do not force-start or stop another instance.' }
  if ($state.appRoot -ine $AppRoot) { throw 'Runtime state belongs to a different installation.' }
  if (!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { throw 'The recorded process is not alive. Preserve the stale runtime record for startup reconciliation.' }
  try { $identity = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.port)/api/runtime/identity" -Headers @{ 'X-Local-Instance-Token' = $state.instanceToken } -TimeoutSec 3 }
  catch { throw 'The running service failed the authenticated identity challenge; shutdown was not attempted.' }
  if ($identity.application -ne 'mockup-automation' -or $identity.phase -ne 4 -or $identity.startupId -ne $state.startupId -or $identity.pid -ne $state.pid -or $identity.appRoot -ine $state.appRoot -or $identity.dataDir -ine $state.dataDir) { throw 'The responding process does not match the runtime ownership record; shutdown was not attempted.' }
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($state.port)/api/runtime/shutdown" -Headers @{ 'X-Local-Shutdown-Token' = $state.shutdownToken } -TimeoutSec 5
  if ($response.status -ne 'shutting_down' -or $response.startupId -ne $state.startupId) { throw 'The intended instance did not acknowledge shutdown.' }
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if (!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) {
      $latest = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
      if ($latest.startupId -eq $state.startupId) { Remove-Item -LiteralPath $statePath -Force }
      Write-Output 'Mockup Automation stopped gracefully.'; exit 0
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Graceful shutdown did not complete within 15 seconds. The process, runtime record, and data-directory lock were left intact.'
} catch { Write-Error $_.Exception.Message; exit 1 }
