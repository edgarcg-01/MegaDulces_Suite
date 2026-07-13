<#
  Fase W — Toma automatica del dataset 'actual' (vivo) de Wincaja + feeds gold.

  Corre ON-PREM (esta maquina: tiene Z: -> \\192.168.0.245\D y PowerShell 32-bit
  con Jet 4.0). NO puede correr en Railway: el cron de NestJS no alcanza los .mdb
  de la LAN. Lo agenda una Tarea Programada de Windows (ver README abajo).

  Pasos:
    1. BRONZE  : import-wincaja.js --dataset actual  (extrae Access -> wincaja.*)
    2. GOLD    : import-wincaja-analytics.js          (analytics.sales_daily + REFRESH MV)
    3. GOLD    : import-wincaja-stock.js              (commercial.stock)

  Destino (prod Railway) = DATABASE_URL_NEW. Se toma de, en orden:
    a) variable de entorno DATABASE_URL_NEW ya seteada,
    b) WINCAJA_SYNC_DB_URL,
    c) archivo local (gitignored) sync.local.env  ->  DATABASE_URL_NEW=postgresql://...

  El importer/feeds cargan .env con dotenv SIN override, asi que la env var seteada
  aca gana. Log con timestamp en .\logs\. Exit != 0 si algo falla (Task Scheduler lo marca).
#>
$ErrorActionPreference = 'Stop'

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\database\importers\wincaja
$dbDir = (Resolve-Path (Join-Path $here '..\..')).Path         # ...\database
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$log   = Join-Path $logDir "sync_actual_$stamp.log"

function Log($msg) { $line = "$(Get-Date -Format o)  $msg"; Write-Host $line; Add-Content -Path $log -Value $line }

# --- Resolver DATABASE_URL_NEW (destino prod) ---
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
  # ErrorActionPreference=Continue alrededor del exe nativo: en PS 5.1, stderr con
  # 2>&1 se envuelve en ErrorRecord y tumbaria el script aunque node salga 0.
  # El exit real lo da $LASTEXITCODE.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & node @nodeArgs 2>&1 | ForEach-Object { Add-Content -Path $log -Value ($_ | Out-String).TrimEnd() }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "$label fallo (exit $code)" }
  Log "--- $label OK"
}

Log "########## SYNC WINCAJA actual  ->  destino configurado ##########"
Push-Location $dbDir
try {
  Run-Node 'BRONZE actual' @('importers/wincaja/import-wincaja.js', '--branch', 'all', '--domain', 'all', '--dataset', 'actual', '--apply')
  Run-Node 'GOLD sales+MV' @('importers/wincaja/import-wincaja-analytics.js', '--apply')
  Run-Node 'GOLD stock'    @('importers/wincaja/import-wincaja-stock.js', '--apply')
  Log "########## DONE OK ##########"
} catch {
  Log "########## FALLO: $($_.Exception.Message) ##########"
  Pop-Location
  exit 1
}
Pop-Location
exit 0
