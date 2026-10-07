<#
  Fase W — Toma del dataset 'concentrada' (histórico consolidado) de Wincaja + GOLD ventas.

  POR QUÉ EXISTE (bug jul-2026, ver memoria project_wincaja_month_gap_detalles_reload):
  el sync diario (sync-wincaja-actual.ps1) solo carga --dataset actual. En import-wincaja.js
  `detalles_mov_almacen` se RECARGA FULL desde el .mdb 'actual', que es RODANTE: cuando un mes
  sale del .mdb vivo, la recarga BORRA su detalle (el maestro, incremental, lo conserva → el
  JOIN de v_sales_lines da 0 filas para ese mes). Resultado: hueco de un MES en un almacén
  (MD-30 perdió julio, ~$15M, sub-pedido en /compras). El .mdb 'concentrada' (Z:\...\Concentradas)
  SÍ acumula el histórico; hay que IMPORTARLO periódicamente para respaldar cada mes ANTES de que
  ruede del 'actual'. Este script hace justo eso, semanal.

  Scope: branches wincaja_only ACTIVAS 30/32/50 (las que surten /compras/pedido). Branch 10 (PH)
  es Kepler-fed desde julio → su concentrada es histórico estable, no corre riesgo continuo.

  Pasos:
    1. BRONZE : import-wincaja.js --branch {30,32,50} --domain ventas --dataset concentrada
    2. GOLD   : import-wincaja-analytics.js  (analytics.sales_daily + REFRESH MV)
  El reorden (inventory-health → computed-reorder → replenishment-plan) lo recomputa el nightly.

  Destino (prod Railway) = DATABASE_URL_NEW, resuelto igual que sync-wincaja-actual.ps1:
    a) env DATABASE_URL_NEW, b) WINCAJA_SYNC_DB_URL, c) archivo local sync.local.env (gitignored).
  Corre ON-PREM (necesita Z: + PowerShell 32-bit Jet 4.0). Log con timestamp en .\logs\.
#>
$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\database\importers\wincaja
$dbDir  = (Resolve-Path (Join-Path $here '..\..')).Path         # ...\database
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
$log    = Join-Path $logDir "sync_concentrada_$stamp.log"

function Log($msg) { $line = "$(Get-Date -Format o)  $msg"; Write-Host $line; Add-Content -Path $log -Value $line }

# --- Resolver DATABASE_URL_NEW (destino prod) — mismo mecanismo que el sync 'actual' ---
$envFile = Join-Path $here 'sync.local.env'
if (-not $env:DATABASE_URL_NEW -and (Test-Path $envFile)) {
  Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
  }
}
if (-not $env:DATABASE_URL_NEW -and $env:WINCAJA_SYNC_DB_URL) { $env:DATABASE_URL_NEW = $env:WINCAJA_SYNC_DB_URL }
if (-not $env:DATABASE_URL_NEW) { throw "Falta DATABASE_URL_NEW (seteala, o WINCAJA_SYNC_DB_URL, o crea $envFile)" }

function Run-Node($label, [string[]]$nodeArgs) {
  Log "=== $label : node $($nodeArgs -join ' ')"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & node @nodeArgs 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_ | Out-String).TrimEnd() }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "$label fallo (exit $code)" }
  Log "--- $label OK"
}

Log "########## SYNC WINCAJA concentrada (respaldo del mes que rueda) ##########"
Push-Location $dbDir
try { & node importers/lib/cron-heartbeat.js begin wincaja_concentrada "Wincaja concentrada (respaldo mensual)" 2>&1 | Out-Null } catch {}
try {
  foreach ($br in @('30', '32', '50')) {
    Run-Node "BRONZE concentrada $br" @('importers/wincaja/import-wincaja.js', '--branch', $br, '--domain', 'ventas', '--dataset', 'concentrada', '--apply')
  }
  Run-Node 'GOLD sales+MV' @('importers/wincaja/import-wincaja-analytics.js', '--apply')
  Log "########## DONE OK ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_concentrada ok 2>&1 | Out-Null } catch {}
} catch {
  Log "########## FALLO: $($_.Exception.Message) ##########"
  try { & node importers/lib/cron-heartbeat.js end wincaja_concentrada error "$($_.Exception.Message)" 2>&1 | Out-Null } catch {}
  Pop-Location
  exit 1
}
Pop-Location
exit 0
