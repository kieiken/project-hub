param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-local.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$uri = 'http://127.0.0.1:' + $config.port
$running = $false
try { $state = Invoke-RestMethod ($uri + '/api/state') -TimeoutSec 2; $running = ($null -ne $state.projects -and $state.root -eq $config.root) } catch {}
if (-not $running) {
  $env:HUB_ROOT = $config.root
  $env:HUB_PORT = [string]$config.port
  $stdout = Join-Path $config.root '_hub/server-out.log'
  $stderr = Join-Path $config.root '_hub/server-error.log'
  $child = Start-Process -FilePath $config.node -ArgumentList ('"' + (Join-Path $PSScriptRoot 'server.js') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($child.HasExited) { throw ('啟動失敗，請查看：' + $stderr) }
    try { $state = Invoke-RestMethod ($uri + '/api/state') -TimeoutSec 2; if ($state.root -eq $config.root) { $running = $true; break } } catch {}
  }
  if (-not $running) { throw 'Project Hub 未能在預期時間內啟動。' }
}
if (-not $NoBrowser) { Start-Process $uri }
Write-Output $uri
