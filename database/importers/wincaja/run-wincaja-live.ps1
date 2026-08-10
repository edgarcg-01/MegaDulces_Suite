<#
  Fase SYNC — corrida LIVE de Wincaja (existencia + ventas) → feeds-ingest (path gratis).
  Hermana ligera de sync-wincaja-actual.ps1, pero de ALTA FRECUENCIA (cada N min):
  solo empuja los DELTAS al servicio feeds-ingest en Railway (ingress gratis), sin tocar
  el pipeline pesado diario.

  Corre ON-PREM (.249: tiene Z: y PowerShell 32-bit con Jet). La agenda una Tarea
  Programada de Windows (ver README abajo). Idempotente: cada extractor lleva su watermark.

  Config (env). Se toma, en orden: env var ya seteada → sync.local.env (gitignored):
    DATABASE_URL_NEW   = prod (los extractores lo usan solo para leer catálogo; el WRITE va por http)
    FEEDS_INGEST_URL   = https://feeds-ingest-production.up.railway.app
    FEEDS_INGEST_KEY   = <secreto> (match FEEDS_INGEST_KEY del servicio)
    WINCAJA_MDB_BASE   = (opcional) carpeta de los .mdb. Default Z:/Salidas/Bases/Actuales.

  powershell -ExecutionPolicy Bypass -File run-wincaja-live.ps1
#>
$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path       # ...\database\importers\wincaja
$dbDir = (Resolve-Path (Join-Path $here '..\..')).Path          # ...\database
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log   = Join-Path $logDir "wincaja_live_$stamp.log"
function Log($m) { $l = "$(Get-Date -Format o)  $m"; Write-Host $l; Add-Content -Path $log -Value $l }

# --- Cargar sync.local.env (gitignored) para las vars que falten ---
$envFile = Join-Path $here 'sync.local.env'
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    if (-not (Get-Item "env:$($k.Trim())" -ErrorAction SilentlyContinue)) { Set-Item -Path "env:$($k.Trim())" -Value $v.Trim() }
  }
}
$env:FEEDS_SINK = 'http'   # este runner SIEMPRE empuja por el path gratis
if (-not $env:FEEDS_INGEST_URL) { throw "Falta FEEDS_INGEST_URL (seteala o ponela en $envFile)" }
if (-not $env:FEEDS_INGEST_KEY) { throw "Falta FEEDS_INGEST_KEY (seteala o ponela en $envFile)" }

function Run-Node($label, [string[]]$nodeArgs) {
  Log "=== $label : node $($nodeArgs -join ' ')"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & node @nodeArgs 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_ | Out-String).TrimEnd() }
  $code = $LASTEXITCODE; $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "$label falló (exit $code)" }
  Log "--- $label OK"
}

Log "########## WINCAJA LIVE (existencia + ventas) → feeds-ingest ##########"
Push-Location $dbDir
try { & node importers/lib/cron-heartbeat.js begin wincaja_live "Wincaja live (existencia+ventas)" 2>&1 | Out-Null } catch {}
try {
  Run-Node 'EXISTENCIA' @('importers/wincaja/wincaja-stock-extract.js', '--once')
  Run-Node 'VENTAS'     @('importers/wincaja/wincaja-sales-extract.js', '--once')   # tipos V → sales_daily
  # MOVIMIENTOS: mismos extractor+handler, tipos no-V → stock_movements (watermark propio '-mov').
  # Corre DESPUÉS de VENTAS para que el bronce V ya esté al re-derivar stock_movements.
  $env:WINCAJA_SALES_TIPOS = 'C,E,S,D,I,P,M'; $env:WINCAJA_STATE_SUFFIX = 'mov'
  Run-Node 'MOVIMIENTOS' @('importers/wincaja/wincaja-sales-extract.js', '--once')
  Remove-Item Env:WINCAJA_SALES_TIPOS, Env:WINCAJA_STATE_SUFFIX -ErrorAction SilentlyContinue
  Log "########## DONE OK ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_live ok 2>&1 | Out-Null } catch {}
} catch {
  Log "########## FALLO: $($_.Exception.Message) ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_live error "$($_.Exception.Message)" 2>&1 | Out-Null } catch {}
  Pop-Location; exit 1
}
Pop-Location
exit 0

<#
  ── Agendar (una vez, como admin en .249) ─────────────────────────────────────
  1) Agregá a sync.local.env (gitignored, junto a este archivo):
       FEEDS_INGEST_URL=https://feeds-ingest-production.up.railway.app
       FEEDS_INGEST_KEY=<el secreto del servicio>
     (DATABASE_URL_NEW ya debería estar ahí = prod.)

  2) Registrá la tarea (cada 10 min):
     $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
       -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\Sistemas\CascadeProjects\Trade_marketing\database\importers\wincaja\run-wincaja-live.ps1"'
     $trg = New-ScheduledTaskTrigger -Once -At (Get-Date) `
       -RepetitionInterval (New-TimeSpan -Minutes 10)
     $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
       -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
     $pri = New-ScheduledTaskPrincipal -UserId 'SISTEMAS\Desarrollo MD' -LogonType Interactive -RunLevel Highest
     Register-ScheduledTask -TaskName 'WincajaLive' -Action $act -Trigger $trg -Settings $set -Principal $pri -Force
#>
