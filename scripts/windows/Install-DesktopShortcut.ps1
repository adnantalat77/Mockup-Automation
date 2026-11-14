param([string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $AppRoot 'Start-Mockup-Automation.cmd'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher not found at $launcher" }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Mockup Automation.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $AppRoot
$shortcut.Description = 'Start Equipd Wear Mockup Automation'
$shortcut.Save()
Write-Output "Desktop shortcut created: $shortcutPath"
