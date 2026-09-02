<#
  WR.8.0 -- SINK de feeds en PowerShell: .mdb VIVO del POS -> feeds-ingest -> wincaja_ods.<Tabla>.

  Es el equivalente de `database/importers/lib/sink.js` (FEEDS_SINK=http) pero sin Node: el
  servidor POS corre solo PowerShell por diseno. Habla el MISMO protocolo y pega en el MISMO
  handler `raw-upsert` que ya usa el CDC de Kepler:

      POST /ingest/raw-upsert     header X-Ingest-Key
      body = gzip(JSONL): linea 0 = {tenant_id, meta, count}; lineas 1..N = filas

  Por que esto alcanza (WR.8): el handler hace UPSERT SIN CHURN
  (ON CONFLICT ... DO UPDATE ... WHERE IS DISTINCT FROM), asi que una fila que no cambio NO se
  reescribe. Eso significa que la caja puede mandar SNAPSHOTS COMPLETOS de catalogos sin hashear
  nada: el delta lo calcula Postgres. En el ODS de Kepler el hash-delta existe para no pagar
  egress desde la sucursal; aca la direccion (ingress a Railway) es la gratis.

  EFICIENCIA (la leccion que ya nos costo 8x en el lector Jet): CERO trabajo por fila con cmdlets.
  Nada de `ConvertTo-Json` por fila -- se serializa a mano con StringBuilder y se escribe
  directo a un GZipStream. Una sola pasada, memoria constante.

  SEGURIDAD: abre SIEMPRE Mode=Read. El POS tiene el .mdb abierto en modo compartido (Access es
  multiusuario) -> una lectura read-only se une a la sesion, NO bloquea la caja. NUNCA escribe.

  DEBE correr en 32-bit (Jet 4.0 no tiene build 64-bit; ACE rechaza Access 97 -- ADR-031):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File wincaja-feed-push.ps1 `
        -Mdb "D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb" -Branch 30 -Table Existencias -Pk Almacen,Articulo

  Archivo ASCII puro a proposito (PS 5.1 32-bit sin BOM lee acentos como ANSI y rompe el parseo).
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Branch,          # codigo de sucursal: 30 / 32 / 00
  [Parameter(Mandatory = $true)][string]$Table,
  [string[]]$Pk = @(),                                    # PK natural del origen; vacio -> _row_hash
  [string]$Where = '',                                    # carril incremental: "[Consecutivo] > 123"
  [string]$Schema = 'wincaja_ods',
  [string]$Feed = 'raw-upsert',
  [string]$IngestUrl = $env:FEEDS_INGEST_URL,             # .../ingest/  (sin el nombre del feed)
  [string]$IngestKey = $env:FEEDS_INGEST_KEY,
  [string]$TenantId = $(if ($env:CRON_TENANT_ID) { $env:CRON_TENANT_ID } else { '00000000-0000-0000-0000-00000000d01c' }),
  [int]$MaxRows = 0,                                      # 0 = sin tope (para pruebas)
  [switch]$Dry                                            # arma el payload, NO postea
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12   # HTTPS a Railway en PS 5.1

# Invocado con `-File` (como lo hara la tarea programada), PowerShell NO parsea la sintaxis de
# arrays: `-Pk Almacen,Articulo` llega como UN string. Se normaliza aca para que las dos formas
# de invocacion (-File y dot-source) se comporten igual.
$Pk = @($Pk | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# --- tipo Postgres del espejo crudo (mismo criterio que access-adapter.jetToPg) ---------------
# Fechas como text: Access guarda tiempos 1899 que Postgres rechaza como timestamp. El saneamiento
# vive en las vistas silver, no en la replica cruda.
function Map-Type([Type]$t) {
  if ($null -eq $t) { return 'text' }
  switch ($t.Name) {
    'Int16'   { 'numeric' } 'Int32' { 'numeric' } 'Int64' { 'numeric' }
    'Byte'    { 'numeric' } 'SByte' { 'numeric' }
    'Double'  { 'numeric' } 'Single' { 'numeric' } 'Decimal' { 'numeric' }
    'Boolean' { 'boolean' }
    default   { 'text' }
  }
}

# --- escape JSON minimo (sin cmdlets: esto corre por fila) -------------------------------------
function Esc([string]$s) {
  $s = $s.Replace('\', '\\').Replace('"', '\"')
  $s = $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
  return $s
}

$md5 = [System.Security.Cryptography.MD5]::Create()
function RowHash([string]$s) {
  $b = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
  return [System.BitConverter]::ToString($b).Replace('-', '').ToLower()
}

$sql = "SELECT * FROM [$Table]"
if ($Where) { $sql += " WHERE $Where" }

$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
$gz = [System.IO.Path]::GetTempFileName() + '.jsonl.gz'
$rows = 0
try {
  $cmd = $conn.CreateCommand(); $cmd.CommandText = $sql
  $reader = $cmd.ExecuteReader()
  $fc = $reader.FieldCount
  $names = New-Object 'string[]' $fc
  $types = New-Object 'string[]' $fc
  for ($i = 0; $i -lt $fc; $i++) {
    $names[$i] = $reader.GetName($i)
    $types[$i] = Map-Type $reader.GetFieldType($i)
  }

  # Identidad: PK natural del origen, o `_row_hash` cuando el origen no tiene ninguna
  # (DetallesMovAlmacen: verificado 2026-09-01 que NINGUNA combinacion de columnas de negocio la
  # hace unica -- (Consecutivo,Articulo) deja 0.07% de renglones repetidos, y son venta MIXTA del
  # mismo SKU: una linea en caja (UnidadVenta=1) y otra en pieza (UnidadVenta=0)). El prefijo
  # legible se conserva pasando -Pk Consecutivo,Articulo,UnidadVenta y el hash desempata.
  $useHash = $false
  if ($Pk.Count -eq 0) { $Pk = @('_row_hash'); $useHash = $true }
  elseif ($Pk -contains '_row_hash') { $useHash = $true }

  # meta: columnas = sucursal + las del origen (+ _row_hash si aplica)
  $metaCols = New-Object System.Collections.ArrayList
  [void]$metaCols.Add('{"name":"sucursal","type":"text"}')
  for ($i = 0; $i -lt $fc; $i++) {
    [void]$metaCols.Add('{"name":"' + (Esc $names[$i]) + '","type":"' + $types[$i] + '"}')
  }
  if ($useHash) { [void]$metaCols.Add('{"name":"_row_hash","type":"text"}') }
  $pkJson = ($Pk | ForEach-Object { '"' + (Esc $_) + '"' }) -join ','
  $head = '{"tenant_id":"' + $TenantId + '","meta":{"schema":"' + $Schema + '","table":"' + (Esc $Table) +
          '","pk":[' + $pkJson + '],"columns":[' + ($metaCols -join ',') + ']}}'

  $fs = New-Object System.IO.FileStream($gz, [System.IO.FileMode]::Create)
  $zip = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Compress)
  $sw = New-Object System.IO.StreamWriter($zip, (New-Object System.Text.UTF8Encoding($false)))
  $sw.AutoFlush = $false
  $sw.WriteLine($head)

  $sb = New-Object System.Text.StringBuilder
  $hb = New-Object System.Text.StringBuilder
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  while ($reader.Read()) {
    if ($MaxRows -gt 0 -and $rows -ge $MaxRows) { break }
    $sb.Length = 0; $hb.Length = 0
    [void]$sb.Append('{"sucursal":"').Append((Esc $Branch)).Append('"')
    for ($i = 0; $i -lt $fc; $i++) {
      $v = $reader.GetValue($i)
      [void]$sb.Append(',"').Append((Esc $names[$i])).Append('":')
      if ($v -is [System.DBNull] -or $v -is [byte[]]) {
        [void]$sb.Append('null')
      } elseif ($v -is [datetime]) {
        $s = $v.ToString('yyyy-MM-ddTHH:mm:ss')
        [void]$sb.Append('"').Append($s).Append('"')
        [void]$hb.Append($s)
      } elseif ($v -is [bool]) {
        $s = $(if ($v) { 'true' } else { 'false' })
        [void]$sb.Append($s); [void]$hb.Append($s)
      } elseif ($types[$i] -eq 'numeric') {
        $s = [System.Convert]::ToString($v, $inv)
        [void]$sb.Append($s); [void]$hb.Append($s)
      } else {
        $s = [string]$v
        [void]$sb.Append('"').Append((Esc $s)).Append('"')
        [void]$hb.Append($s)
      }
      [void]$hb.Append([char]1)
    }
    if ($useHash) { [void]$sb.Append(',"_row_hash":"').Append((RowHash $hb.ToString())).Append('"') }
    [void]$sb.Append('}')
    $sw.WriteLine($sb.ToString())
    $rows++
  }
  $reader.Close()
  $sw.Flush(); $sw.Close(); $zip.Dispose(); $fs.Dispose()
} finally { $conn.Close() }

$sizeKb = [math]::Round((Get-Item $gz).Length / 1KB, 1)
Write-Host ("{0}/{1}: {2} filas -> {3} KB gzip" -f $Branch, $Table, $rows, $sizeKb)

if ($Dry) { Write-Host ("  [DRY] payload en {0}" -f $gz); return }
if (-not $IngestUrl) { throw 'Falta FEEDS_INGEST_URL (-IngestUrl o env).' }
if (-not $IngestKey) { throw 'Falta FEEDS_INGEST_KEY (-IngestKey o env).' }

$uri = $IngestUrl.TrimEnd('/') + '/' + $Feed
try {
  $resp = Invoke-RestMethod -Method Post -Uri $uri -InFile $gz `
    -ContentType 'application/octet-stream' `
    -Headers @{ 'X-Ingest-Key' = $IngestKey; 'Content-Encoding' = 'gzip' } -TimeoutSec 120
  Write-Host ("  ingest ok: received={0} rowCount={1} ms={2}" -f $resp.received, $resp.rowCount, $resp.ms)
} finally { Remove-Item $gz -Force -ErrorAction SilentlyContinue }
