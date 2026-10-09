param([string]$Workspace = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'ProjectHub-Workspace'), [switch]$SkipNpm, [switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
$hubDir = $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if ([int]((& $nodePath -p 'parseInt(process.versions.node)') | Select-Object -Last 1) -lt 22) { throw '需要 Node.js 22 以上版本。' }
Get-Command git.exe -ErrorAction Stop | Out-Null
$Workspace = [IO.Path]::GetFullPath($Workspace)
foreach ($sub in @('_hub','Product','Work')) { New-Item -ItemType Directory -Force -Path (Join-Path $Workspace $sub) | Out-Null }
$rolesFile = Join-Path $Workspace '_hub/roles.yaml'
if (-not (Test-Path -LiteralPath $rolesFile)) {
  $rolesText = [IO.File]::ReadAllText((Join-Path $hubDir '../docs/project-hub/templates/_hub/roles.yaml'))
  $rolesText = $rolesText.Replace('claude --dangerously-skip-permissions', 'claude').Replace('codex --dangerously-bypass-approvals-and-sandbox', 'codex --sandbox workspace-write')
  [IO.File]::WriteAllText($rolesFile, $rolesText, [Text.UTF8Encoding]::new($false))
}
# Keep an empty workspace. The UI creates projects without importing unrelated personal folders.
if (-not $SkipNpm) {
  Push-Location $hubDir
  try { & npm.cmd ci --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw '套件安裝失敗。' } }
  finally { Pop-Location }
}
$configuration = @{ root = $Workspace; node = $nodePath; port = 4545 } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $hubDir 'windows-local.json'), $configuration, [Text.UTF8Encoding]::new($false))
if (-not $NoShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'Project Hub.lnk'))
  $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')
  $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $hubDir 'start-windows.ps1') + '"'
  $shortcut.WorkingDirectory = $hubDir
  $shortcut.Description = 'Project Hub 繁體中文專案中心'
  $shortcut.Save()
}
Write-Output ('已安裝。資料位置：' + $Workspace)
