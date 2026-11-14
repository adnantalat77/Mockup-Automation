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

function Fail-Launch([string]$Message) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $record = "$(Get-Date -Format o) $Message"
  Add-Content -LiteralPath $launcherError -Value $record
  Write-Error $Message
  exit 1
}

function Read-EnvironmentFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
    $values[$Matches[1]] = $value
  }
  return $values
}

try {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  $envPath = if ($EnvironmentFile) { $EnvironmentFile } else { Join-Path $AppRoot '.env' }
  if (!(Test-Path -LiteralPath $envPath -PathType Leaf)) { Fail-Launch "Configuration is missing: $envPath. Copy .env.example to .env and complete the Release 1 checklist." }
  $settings = Read-EnvironmentFile $envPath
  $required = @('SHOPIFY_SHOP_DOMAIN','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_API_VERSION','SHOPIFY_PUBLISHING_ENABLED','SHOPIFY_PUBLISHING_AUTH_TOKEN','SHOPIFY_PUBLISH_PRODUCT_IDS','DATA_DIR','WEB_ORIGIN')
  $missing = @($required | Where-Object { !$settings.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($settings[$_]) })
  if ($missing.Count -gt 0) { Fail-Launch "Release 1 configuration is incomplete. Set: $($missing -join ', ')." }
  if ($settings['SHOPIFY_SHOP_DOMAIN'] -notmatch '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' -or $settings['SHOPIFY_SHOP_DOMAIN'] -eq 'your-store.myshopify.com') { Fail-Launch 'SHOPIFY_SHOP_DOMAIN must be the exact configured *.myshopify.com domain.' }
  if ($settings['SHOPIFY_PUBLISHING_ENABLED'] -ne 'true') { Fail-Launch 'SHOPIFY_PUBLISHING_ENABLED must be explicitly set to true for the Release 1 publishing workstation. The launcher will not enable it automatically.' }
  if ($settings['SHOPIFY_PUBLISHING_AUTH_TOKEN'].Length -lt 32) { Fail-Launch 'SHOPIFY_PUBLISHING_AUTH_TOKEN must contain at least 32 characters.' }
  if ($settings['SHOPIFY_PUBLISH_PRODUCT_IDS'] -notmatch '^gid://shopify/Product/[1-9]\d*(,\s*gid://shopify/Product/[1-9]\d*)*$') { Fail-Launch 'SHOPIFY_PUBLISH_PRODUCT_IDS must contain one or more exact comma-separated Shopify Product GIDs.' }
  if ($settings['WEB_ORIGIN'] -ne $dashboardUrl) { Fail-Launch "WEB_ORIGIN must be $dashboardUrl for the production launcher." }
  $dataDir = $settings['DATA_DIR']
  if (![System.IO.Path]::IsPathRooted($dataDir)) { $dataDir = [System.IO.Path]::GetFullPath((Join-Path $AppRoot $dataDir)) }

  $node = Get-Command $NodeCommand -ErrorAction SilentlyContinue
  if (!$node) { Fail-Launch 'Node.js 20.19 or newer is required. Install the supported Node.js LTS runtime and retry.' }
  $versionText = & $node.Source --version
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { Fail-Launch 'The Node.js runtime version could not be determined.' }
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 19)) { Fail-Launch "Node.js $versionText is unsupported. Install Node.js 20.19 or newer." }

  $serverEntry = Join-Path $AppRoot 'apps\api\dist\server.js'
  $webIndex = Join-Path $AppRoot 'apps\web\dist\index.html'
  if (!(Test-Path -LiteralPath (Join-Path $AppRoot 'node_modules') -PathType Container)) { Fail-Launch 'Runtime dependencies are missing. Run npm install once during installation.' }
  if (!(Test-Path -LiteralPath $serverEntry -PathType Leaf) -or !(Test-Path -LiteralPath $webIndex -PathType Leaf)) { Fail-Launch 'Production build output is missing. Run npm run build once during installation.' }

  $existingHealth = $null
  try { $existingHealth = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 2 } catch { }
  if ($existingHealth) {
    if ($existingHealth.status -ne 'ok' -or $existingHealth.application -ne 'mockup-automation' -or $existingHealth.phase -ne 4) { Fail-Launch 'Port 3001 is occupied by an unexpected service. It was not opened or replaced.' }
    if (!(Test-Path -LiteralPath $statePath -PathType Leaf)) { Fail-Launch 'Mockup Automation is responding, but its local runtime ownership record is missing. Do not start another instance.' }
    $existingState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($existingState.appRoot -ne $AppRoot -or $existingState.dataDir -ne $dataDir) { Fail-Launch 'A Mockup Automation instance is running with a different installation or data directory. It was not reused.' }
    if (!$NoBrowser) { Start-Process $dashboardUrl }
    Write-Output 'Mockup Automation is already running; opened the existing dashboard.'
    exit 0
  }

  foreach ($key in $settings.Keys) { [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process') }
  [Environment]::SetEnvironmentVariable('DATA_DIR', $dataDir, 'Process')
  [Environment]::SetEnvironmentVariable('API_PORT', '3001', 'Process')
  [Environment]::SetEnvironmentVariable('WEB_DIST_DIR', (Join-Path $AppRoot 'apps\web\dist'), 'Process')
  $tokenBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
  $shutdownToken = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
  [Environment]::SetEnvironmentVariable('MOCKUP_SHUTDOWN_TOKEN', $shutdownToken, 'Process')

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $applicationLog = Join-Path $logsDir "application-$stamp.log"
  [Environment]::SetEnvironmentVariable('MOCKUP_LOG_FILE', $applicationLog, 'Process')
  $process = Start-Process -FilePath $node.Source -ArgumentList @("`"$serverEntry`"") -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru
  $stateJson = @{ schemaVersion = 1; pid = $process.Id; port = 3001; appRoot = $AppRoot; dataDir = $dataDir; shutdownToken = $shutdownToken; startedAt = (Get-Date -Format o); log = $applicationLog } | ConvertTo-Json
  [IO.File]::WriteAllText($statePath, $stateJson, (New-Object Text.UTF8Encoding($false)))

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    if ($process.HasExited) { break }
    try { $health = Invoke-RestMethod -Uri "$dashboardUrl/api/health" -TimeoutSec 1; if ($health.status -eq 'ok') { $ready = $true; break } } catch { }
  }
  if (!$ready) {
    if ($process.HasExited) { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }
    Fail-Launch "The application did not become healthy. Review $applicationLog and $launcherError."
  }
  if (!$NoBrowser) { Start-Process $dashboardUrl }
  Write-Output "Mockup Automation started at $dashboardUrl."
} catch {
  Fail-Launch $_.Exception.Message
}
