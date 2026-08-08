<#
  Proyecto Tienda (TDA) - AGENTE de tickets en vivo POR TIENDA (Opcion A).
  Corre EN CADA servidor POS (a30/a32/a50...), 100% PowerShell (SIN node). Lee el .mdb
  VIVO LOCAL read-only e incremental (solo tickets nuevos por Consecutivo) y empuja el
  delta al ingest de prod -> WS /store -> /tienda/live. Latencia ~sub-minuto.

  DEBE correr en 32-bit (Jet 4.0):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File wincaja-store-agent.ps1 `
        -Mdb "D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb" -WarehouseCode "MD-30" -WarehouseName "Morelia Abastos"

  SEGURIDAD (produccion POS): abre SIEMPRE Mode=Read (solo lectura). El POS tiene el .mdb
  abierto en modo compartido (Access es multiusuario) -> una lectura read-only se une a la
  sesion compartida, NO bloquea la caja. NUNCA exclusivo, NUNCA escribe.

  Corre como SYSTEM (archivo LOCAL, no necesita drive mapeado), loop continuo. Se agenda
  al inicio (ver install-store-agent-task.cmd). IngestUrl/Key por -param o env var.

  NOTA: archivo ASCII puro a proposito (PS 5.1 32-bit sin BOM lee acentos/guiones como ANSI
  y rompe el parseo). No agregar caracteres no-ASCII.
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$WarehouseCode,
  [string]$WarehouseName = '',
  [string]$IngestUrl = $env:STORE_INGEST_URL,
  [string]$IngestKey = $env:STORE_INGEST_KEY,
  [string]$StateFile = '',
  [int]$LookbackDays = 1,
  [int]$IntervalSeconds = 45,
  [switch]$Dry,     # extrae + arma, NO postea (1 ciclo)
  [switch]$Once     # 1 ciclo real y sale (para Task Scheduler c/1min)
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # HTTPS a Railway en PS 5.1
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
    # Cabeceras de venta desde la ventana de fecha (barata); el corte fino por Consecutivo va abajo.
    $qH = "SELECT Consecutivo, Fecha, Hora, Cajero, Cancelado FROM MaestroMovAlmacen WHERE Tipo='V' AND Fecha >= $jd"
    $cmd = $conn.CreateCommand(); $cmd.CommandText = $qH
    $r = $cmd.ExecuteReader()
    $heads = @{}          # consecutivo(str) -> @{ ts; cajero; cons }
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

    # Lineas de esas ventas (JOIN acota a Tipo='V' del rango; agrupamos por Consecutivo en PS).
    $qD = "SELECT d.Consecutivo, d.Articulo, d.CantidadRegular, d.ValorVenta FROM DetallesMovAlmacen AS d INNER JOIN MaestroMovAlmacen AS m ON d.Consecutivo = m.Consecutivo WHERE m.Tipo='V' AND m.Fecha >= $jd"
    $cmd2 = $conn.CreateCommand(); $cmd2.CommandText = $qD
    $r2 = $cmd2.ExecuteReader()
    $lines = @{}
    while ($r2.Read()) {
      $cons = [string]$r2['Consecutivo']
      if (-not $heads.ContainsKey($cons)) { continue }   # solo tickets nuevos
      if (-not $lines.ContainsKey($cons)) { $lines[$cons] = New-Object System.Collections.ArrayList }
      [void]$lines[$cons].Add([pscustomobject]@{
        sku     = [string]$r2['Articulo']
        nombre  = ''
        cant    = [double]($(if ($r2['CantidadRegular'] -is [System.DBNull]) { 0 } else { $r2['CantidadRegular'] }))
        importe = [double]($(if ($r2['ValorVenta'] -is [System.DBNull]) { 0 } else { $r2['ValorVenta'] }))
      })
    }
    $r2.Close()

    $tickets = New-Object System.Collections.ArrayList
    foreach ($cons in $heads.Keys) {
      $items = if ($lines.ContainsKey($cons)) { @($lines[$cons]) } else { @() }
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
    }
    return @{ tickets = @($tickets | Sort-Object { intval $_.folio }); maxCons = $maxCons }
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

# --- main ---
if (-not $Dry) {
  if (-not $IngestUrl) { throw 'Falta STORE_INGEST_URL (-IngestUrl o env).' }
  if (-not $IngestKey) { throw 'Falta STORE_INGEST_KEY (-IngestKey o env).' }
}
$mode = if ($Dry) { 'DRY' } elseif ($Once) { 'ONCE' } else { "loop ${IntervalSeconds}s" }
# En --once (Task Scheduler c/N seg) NO imprimir header cada ciclo → log limpio (solo cuando hay tickets).
if (-not $Once) { Write-Host ("=== wincaja-store-agent {0} ({1}) - {2} ===" -f $WarehouseCode, $Mdb, $mode) }

if ($Dry -or $Once) { [void](Invoke-Cycle); return }
while ($true) {
  try { [void](Invoke-Cycle) } catch { Write-Host ("  ERR: {0}" -f $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSeconds
}
