param(
  [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NodeCommand = 'node',
  [string]$EnvironmentFile,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$dashboardUrl = 'http://127.0.0.1:3001'
$logsDir = Join-Path $AppRoot 'logs'
$statePath = Join-Path $logsDir 'runtime.json'
$launcherError = Join-Path $logsDir 'launcher-error.log'
$launcherMutex = $null
$ownsLauncherMutex = $false

function Fail-Launch([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  Add-Content -LiteralPath $launcherError -Value "$(Get-Date -Format o) $Message"
  Write-Error $Message
  exit 1
}

function Read-EnvironmentFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $key = $Matches[1]; $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
    $values[$key] = $value
  }
  return $values
}

function New-RandomToken {
  $bytes = New-Object byte[] 32; $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Write-RuntimeState($State) {
  $temporary = "$statePath.$([guid]::NewGuid()).tmp"
  [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Read-RuntimeState {
  try { $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json }
  catch { Fail-Launch 'The runtime ownership record is malformed. Preserve it for review and do not start another instance.' }
  if ($state.schemaVersion -ne 2 -or !$state.pid -or !$state.port -or !$state.appRoot -or !$state.dataDir -or !$state.startupId -or !$state.instanceToken -or !$state.shutdownToken) { Fail-Launch 'The runtime ownership record is incomplete. Preserve it for review and do not start another instance.' }
  return $state
}

function Request-Identity($State) {
  return Invoke-RestMethod -Method Post -Uri "$dashboardUrl/api/runtime/identity" -Headers @{ 'X-Local-Instance-Token' = $State.instanceToken } -TimeoutSec 2
}

function Assert-Identity($State, $Identity, [string]$ExpectedAppRoot, [string]$ExpectedDataDir) {
  if ($State.schemaVersion -ne 2 -or $State.appRoot -ine $ExpectedAppRoot -or $State.dataDir -ine $ExpectedDataDir -or $Identity.application -ne 'mockup-automation' -or $Identity.phase -ne 4 -or $Identity.startupId -ne $State.startupId -or $Identity.pid -ne $State.pid -or $Identity.appRoot -ine $ExpectedAppRoot -or $Identity.dataDir -ine $ExpectedDataDir) {
    Fail-Launch 'The responding service does not match the runtime record, installation, process, startup identity, and canonical data directory.'
  }
}

try {
  $AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
  $logsDir = Join-Path $AppRoot 'logs'; $statePath = Join-Path $logsDir 'runtime.json'; $launcherError = Join-Path $logsDir 'launcher-error.log'
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $envPath = if ($EnvironmentFile) { $EnvironmentFile } else { Join-Path $AppRoot '.env' }
  if (!(Test-Path -LiteralPath $envPath -PathType Leaf)) { Fail-Launch "Configuration is missing: $envPath. Copy .env.example to .env and complete the Release 1 checklist." }
  $settings = Read-EnvironmentFile $envPath
  $required = @('SHOPIFY_SHOP_DOMAIN','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_API_VERSION','SHOPIFY_PUBLISHING_ENABLED','DATA_DIR','WEB_ORIGIN')
  $missing = @($required | Where-Object { !$settings.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($settings[$_]) })
  if ($missing.Count -gt 0) { Fail-Launch "Release 1 configuration is incomplete. Set: $($missing -join ', ')." }
  if ($settings['SHOPIFY_SHOP_DOMAIN'] -notmatch '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' -or $settings['SHOPIFY_SHOP_DOMAIN'] -eq 'your-store.myshopify.com') { Fail-Launch 'SHOPIFY_SHOP_DOMAIN must be the exact configured *.myshopify.com domain.' }
  if ($settings['SHOPIFY_PUBLISHING_ENABLED'] -notin @('true','false')) { Fail-Launch 'SHOPIFY_PUBLISHING_ENABLED must be exactly true or false.' }
  if ($settings['SHOPIFY_PUBLISHING_ENABLED'] -eq 'true') {
    if (!$settings.ContainsKey('SHOPIFY_PUBLISHING_AUTH_TOKEN') -or $settings['SHOPIFY_PUBLISHING_AUTH_TOKEN'].Length -lt 32) { Fail-Launch 'Publishing is enabled, so SHOPIFY_PUBLISHING_AUTH_TOKEN must contain at least 32 characters.' }
    if (!$settings.ContainsKey('SHOPIFY_PUBLISH_PRODUCT_IDS') -or $settings['SHOPIFY_PUBLISH_PRODUCT_IDS'] -notmatch '^gid://shopify/Product/[1-9]\d*(,\s*gid://shopify/Product/[1-9]\d*)*$') { Fail-Launch 'Publishing is enabled, so SHOPIFY_PUBLISH_PRODUCT_IDS must contain one or more exact comma-separated Shopify Product GIDs.' }
  }
  if ($settings['WEB_ORIGIN'] -ne $dashboardUrl) { Fail-Launch "WEB_ORIGIN must be $dashboardUrl for the production launcher." }
  $dataDir = $settings['DATA_DIR']; if (![IO.Path]::IsPathRooted($dataDir)) { $dataDir = [IO.Path]::GetFullPath((Join-Path $AppRoot $dataDir)) }
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null; $dataDir = (Resolve-Path -LiteralPath $dataDir).Path

  $node = Get-Command $NodeCommand -ErrorAction SilentlyContinue
  if (!$node) { Fail-Launch 'Node.js 20.19 or newer is required. Install the supported Node.js LTS runtime and retry.' }
  $versionText = & $node.Source --version
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { Fail-Launch 'The Node.js runtime version could not be determined.' }
  if ([int]$Matches[1] -lt 20 -or ([int]$Matches[1] -eq 20 -and [int]$Matches[2] -lt 19)) { Fail-Launch "Node.js $versionText is unsupported. Install Node.js 20.19 or newer." }
  $AppRoot = & $node.Source -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $AppRoot
  $dataDir = & $node.Source -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $dataDir
  $logsDir = Join-Path $AppRoot 'logs'; $statePath = Join-Path $logsDir 'runtime.json'; $launcherError = Join-Path $logsDir 'launcher-error.log'

  $mutexBytes = [Text.Encoding]::UTF8.GetBytes("$($AppRoot.ToLowerInvariant())|$($dataDir.ToLowerInvariant())")
  $sha = [Security.Cryptography.SHA256]::Create(); try { $digest = ([BitConverter]::ToString($sha.ComputeHash($mutexBytes))).Replace('-', '') } finally { $sha.Dispose() }
  $launcherMutex = New-Object Threading.Mutex($false, "Local\MockupAutomationLauncher-$digest")
  try { $ownsLauncherMutex = $launcherMutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $ownsLauncherMutex = $true }
  if (!$ownsLauncherMutex) { Fail-Launch 'Another launcher is still starting or verifying this installation and data directory. Retry after it completes.' }

  $serverEntry = Join-Path $AppRoot 'apps\api\dist\server.js'; $webIndex = Join-Path $AppRoot 'apps\web\dist\index.html'
  if (!(Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules') -PathType Container)) { Fail-Launch 'Runtime dependencies are missing. Run npm install once during installation.' }
  if (!(Test-Path -LiteralPath $serverEntry -PathType Leaf) -or !(Test-Path -LiteralPath $webIndex -PathType Leaf)) { Fail-Launch 'Production build output is missing. Run npm run build once during installation.' }

  $health = $null; try { $health = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 2 } catch { }
  if (!$health) {
    $client = New-Object Net.Sockets.TcpClient
    try {
      $connect = $client.BeginConnect('127.0.0.1', 3001, $null, $null)
      if ($connect.AsyncWaitHandle.WaitOne(500) -and $client.Connected) { Fail-Launch 'Port 3001 is occupied by an unexpected or unresponsive service. It was not trusted, stopped, or replaced.' }
    } finally { $client.Dispose() }
  }
  $hasState = Test-Path -LiteralPath $statePath -PathType Leaf
  if ($health) {
    if (!$hasState) { Fail-Launch 'A service is responding on port 3001, but no runtime ownership record exists. It was not trusted or replaced.' }
    $state = Read-RuntimeState
    if (!(Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { Fail-Launch 'A service is responding, but the recorded process is not alive. The stale record was preserved for review.' }
    try { $identity = Request-Identity $state } catch { Fail-Launch 'The existing service failed the authenticated instance identity challenge. It was not trusted or replaced.' }
    Assert-Identity $state $identity $AppRoot $dataDir
    if (!$NoBrowser) { Start-Process $dashboardUrl }
    Write-Output 'Mockup Automation is already running; authenticated and opened the existing dashboard.'
    exit 0
  }
  if ($hasState) {
    $state = Read-RuntimeState
    if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) { Fail-Launch 'The recorded process is alive but its authenticated identity endpoint is unreachable. Do not start another instance.' }
    Remove-Item -LiteralPath $statePath -Force
  }

  foreach ($key in $settings.Keys) { [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process') }
  [Environment]::SetEnvironmentVariable('DATA_DIR', $dataDir, 'Process'); [Environment]::SetEnvironmentVariable('API_PORT', '3001', 'Process')
  [Environment]::SetEnvironmentVariable('WEB_DIST_DIR', (Join-Path $AppRoot 'apps\web\dist'), 'Process')
  $instanceToken = New-RandomToken; $shutdownToken = New-RandomToken; $startupId = [guid]::NewGuid().ToString()
  [Environment]::SetEnvironmentVariable('MOCKUP_INSTANCE_TOKEN', $instanceToken, 'Process'); [Environment]::SetEnvironmentVariable('MOCKUP_SHUTDOWN_TOKEN', $shutdownToken, 'Process'); [Environment]::SetEnvironmentVariable('MOCKUP_STARTUP_ID', $startupId, 'Process')
  $applicationLog = Join-Path $logsDir "application-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"; [Environment]::SetEnvironmentVariable('MOCKUP_LOG_FILE', $applicationLog, 'Process')
  $process = Start-Process -FilePath $node.Source -ArgumentList @("`"$serverEntry`"") -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru
  $state = @{ schemaVersion = 2; status = 'starting'; pid = $process.Id; port = 3001; appRoot = $AppRoot; dataDir = $dataDir; startupId = $startupId; instanceToken = $instanceToken; shutdownToken = $shutdownToken; startedAt = (Get-Date -Format o); log = $applicationLog }
  Write-RuntimeState $state
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250; if ($process.HasExited) { break }
    try { $identity = Request-Identity $state; Assert-Identity $state $identity $AppRoot $dataDir; $ready = $true; break } catch { }
  }
  if (!$ready) { if ($process.HasExited) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }; Fail-Launch "The application identity did not become ready. Review $applicationLog and $launcherError." }
  $state.status = 'ready'; Write-RuntimeState $state
  if (!$NoBrowser) { Start-Process $dashboardUrl }
  Write-Output "Mockup Automation started at $dashboardUrl."
} catch { Fail-Launch $_.Exception.Message }
finally { if ($ownsLauncherMutex) { try { $launcherMutex.ReleaseMutex() } catch {} }; if ($launcherMutex) { $launcherMutex.Dispose() } }
