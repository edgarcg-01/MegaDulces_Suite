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

  -Carril: inc (movimientos, frescura alta ~3min) | hash (catalogos, cada ~1h) | all (default).
  powershell -ExecutionPolicy Bypass -File run-wincaja-replica.ps1 -Carril inc
#>
param([ValidateSet('all','inc','hash')][string]$Carril = 'all')
$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dbDir = (Resolve-Path (Join-Path $here '..\..')).Path
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$hb    = if ($Carril -eq 'all') { 'wincaja_replica' } else { "wincaja_replica_$Carril" }
$log   = Join-Path $logDir "${hb}_$stamp.log"
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
if ($Carril -ne 'all') { $extra += "--carril=$Carril" }

Log "########## WINCAJA REPLICA (cruda -> :5433/wincaja) carril=$Carril ##########"
Push-Location $dbDir
try { & node importers/lib/cron-heartbeat.js begin $hb "Wincaja replica cruda ($Carril)" 2>&1 | Out-Null } catch {}
try {
  $nodeArgs = @('importers/wincaja/replicate-wincaja-live.js', '--once') + $extra
  Log "=== node $($nodeArgs -join ' ')"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & node @nodeArgs 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_ | Out-String).TrimEnd() }
  $code = $LASTEXITCODE; $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "replicate-wincaja-live fallo (exit $code)" }
  Log "########## DONE OK ##########"
  try { & node importers/lib/cron-heartbeat.js end $hb ok 2>&1 | Out-Null } catch {}
} catch {
  Log "########## FALLO: $($_.Exception.Message) ##########"
  try { & node importers/lib/cron-heartbeat.js end $hb error "$($_.Exception.Message)" 2>&1 | Out-Null } catch {}
  Pop-Location; exit 1
}
Pop-Location
exit 0

<#
  -- Agendar (WR.5.1: split de carriles, como admin en la maquina de feeds) ---------
  $F = 'C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\wincaja\run-wincaja-replica.ps1'
  $pri = New-ScheduledTaskPrincipal -UserId 'SISTEMAS\Desarrollo MD' -LogonType Interactive -RunLevel Highest
  # MOVIMIENTOS (ventas, incremental) cada 3 min -> frescura ~3 min
  $aMov = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$F`" -Carril inc"
  $tMov = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 3)
  $sMov = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName 'WincajaReplicaMov' -Action $aMov -Trigger $tMov -Settings $sMov -Principal $pri -Force
  # CATALOGOS (hash-delta, caro) cada 60 min
  $aCat = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$F`" -Carril hash"
  $tCat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 60)
  $sCat = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName 'WincajaReplicaCat' -Action $aCat -Trigger $tCat -Settings $sCat -Principal $pri -Force
#>
