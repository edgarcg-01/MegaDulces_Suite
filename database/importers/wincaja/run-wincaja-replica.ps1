<#
  Fase WR.4 — RÉPLICA CRUDA continua de las bases Wincaja (Access 97 -> Postgres local :5433).
  Corre ON-PREM (misma maquina que run-wincaja-live.ps1: tiene Z: + PowerShell 32-bit con Jet + el
  contenedor pgvector-md en :5433 donde viven kepler_md_XX). NO empuja a Railway: escribe LOCAL.

  Patron per-tick (leccion feeds on-prem: preferir --once por tick + IgnoreNew + timeout, NO proceso
  largo que se cuelga). Task Scheduler lo repite cada ~5 min. Idempotente: watermark en ods.wincaja_watermark.

  Config (env, opcional). Se toma env ya seteada -> sync.local.env (gitignored):
    WINCAJA_REPLICA_URL   = postgresql://postgres:<pass>@localhost:5433/wincaja   (default en config)
    WINCAJA_MDB_BASE      = carpeta de los .mdb. Default Z:/Salidas/Bases/Actuales.
    WINCAJA_REPLICA_ONLY  = (opcional) --only=<tablas> para acotar.

  powershell -ExecutionPolicy Bypass -File run-wincaja-replica.ps1
#>
$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dbDir = (Resolve-Path (Join-Path $here '..\..')).Path
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log   = Join-Path $logDir "wincaja_replica_$stamp.log"
function Log($m) { $l = "$(Get-Date -Format o)  $m"; Write-Host $l; Add-Content -Path $log -Value $l }

$envFile = Join-Path $here 'sync.local.env'
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    if (-not (Get-Item "env:$($k.Trim())" -ErrorAction SilentlyContinue)) { Set-Item -Path "env:$($k.Trim())" -Value $v.Trim() }
  }
}
$env:NODE_PATH = (Join-Path (Resolve-Path (Join-Path $dbDir '..')).Path 'node_modules')

$extra = @()
if ($env:WINCAJA_REPLICA_ONLY) { $extra += "--only=$($env:WINCAJA_REPLICA_ONLY)" }

Log "########## WINCAJA REPLICA (cruda -> :5433/wincaja) ##########"
Push-Location $dbDir
try { & node importers/lib/cron-heartbeat.js begin wincaja_replica "Wincaja replica cruda (Access->Postgres)" 2>&1 | Out-Null } catch {}
try {
  $args = @('importers/wincaja/replicate-wincaja-live.js', '--once') + $extra
  Log "=== node $($args -join ' ')"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & node @args 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_ | Out-String).TrimEnd() }
  $code = $LASTEXITCODE; $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "replicate-wincaja-live fallo (exit $code)" }
  Log "########## DONE OK ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_replica ok 2>&1 | Out-Null } catch {}
} catch {
  Log "########## FALLO: $($_.Exception.Message) ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_replica error "$($_.Exception.Message)" 2>&1 | Out-Null } catch {}
  Pop-Location; exit 1
}
Pop-Location
exit 0

<#
  -- Agendar (una vez, como admin en la maquina de feeds) ---------------------------
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\wincaja\run-wincaja-replica.ps1"'
  $trg = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  $pri = New-ScheduledTaskPrincipal -UserId 'SISTEMAS\Desarrollo MD' -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName 'WincajaReplicaLoop' -Action $act -Trigger $trg -Settings $set -Principal $pri -Force
#>
