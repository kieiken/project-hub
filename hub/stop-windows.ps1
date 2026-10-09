$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-local.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$uri = 'http://127.0.0.1:' + $config.port
try { $state = Invoke-RestMethod ($uri + '/api/state') -TimeoutSec 3; $ping = Invoke-RestMethod ($uri + '/api/ping') -TimeoutSec 3 } catch { Write-Output 'Project Hub is not running.'; exit 0 }
if ($state.root -ne $config.root) { throw 'Port belongs to a different workspace.' }
if (@($state.chatting).Count -gt 0 -or @($state.sessions | Where-Object { $_.running }).Count -gt 0) { throw 'Stop the running AI tasks in Project Hub first.' }
$serverProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$ping.pid)
$expectedServer = Join-Path $PSScriptRoot 'server.js'
if (-not $serverProcess -or $serverProcess.Name -ne 'node.exe' -or -not $serverProcess.CommandLine.Contains($expectedServer)) { throw 'Server identity check failed.' }
Stop-Process -Id ([int]$ping.pid)
Write-Output 'Project Hub stopped.'
