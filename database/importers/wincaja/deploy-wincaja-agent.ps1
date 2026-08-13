#Requires -RunAsAdministrator
<#
  TDA — DEPLOY TODO-EN-UNO del agente de tickets en vivo Wincaja (Opcion A).
  Corre UNA vez, como ADMIN, EN EL SERVIDOR POS de la tienda. Hace todo:
    1. Crea C:\WincajaAgent\
    2. Escribe el agente (wincaja-store-agent.ps1, embebido aca)
    3. Escribe el wrapper store-agent.cmd con tu config + KEY
    4. PRUEBA (--once): lee el .mdb vivo local y empuja a prod -> muestra inserted
    5. Registra la tarea (SYSTEM, arranca al boot, loop ~45s) y la ARRANCA

  Uso (PowerShell como Administrador):
    .\deploy-wincaja-agent.ps1 -Store 30 -IngestKey "PEGAR_LA_KEY_DE_PROD"
    .\deploy-wincaja-agent.ps1 -Store 32 -IngestKey "..."
    .\deploy-wincaja-agent.ps1 -Store 50 -IngestKey "..."
  Override si el nombre del .mdb difiere:  -Mdb "D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb"

  Copialo a cada servidor POS (por VNC) y corrélo con la KEY. Nada mas.
  Seguridad: el agente abre el .mdb Mode=Read (no bloquea la caja); corre como SYSTEM
  (archivo local). La KEY queda en C:\WincajaAgent\store-agent.cmd (fuera del repo).
#>
param(
  [Parameter(Mandatory = $true)][string]$Store,          # 30 | 32 | 50 (o codigo libre)
  [Parameter(Mandatory = $true)][string]$IngestKey,
  [string]$Mdb = '',
  [string]$WarehouseCode = '',
  [string]$WarehouseName = '',
  [string]$IngestUrl = 'https://megadulces.up.railway.app/api/store/live/ingest',
  [int]$Seconds = 45,
  [string]$Dir = 'C:\WincajaAgent'
)

$ErrorActionPreference = 'Stop'

# Defaults por tienda (verificado 2026-08). Override con -Mdb / -WarehouseCode / -WarehouseName.
$map = @{
  '30' = @{ wc = 'MD-30'; wn = 'Morelia Abastos'; mdb = 'D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb' }
  '32' = @{ wc = 'MD-32'; wn = 'Morelia Madero';  mdb = 'D:\Datos\WinCaja\32 MORELIA MADERO.mdb' }
  '50' = @{ wc = 'MD-50'; wn = 'Canindo';         mdb = 'D:\Datos\WinCaja\50 CANINDO.mdb' }
}
if ($map.ContainsKey($Store)) {
  if (-not $Mdb) { $Mdb = $map[$Store].mdb }
  if (-not $WarehouseCode) { $WarehouseCode = $map[$Store].wc }
  if (-not $WarehouseName) { $WarehouseName = $map[$Store].wn }
}
if (-not $Mdb -or -not $WarehouseCode) { throw "Tienda '$Store' desconocida: pasa -Mdb, -WarehouseCode, -WarehouseName." }

$PS32 = 'C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $PS32)) { throw "No existe PowerShell 32-bit en $PS32 (necesario para Jet 4.0)." }
if (-not (Test-Path -LiteralPath $Mdb)) { throw "No existe el .mdb: $Mdb (verifica la ruta del POS)." }

Write-Host "== Deploy agente Wincaja: $WarehouseCode ($Store) ==" -ForegroundColor Cyan
Write-Host "   .mdb : $Mdb"
Write-Host "   dir  : $Dir"

# --- 1. Carpeta ---
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# --- 2. Agente embebido (ASCII puro; PS 5.1 32-bit sin BOM rompe con no-ASCII) ---
$agent = @'
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$WarehouseCode,
  [string]$WarehouseName = '',
  [string]$IngestUrl = $env:STORE_INGEST_URL,
  [string]$IngestKey = $env:STORE_INGEST_KEY,
  [string]$StateFile = '',
  [int]$LookbackDays = 1,
  [int]$IntervalSeconds = 45,
  [switch]$Dry,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $StateFile) { $StateFile = Join-Path $PSScriptRoot ('.wincaja-agent-' + $WarehouseCode + '.json') }
function Read-Watermark {
  if (Test-Path $StateFile) { try { return (Get-Content $StateFile -Raw | ConvertFrom-Json) } catch { } }
  return $null
}
function Write-Watermark($cons) { @{ consecutivo = $cons } | ConvertTo-Json | Set-Content $StateFile -Encoding UTF8 }
function intval($v) { $s = ($v -replace '\D',''); if ($s) { return [int64]$s } else { return 0 } }
function Get-NewTickets {
  $wm = Read-Watermark
  $sinceCons = if ($wm) { [int64]$wm.consecutivo } else { 0 }
  $since = (Get-Date).AddDays(-1 * $LookbackDays)
  $jd = "#{0}/{1}/{2}#" -f $since.Month, $since.Day, $since.Year
  $cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
  $conn = New-Object System.Data.OleDb.OleDbConnection $cs
  $conn.Open()
  try {
    $qH = "SELECT Consecutivo, Fecha, Hora, Cajero, Cancelado FROM MaestroMovAlmacen WHERE Tipo='V' AND Fecha >= $jd"
    $cmd = $conn.CreateCommand(); $cmd.CommandText = $qH
    $r = $cmd.ExecuteReader()
    $heads = @{}
    $maxCons = $sinceCons
    while ($r.Read()) {
      if (-not ($r['Cancelado'] -is [System.DBNull]) -and ($r['Cancelado'] -eq $true)) { continue }
      $cons = [string]$r['Consecutivo']
      $ci = intval $cons
      if ($ci -le $sinceCons) { continue }
      if ($ci -gt $maxCons) { $maxCons = $ci }
      $d = $r['Fecha'];  $dstr = if ($d -is [datetime]) { $d.ToString('yyyy-MM-dd') } else { ([datetime]$d).ToString('yyyy-MM-dd') }
      $h = $r['Hora'];   $tstr = if ($h -is [datetime]) { $h.ToString('HH:mm:ss') } else { '00:00:00' }
      $caj = if ($r['Cajero'] -is [System.DBNull]) { $null } else { [string]$r['Cajero'] }
      $heads[$cons] = @{ ts = "$dstr`T$tstr-06:00"; cajero = $caj; cons = $cons }
    }
    $r.Close()
    if ($heads.Count -eq 0) { return @{ tickets = @(); maxCons = $maxCons } }
    $qD = "SELECT d.Consecutivo, d.Articulo, d.CantidadRegular, d.ValorVenta, a.Nombre AS Nombre FROM ((DetallesMovAlmacen AS d INNER JOIN MaestroMovAlmacen AS m ON d.Consecutivo = m.Consecutivo) LEFT JOIN Articulos AS a ON d.Articulo = a.Articulo) WHERE m.Tipo='V' AND m.Fecha >= $jd"
    $cmd2 = $conn.CreateCommand(); $cmd2.CommandText = $qD
    $r2 = $cmd2.ExecuteReader()
    $lines = @{}
    while ($r2.Read()) {
      $cons = [string]$r2['Consecutivo']
      if (-not $heads.ContainsKey($cons)) { continue }
      if (-not $lines.ContainsKey($cons)) { $lines[$cons] = New-Object System.Collections.ArrayList }
      [void]$lines[$cons].Add([pscustomobject]@{
        sku     = [string]$r2['Articulo']
        nombre  = if ($r2['Nombre'] -is [System.DBNull]) { '' } else { [string]$r2['Nombre'] }
        cant    = [double]($(if ($r2['CantidadRegular'] -is [System.DBNull]) { 0 } else { $r2['CantidadRegular'] }))
        importe = [double]($(if ($r2['ValorVenta'] -is [System.DBNull]) { 0 } else { $r2['ValorVenta'] }))
      })
    }
    $r2.Close()
    # Anti-carrera (.mdb vivo): NO empujar tickets con 0 lineas y NO avanzar el watermark por
    # debajo del folio EN CURSO mas viejo (0 items y fresco < GRACE) -> se re-lee hasta que
    # tenga lineas y el merge del ingest lo sana. 0-items VIEJO = huerfano real: se ignora.
    $GRACE_MIN = 5
    $now = Get-Date
    $graceCut = $now.AddMinutes(-1 * $GRACE_MIN)
    $tickets = New-Object System.Collections.ArrayList
    $firstInProgress = $null
    foreach ($cons in $heads.Keys) {
      $items = if ($lines.ContainsKey($cons)) { @($lines[$cons]) } else { @() }
      if ($items.Count -gt 0) {
        $total = ($items | Measure-Object -Property importe -Sum).Sum
        [void]$tickets.Add([pscustomobject]@{
          warehouse_code = $WarehouseCode
          warehouse_name = $WarehouseName
          serie          = 'WC'
          folio          = $cons
          ticket_ts      = $heads[$cons].ts
          total          = [double]$total
          forma_pago     = $null
          cajero         = $heads[$cons].cajero
          items          = $items
        })
      } else {
        $tdt = try { [datetime]::Parse($heads[$cons].ts) } catch { $now }
        if ($tdt -ge $graceCut) {
          $ci = intval $cons
          if ($null -eq $firstInProgress -or $ci -lt $firstInProgress) { $firstInProgress = $ci }
        }
      }
    }
    $safeMax = if ($null -ne $firstInProgress) { [int64]($firstInProgress - 1) } else { $maxCons }
    if ($safeMax -lt $sinceCons) { $safeMax = $sinceCons }
    return @{ tickets = @($tickets | Sort-Object { intval $_.folio }); maxCons = $safeMax }
  } finally { $conn.Close() }
}
function Push-Tickets($tickets) {
  if (-not $tickets -or $tickets.Count -eq 0) { return 0 }
  $body = @{ tickets = $tickets; emit = $true } | ConvertTo-Json -Depth 6 -Compress
  $resp = Invoke-RestMethod -Method Post -Uri $IngestUrl -ContentType 'application/json' `
            -Headers @{ 'x-store-ingest-key' = $IngestKey } -Body $body -TimeoutSec 30
  return $resp.inserted
}
function Invoke-Cycle {
  $res = Get-NewTickets
  $tk = $res.tickets
  if (-not $tk -or $tk.Count -eq 0) { return 0 }
  if ($Dry) {
    Write-Host ("  [DRY] {0}: {1} nuevos (ej. folio {2} ts {3} total {4})" -f $WarehouseCode, $tk.Count, $tk[0].folio, $tk[0].ticket_ts, [math]::Round($tk[0].total))
  } else {
    $ins = Push-Tickets $tk
    Write-Watermark $res.maxCons
    Write-Host ("[{0}] {1}: +{2} -> ingest (inserted {3})" -f (Get-Date -Format 'HH:mm:ss'), $WarehouseCode, $tk.Count, $ins)
  }
  return $tk.Count
}
if (-not $Dry) {
  if (-not $IngestUrl) { throw 'Falta STORE_INGEST_URL (-IngestUrl o env).' }
  if (-not $IngestKey) { throw 'Falta STORE_INGEST_KEY (-IngestKey o env).' }
}
if (-not $Once) { Write-Host ("=== wincaja-store-agent {0} ({1}) ===" -f $WarehouseCode, $Mdb) }
if ($Dry -or $Once) { [void](Invoke-Cycle); return }
while ($true) {
  try { [void](Invoke-Cycle) } catch { Write-Host ("  ERR: {0}" -f $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSeconds
}
'@
$agentPath = Join-Path $Dir 'wincaja-store-agent.ps1'
[System.IO.File]::WriteAllText($agentPath, $agent, [System.Text.Encoding]::ASCII)
Write-Host "   [ok] agente -> $agentPath"

# --- 3. Wrapper .cmd (loop ~Ns, restart-on-crash) con config + KEY ---
$cmd = @"
@echo off
setlocal
set "PS32=$PS32"
set "AGENT=%~dp0wincaja-store-agent.ps1"
set "STORE_INGEST_URL=$IngestUrl"
set "STORE_INGEST_KEY=$IngestKey"
set "LOG=%~dp0store-agent.log"
:loop
"%PS32%" -NoProfile -ExecutionPolicy Bypass -File "%AGENT%" -Mdb "$Mdb" -WarehouseCode "$WarehouseCode" -WarehouseName "$WarehouseName" -Once >> "%LOG%" 2>&1
timeout /t $Seconds /nobreak >nul
goto loop
"@
$cmdPath = Join-Path $Dir 'store-agent.cmd'
[System.IO.File]::WriteAllText($cmdPath, $cmd, [System.Text.Encoding]::ASCII)
Write-Host "   [ok] wrapper -> $cmdPath"

# --- 4. Prueba end-to-end (--once real: lee mdb + empuja a prod) ---
Write-Host "== Prueba --once (lee .mdb vivo + empuja a prod) ==" -ForegroundColor Cyan
$env:STORE_INGEST_URL = $IngestUrl
$env:STORE_INGEST_KEY = $IngestKey
& $PS32 -NoProfile -ExecutionPolicy Bypass -File $agentPath -Mdb $Mdb -WarehouseCode $WarehouseCode -WarehouseName $WarehouseName -LookbackDays 1 -Once
Write-Host "   (si dice 'inserted N', el camino a prod funciona)"

# --- 5. Tarea programada (SYSTEM, arranca al boot, loop del .cmd) ---
$task = 'Tienda\WincajaAgent'
schtasks /Create /F /TN $task /TR "`"$cmdPath`"" /SC ONSTART /RU SYSTEM /RL HIGHEST | Out-Null
Write-Host "   [ok] tarea '$task' creada (SYSTEM, ONSTART)"
schtasks /Run /TN $task | Out-Null
Write-Host "   [ok] tarea arrancada"

Write-Host ""
Write-Host "LISTO. Verifica:" -ForegroundColor Green
Write-Host "   log:  type `"$Dir\store-agent.log`""
Write-Host "   /tienda/live (usuario admin) debe mostrar $WarehouseCode en ~$Seconds seg."
Write-Host "   quitar: schtasks /Delete /TN `"$task`" /F"
