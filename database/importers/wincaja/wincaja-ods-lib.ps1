<#
  WR.8 -- LIBRERIA del sink Access -> feeds-ingest -> wincaja_ods. Solo funciones: dot-source esto,
  no ejecuta nada por si mismo.

    . "$PSScriptRoot\wincaja-ods-lib.ps1"
    $conn = Open-Mdb "D:\Datos\WinCaja\30 MORELIA ABASTOS.mdb"
    $r = Push-AccessTable -Conn $conn -Table Existencias -Pk Almacen,Articulo -Branch 30 ...

  Habla el MISMO protocolo que `database/importers/lib/sink.js` (FEEDS_SINK=http) y pega en el MISMO
  handler `raw-upsert` del CDC de Kepler:

      POST /ingest/raw-upsert     header X-Ingest-Key
      body = gzip(JSONL): linea 0 = {tenant_id, meta, count}; lineas 1..N = filas

  Por que alcanza sin hash-delta en la caja: el handler hace UPSERT SIN CHURN
  (ON CONFLICT ... DO UPDATE ... WHERE IS DISTINCT FROM) -> una fila que no cambio NO se reescribe.
  Verificado 2026-09-01: segundo push identico de Existencias (14,873 filas) devolvio rowCount=0.
  El hash-delta del ODS de Kepler existe para no pagar egress desde la sucursal; aca la direccion
  (ingress a Railway) es la gratis.

  EFICIENCIA: CERO cmdlets por fila. Se serializa a mano con StringBuilder directo a un GZipStream,
  una sola pasada, memoria constante. (`ConvertTo-Json` por fila es lo que costo 8x en el lector Jet.)

  SEGURIDAD: SIEMPRE Mode=Read. El POS tiene el .mdb abierto en modo compartido -> una lectura
  read-only se une a la sesion, NO bloquea la caja. NUNCA escribe.

  DEBE correr en 32-bit (Jet 4.0 no tiene build 64-bit; ACE rechaza Access 97 -- ADR-031).
  Archivo ASCII puro a proposito (PS 5.1 32-bit sin BOM lee acentos como ANSI y rompe el parseo).
#>

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12   # HTTPS a Railway en PS 5.1
$script:Md5 = [System.Security.Cryptography.MD5]::Create()
$script:Inv = [System.Globalization.CultureInfo]::InvariantCulture

function Open-Mdb([string]$Mdb) {
  $cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
  $conn = New-Object System.Data.OleDb.OleDbConnection $cs
  $conn.Open()
  return $conn
}

# Tipo Postgres del espejo crudo (mismo criterio que access-adapter.jetToPg). Fechas como text:
# Access guarda tiempos 1899 que Postgres rechaza como timestamp; el saneamiento vive en silver.
function Get-PgType([Type]$t) {
  if ($null -eq $t) { return 'text' }
  switch ($t.Name) {
    'Int16'   { 'numeric' } 'Int32' { 'numeric' } 'Int64' { 'numeric' }
    'Byte'    { 'numeric' } 'SByte' { 'numeric' }
    'Double'  { 'numeric' } 'Single' { 'numeric' } 'Decimal' { 'numeric' }
    'Boolean' { 'boolean' }
    default   { 'text' }
  }
}

function ConvertTo-JsonEscaped([string]$s) {
  $s = $s.Replace('\', '\\').Replace('"', '\"')
  return $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
}

function Get-RowHash([string]$s) {
  $b = $script:Md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
  return [System.BitConverter]::ToString($b).Replace('-', '').ToLower()
}

<#
  Lee una tabla (o el delta de un WHERE) y la empuja al ingest. Devuelve
  @{ rows; changed; maxWm; kb } -- `maxWm` sirve para avanzar el watermark del carril incremental.

  -Pk vacio o con '_row_hash' -> se agrega la columna `_row_hash` calculada aca. Solo hace falta
  donde el origen NO tiene llave natural: `DetallesMovAlmacen` (verificado 2026-09-01: NINGUNA
  combinacion de columnas de negocio la hace unica -- (Consecutivo,Articulo) deja 0.04-0.15% de
  renglones repetidos, y son venta MIXTA del mismo SKU, una linea en caja UnidadVenta=1 y otra en
  pieza UnidadVenta=0), `PagosDia`, `Retiros`. En el carril incremental el delta son cientos de
  filas por ciclo, asi que hashear ahi no cuesta; los catalogos de 90k tienen PK natural y no hashean.

  Los nombres de -Pk se resuelven CASE-INSENSITIVE contra las columnas reales del reader: Access es
  inconsistente con las mayusculas (`Cortes` tiene `caja` y `Retiros` tiene `Caja`, la misma cosa).
#>
function Push-AccessTable {
  param(
    [Parameter(Mandatory = $true)]$Conn,
    [Parameter(Mandatory = $true)][string]$Table,
    [Parameter(Mandatory = $true)][string]$Branch,
    [string[]]$Pk = @(),
    [string]$Where = '',
    [string]$WatermarkCol = '',
    [string]$Schema = 'wincaja_ods',
    [string]$Feed = 'raw-upsert',
    [Parameter(Mandatory = $true)][string]$IngestUrl,
    [Parameter(Mandatory = $true)][string]$IngestKey,
    [string]$TenantId = '00000000-0000-0000-0000-00000000d01c',
    [int]$MaxRows = 0,
    [switch]$Dry
  )
  $Pk = @($Pk | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

  $sql = "SELECT * FROM [$Table]"
  if ($Where) { $sql += " WHERE $Where" }
  if ($WatermarkCol) { $sql += " ORDER BY [$WatermarkCol]" }

  $gz = [System.IO.Path]::GetTempFileName() + '.jsonl.gz'
  $rows = 0
  $maxWm = $null
  try {
    $cmd = $Conn.CreateCommand(); $cmd.CommandText = $sql
    $reader = $cmd.ExecuteReader()
    $fc = $reader.FieldCount
    $names = New-Object 'string[]' $fc
    $types = New-Object 'string[]' $fc
    $wmIdx = -1
    for ($i = 0; $i -lt $fc; $i++) {
      $names[$i] = $reader.GetName($i)
      $types[$i] = Get-PgType $reader.GetFieldType($i)
      if ($WatermarkCol -and $names[$i].ToLower() -eq $WatermarkCol.ToLower()) { $wmIdx = $i }
    }

    # Resolucion case-insensitive de la PK contra las columnas reales.
    $lower = @{}
    for ($i = 0; $i -lt $fc; $i++) { $lower[$names[$i].ToLower()] = $names[$i] }
    $useHash = $false
    $pkResolved = New-Object System.Collections.ArrayList
    foreach ($k in $Pk) {
      if ($k -eq '_row_hash') { $useHash = $true; [void]$pkResolved.Add('_row_hash'); continue }
      $real = $lower[$k.ToLower()]
      if (-not $real) { throw "Push-AccessTable: la columna de PK '$k' no existe en [$Table]" }
      [void]$pkResolved.Add($real)
    }
    if ($pkResolved.Count -eq 0) { $useHash = $true; [void]$pkResolved.Add('_row_hash') }

    $metaCols = New-Object System.Collections.ArrayList
    [void]$metaCols.Add('{"name":"sucursal","type":"text"}')
    for ($i = 0; $i -lt $fc; $i++) {
      [void]$metaCols.Add('{"name":"' + (ConvertTo-JsonEscaped $names[$i]) + '","type":"' + $types[$i] + '"}')
    }
    if ($useHash) { [void]$metaCols.Add('{"name":"_row_hash","type":"text"}') }
    $pkJson = ($pkResolved | ForEach-Object { '"' + (ConvertTo-JsonEscaped $_) + '"' }) -join ','
    $head = '{"tenant_id":"' + $TenantId + '","meta":{"schema":"' + $Schema + '","table":"' +
            (ConvertTo-JsonEscaped $Table) + '","pk":[' + $pkJson + '],"columns":[' + ($metaCols -join ',') + ']}}'

    $fs = New-Object System.IO.FileStream($gz, [System.IO.FileMode]::Create)
    $zip = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Compress)
    $sw = New-Object System.IO.StreamWriter($zip, (New-Object System.Text.UTF8Encoding($false)))
    $sw.AutoFlush = $false
    $sw.WriteLine($head)

    $sb = New-Object System.Text.StringBuilder
    $hb = New-Object System.Text.StringBuilder
    while ($reader.Read()) {
      if ($MaxRows -gt 0 -and $rows -ge $MaxRows) { break }
      $sb.Length = 0; $hb.Length = 0
      [void]$sb.Append('{"sucursal":"').Append((ConvertTo-JsonEscaped $Branch)).Append('"')
      for ($i = 0; $i -lt $fc; $i++) {
        $v = $reader.GetValue($i)
        [void]$sb.Append(',"').Append((ConvertTo-JsonEscaped $names[$i])).Append('":')
        if ($v -is [System.DBNull] -or $v -is [byte[]]) {
          [void]$sb.Append('null')
        } elseif ($v -is [datetime]) {
          $s = $v.ToString('yyyy-MM-ddTHH:mm:ss')
          [void]$sb.Append('"').Append($s).Append('"'); [void]$hb.Append($s)
        } elseif ($v -is [bool]) {
          $s = $(if ($v) { 'true' } else { 'false' })
          [void]$sb.Append($s); [void]$hb.Append($s)
        } elseif ($types[$i] -eq 'numeric') {
          $s = [System.Convert]::ToString($v, $script:Inv)
          [void]$sb.Append($s); [void]$hb.Append($s)
        } else {
          $s = [string]$v
          [void]$sb.Append('"').Append((ConvertTo-JsonEscaped $s)).Append('"'); [void]$hb.Append($s)
        }
        [void]$hb.Append([char]1)
      }
      if ($useHash) { [void]$sb.Append(',"_row_hash":"').Append((Get-RowHash $hb.ToString())).Append('"') }
      [void]$sb.Append('}')
      $sw.WriteLine($sb.ToString())
      if ($wmIdx -ge 0) {
        $wv = $reader.GetValue($wmIdx)
        if (-not ($wv -is [System.DBNull])) {
          $n = 0.0
          if ([double]::TryParse(([string]$wv), [ref]$n)) { if ($null -eq $maxWm -or $n -gt $maxWm) { $maxWm = $n } }
        }
      }
      $rows++
    }
    $reader.Close()
    $sw.Flush(); $sw.Close(); $zip.Dispose(); $fs.Dispose()

    $kb = [math]::Round((Get-Item $gz).Length / 1KB, 1)
    if ($Dry) { return @{ rows = $rows; changed = 0; maxWm = $maxWm; kb = $kb; dry = $true; path = $gz } }
    if ($rows -eq 0) { return @{ rows = 0; changed = 0; maxWm = $maxWm; kb = $kb } }   # nada que mandar

    $uri = $IngestUrl.TrimEnd('/') + '/' + $Feed
    $resp = Invoke-RestMethod -Method Post -Uri $uri -InFile $gz `
      -ContentType 'application/octet-stream' `
      -Headers @{ 'X-Ingest-Key' = $IngestKey; 'Content-Encoding' = 'gzip' } -TimeoutSec 180
    return @{ rows = $rows; changed = [int]$resp.rowCount; maxWm = $maxWm; kb = $kb }
  } finally {
    if (-not $Dry) { Remove-Item $gz -Force -ErrorAction SilentlyContinue }
  }
}
