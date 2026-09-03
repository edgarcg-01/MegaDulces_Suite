<#
  Adapter Access -> Postgres (Fase WR-hist) -- LECTURA BULK de un .mdb (Access 97 / Jet 4.0) -> TSV.

  Por que existe (medido 2026-09-01): `access-read.ps1` hace `$row | ConvertTo-Json` POR FILA, y ese
  cmdlet es el cuello de botella real del historico -- `DetallesMovAlmacen` (152,718 filas) tardaba
  ~129 s de lectura contra ~16 s de escritura en Postgres. Este emite TSV construido con StringBuilder,
  sin ConvertTo-Json, y deja la lectura en la fraccion del tiempo.

  Se usa SOLO en el carril historico (carga one-shot). El carril VIVO sigue con access-read.ps1
  (JSONL) -- no se toca lo que esta en produccion bajo PM2.

  Formato de salida (UTF8, sin BOM):
    linea 1 = encabezado: nombres de columna separados por TAB (sin escapar: Access no usa tabs en
              nombres de columna)
    linea N = valores separados por TAB, con este escape minimo y reversible:
                \\  -> barra invertida literal
                \t  -> TAB
                \n  -> LF        \r -> CR
                \N  -> NULL (campo entero, como el COPY de Postgres)
    DateTime -> ISO 'yyyy-MM-ddTHH:mm:ss'   ·   byte[] (blobs) -> NULL   ·   Boolean -> True/False

  DEBE correr 32-bit (Jet 4.0 no tiene build 64-bit). Solo ASCII (PS32 rompe con no-ASCII).
  Ultima linea a stdout: "ROWS=<n>".
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [string]$Query = '',
  [string]$Table = '',
  [string]$Columns = '*',
  [string]$Where = '',
  [string]$OrderBy = '',
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
if (-not $Query) {
  if (-not $Table) { throw 'Falta -Query o -Table' }
  $Query = "SELECT $Columns FROM [$Table]"
  if ($Where)   { $Query += " WHERE $Where" }
  if ($OrderBy) { $Query += " ORDER BY $OrderBy" }
}
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
try {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $Query
  $reader = $cmd.ExecuteReader()

  $sw = New-Object System.IO.StreamWriter($Out, $false, (New-Object System.Text.UTF8Encoding($false)))
  $sw.AutoFlush = $false
  $sb = New-Object System.Text.StringBuilder

  $fc = $reader.FieldCount
  $names = New-Object 'string[]' $fc
  for ($i = 0; $i -lt $fc; $i++) { $names[$i] = $reader.GetName($i) }
  $sw.WriteLine([string]::Join("`t", $names))

  $n = 0
  while ($reader.Read()) {
    $sb.Length = 0
    for ($i = 0; $i -lt $fc; $i++) {
      if ($i -gt 0) { [void]$sb.Append("`t") }
      $v = $reader.GetValue($i)
      if ($v -is [System.DBNull] -or $v -is [byte[]]) {
        [void]$sb.Append('\N')
      } elseif ($v -is [datetime]) {
        [void]$sb.Append($v.ToString('yyyy-MM-ddTHH:mm:ss'))
      } elseif ($v -is [string]) {
        # Escape minimo, en este orden (la barra primero o se re-escapan las que agregamos).
        $s = $v.Replace('\', '\\').Replace("`t", '\t').Replace("`r", '\r').Replace("`n", '\n')
        [void]$sb.Append($s)
      } else {
        # numeros / bool / guid: no necesitan escape. InvariantCulture para que el decimal sea '.'
        [void]$sb.Append([System.Convert]::ToString($v, [System.Globalization.CultureInfo]::InvariantCulture))
      }
    }
    $sw.WriteLine($sb.ToString())
    $n++
  }
  $reader.Close()
  $sw.Flush(); $sw.Close()
  Write-Output "ROWS=$n"
} finally {
  $conn.Close()
}
