<#
  WR.8.1 -- AGENTE ODS: corre EN el servidor POS y mantiene fresco `wincaja_ods` desde el .mdb VIVO.

  Es el hermano del agente de tickets (`wincaja-store-agent.ps1`, que alimenta /tienda/live y sigue
  igual): este NO alimenta una pantalla, alimenta la BASE. Dos carriles, como el ODS de Kepler:

    CARRIL INCREMENTAL  (movimientos append-only)  ->  WHERE [col] > watermark, cada ciclo (~1 min)
    CARRIL SNAPSHOT     (catalogos mutables)       ->  tabla completa, a cadencia por tamano

  Por que el snapshot no necesita hash-delta en la caja: el handler `raw-upsert` hace UPSERT SIN
  CHURN (ON CONFLICT ... WHERE IS DISTINCT FROM) -> lo que no cambio no se reescribe. Verificado:
  segundo push identico de Existencias (14,873 filas / 248 KB gzip) devolvio rowCount=0. En el ODS de
  Kepler el hash existe para no pagar egress desde la sucursal; aca la direccion (ingress) es gratis.
  Asi la caja solo lee y manda: cero trabajo por fila en PowerShell.

  ESTADO local en `.wincaja-ods-<Branch>.json`: watermark por tabla + ultimo snapshot por tabla.
  El .mdb es read-only, por eso el estado vive en disco local (igual que el agente de tickets).

  LIMITES HONESTOS (los mismos del ODS, no se disimulan):
   - Los DELETE y las ediciones de filas VIEJAS no se propagan: Access no tiene log de cambios y el
     watermark no vuelve atras. Lo tapa la ventana de reconciliacion (-ReconcileDays, WR.8.4).
   - `MovimientoClientes` / `MovimientoProveedores` quedan FUERA: no tienen PK natural y su `Saldo`
     MUTA -> con `_row_hash` por llave, un cambio insertaria una fila nueva en vez de actualizar.
     Necesitan que se identifique su llave real antes de entrar (pendiente WR.8.3).

  DEBE correr en 32-bit (Jet 4.0; ACE rechaza Access 97 -- ADR-031). Como SYSTEM, archivo LOCAL:
  no necesita drive mapeado, que es justamente el problema del carril por SMB.
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File wincaja-ods-agent.ps1 `
        -Mdb "D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb" -Branch 30 -Once

  Archivo ASCII puro a proposito (PS 5.1 32-bit sin BOM lee acentos como ANSI y rompe el parseo).
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Branch,             # 30 / 32 / 00
  [string]$IngestUrl = $env:FEEDS_INGEST_URL,
  [string]$IngestKey = $env:FEEDS_INGEST_KEY,
  [string]$TenantId = $(if ($env:CRON_TENANT_ID) { $env:CRON_TENANT_ID } else { '00000000-0000-0000-0000-00000000d01c' }),
  [string]$StateFile = '',
  [string]$Only = '',                                        # lista de tablas, para pruebas
  [int]$IntervalSeconds = 60,
  [int]$ReconcileDays = 0,                                   # >0: reempuja el watermark N dias atras
  [switch]$Prime,                                            # primera carga: ignora watermarks
  [switch]$Dry,
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wincaja-ods-lib.ps1')
if (-not $StateFile) { $StateFile = Join-Path $PSScriptRoot ".wincaja-ods-$Branch.json" }

# --- Plan de tablas -----------------------------------------------------------------------------
# `pk` verificado 2026-09-01 contra la replica cruda (indices reales descubiertos por Jet), NO de
# memoria. Donde dice `_row_hash` es porque el origen NO tiene llave natural.
# `every` = minutos entre snapshots (solo carril snapshot). Escalonado por TAMANO, no por tipo:
# Existencias son 15.5k filas y es lo que mira la app; Precios son 90k y cambian en tandas.
#
# `chunk` = ancho MAXIMO de la ventana de watermark por ciclo. Acota el trabajo que el agente le
# pide a una caja de PRODUCCION: sin tope, la primera corrida de DetallesMovAlmacen (152k filas)
# se llevo mas de 10 minutos. La ventana respeta el limite de la llave (no corta un ticket a la
# mitad, que es lo que pasaria capando por numero de filas: un Consecutivo tiene N renglones).
# La carga INICIAL no va por aca -- se prima con el camino rapido (mdbtools+COPY / la replica) y el
# agente arranca desde ese watermark. Este carril es para el delta del dia.
$PLAN = @(
  # --- carril incremental (append-only, watermark) ---
  @{ t = 'MaestroMovAlmacen';  wm = 'Consecutivo'; pk = 'Consecutivo'; chunk = 5000 }
    # DetallesMovAlmacen: sin PK natural. (Consecutivo,Articulo) deja 0.04-0.15% de renglones
    # repetidos y son venta MIXTA del mismo SKU -- una linea en caja (UnidadVenta=1) y otra en pieza
    # (UnidadVenta=0). Ni sumando TipoPrecio cierra -> prefijo legible + hash de desempate.
  @{ t = 'DetallesMovAlmacen'; wm = 'Consecutivo'; pk = 'Consecutivo,Articulo,UnidadVenta,_row_hash'; chunk = 2000 }
  @{ t = 'PagosDia';           wm = 'Consecutivo'; pk = 'Consecutivo,_row_hash'; chunk = 5000 }
  @{ t = 'Arqueos';            wm = 'Consecutivo'; pk = 'Consecutivo'; chunk = 5000 }
  @{ t = 'Cortes';             wm = 'Folio';       pk = 'Folio,caja'; chunk = 5000 }   # ojo: 'caja' minuscula
  @{ t = 'Retiros';            wm = 'Folio';       pk = 'Folio,Caja'; chunk = 5000 }   # ojo: 'Caja' mayuscula
  # --- carril snapshot (catalogos mutables) ---
  @{ t = 'Existencias';        every = 15;   pk = 'Almacen,Articulo' }
  @{ t = 'Articulos';          every = 60;   pk = 'Articulo' }
  @{ t = 'Clientes';           every = 60;   pk = 'Cliente' }
  @{ t = 'Ofertas';            every = 720;  pk = 'Consecutivo' }
  @{ t = 'Precios';            every = 720;  pk = 'Articulo,NoPrecio' }
)

$onlySet = $null
if ($Only) { $onlySet = @{}; foreach ($x in ($Only -split ',')) { $onlySet[$x.Trim().ToLower()] = $true } }

function Read-State {
  if (Test-Path $StateFile) {
    try {
      $j = Get-Content $StateFile -Raw | ConvertFrom-Json
      $h = @{}
      foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = $p.Value }
      return $h
    } catch { }
  }
  return @{}
}
function Write-State($state) {
  ($state | ConvertTo-Json -Depth 4) | Set-Content $StateFile -Encoding UTF8
}

function Invoke-Cycle {
  $state = Read-State
  $conn = Open-Mdb $Mdb
  $now = Get-Date
  $touched = 0; $sentRows = 0; $changedRows = 0; $failed = 0
  try {
    foreach ($spec in $PLAN) {
      $table = $spec.t
      if ($onlySet -and -not $onlySet[$table.ToLower()]) { continue }
      $isInc = [bool]$spec.wm

      # Carril snapshot: respeta su cadencia.
      if (-not $isInc) {
        $lastKey = "snap:$table"
        $last = $state[$lastKey]
        if ($last -and -not $Prime) {
          $mins = ($now - [datetime]::Parse($last)).TotalMinutes
          if ($mins -lt [double]$spec.every) { continue }
        }
      }

      $where = ''
      $wm = $null
      $winTop = $null
      if ($isInc -and -not $Prime) {
        $wm = $state["wm:$table"]
        if ($ReconcileDays -gt 0) { $wm = $null }   # ventana de reconciliacion: reempuja desde cero
        # Sin watermark (primera vez, o despues de un reinicio del contador) se arranca en 0 PERO
        # con ventana: si no, la primera pasada es la tabla entera. Pisarlo trajo 80,415 filas de
        # PagosDia en un solo POST de 2.8 MB -- justo lo que el `chunk` existe para evitar en una
        # caja de produccion. Con ventana, alcanza el techo en varios ciclos baratos.
        if ($null -eq $wm -and $spec.chunk) { $wm = 0 }
        if ($null -ne $wm) {
          $where = "[$($spec.wm)] > $wm"
          if ($spec.chunk) { $winTop = [double]$wm + [double]$spec.chunk; $where += " AND [$($spec.wm)] <= $winTop" }
        }
      }

      try {
        $r = Push-AccessTable -Conn $conn -Table $table -Branch $Branch -Pk $spec.pk -Where $where `
              -WatermarkCol $(if ($isInc) { $spec.wm } else { '' }) `
              -IngestUrl $IngestUrl -IngestKey $IngestKey -TenantId $TenantId -Dry:$Dry
        $sentRows += $r.rows; $changedRows += $r.changed
        if ($r.rows -gt 0 -or -not $isInc) { $touched++ }
        if ($r.rows -gt 0) {
          Write-Host ("  {0,-20} {1,-9} filas={2,7} cambiaron={3,7} {4,7} KB" -f `
            $table, $(if ($isInc) { 'inc' } else { 'snapshot' }), $r.rows, $r.changed, $r.kb)
        }
        if (-not $Dry) {
          if ($isInc) {
            if ($null -ne $r.maxWm) {
              $state["wm:$table"] = $r.maxWm
            } elseif ($null -ne $wm) {
              # Ventana VACIA. Dos causas posibles y hay que distinguirlas, porque una se cura sola
              # y la otra deja el carril MUDO para siempre:
              #  (a) hueco de folios -> saltar al techo de la ventana y seguir;
              #  (b) el origen REINICIO el contador (Wincaja archiva al cierre de ano y el
              #      Consecutivo vuelve a 1 -- verificado en las carpetas por ano: 2021 va 1..89,586
              #      y 2025 va 1..129,760). Con el watermark alto, `> wm` no devuelve NADA nunca mas.
              # Se resuelve con un solo MAX(), y solo cuando algo ya parece trabado (no en el camino
              # feliz), asi no se paga el scan en cada ciclo.
              $mc = $Conn.CreateCommand()
              $mc.CommandText = "SELECT MAX([$($spec.wm)]) AS m FROM [$table]"
              $mx = $mc.ExecuteScalar()
              $mxd = 0.0
              if ($null -ne $mx -and -not ($mx -is [System.DBNull]) -and [double]::TryParse(([string]$mx), [ref]$mxd)) {
                if ($mxd -lt [double]$wm) {
                  Write-Host ("  {0,-20} el origen REINICIO el contador ({1} < watermark {2}) -> watermark a 0" -f $table, $mxd, $wm)
                  $state.Remove("wm:$table")
                } elseif ($null -ne $winTop -and $mxd -gt $winTop) {
                  $state["wm:$table"] = $winTop     # hueco: la ventana avanza aunque venga vacia
                }
              }
            }
          } else { $state["snap:$table"] = $now.ToString('o') }
          # Estado por TABLA, no al final del ciclo: si el ciclo muere a la mitad, lo ya empujado no
          # se re-empuja. Es idempotente igual (UPSERT sin churn), pero re-leer el .mdb de una caja
          # de produccion no es gratis.
          Write-State $state
        }
      } catch {
        $failed++
        Write-Host ("  {0,-20} ERR: {1}" -f $table, $_.Exception.Message)
      }
    }
  } finally { $conn.Close() }

  if (-not $Dry) { Write-State $state }
  # Un ciclo que no toco NADA no es un exito silencioso: puede ser la fuente inalcanzable
  # disfrazada (la leccion de WR.7). Se reporta distinto y el exit code lo delata en --once.
  if ($failed -gt 0) {
    Write-Host ("[{0}] {1}: {2} tablas con error de {3}" -f (Get-Date -Format 'HH:mm:ss'), $Branch, $failed, $PLAN.Count)
  } elseif ($sentRows -gt 0) {
    Write-Host ("[{0}] {1}: {2} filas -> {3} cambiaron" -f (Get-Date -Format 'HH:mm:ss'), $Branch, $sentRows, $changedRows)
  }
  return $failed
}

# --- main ---
if (-not $Dry) {
  if (-not $IngestUrl) { throw 'Falta FEEDS_INGEST_URL (-IngestUrl o env).' }
  if (-not $IngestKey) { throw 'Falta FEEDS_INGEST_KEY (-IngestKey o env).' }
}
if (-not (Test-Path $Mdb)) { throw "No se alcanza el .mdb: $Mdb" }

if ($Once -or $Dry) {
  $f = Invoke-Cycle
  if ($f -gt 0) { exit 1 }
  exit 0
}
Write-Host ("=== wincaja-ods-agent {0} ({1}) - loop {2}s ===" -f $Branch, $Mdb, $IntervalSeconds)
while ($true) {
  try { [void](Invoke-Cycle) } catch { Write-Host ("  CICLO ERR: {0}" -f $_.Exception.Message) }
  Start-Sleep -Seconds $IntervalSeconds
}
