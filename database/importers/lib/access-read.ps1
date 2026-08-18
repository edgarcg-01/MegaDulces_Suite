<#
  Adapter Access -> Postgres (Fases WR / CA) -- LECTURA de un .mdb (Access 97 / Jet 4.0) -> JSONL.
  Acepta -Query (SELECT completo, para el carril incremental con WHERE) o -Table (+ -Columns/-Where/-OrderBy).
  Lee READ-ONLY (Mode=Read) -> seguro sobre una copia-sombra del .mdb vivo.

  DEBE correr 32-bit (Jet 4.0 no tiene build 64-bit). Solo ASCII (PS32 rompe con no-ASCII):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File access-read.ps1 -Mdb "<ruta>" -Table "Articulos" -Out out.jsonl
    ... -Query "SELECT * FROM MaestroMovAlmacen WHERE Consecutivo > 1000" -Out out.jsonl

  Conversiones: DateTime -> ISO 'yyyy-MM-ddTHH:mm:ss', DBNull -> null, byte[] (blobs) -> null, resto tal cual.
  Ancestro: wincaja/extract-query.ps1 (probado en prod). Ultima linea a stdout: "ROWS=<n>".
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
  $n = 0
  $fc = $reader.FieldCount
  $names = New-Object 'string[]' $fc
  for ($i = 0; $i -lt $fc; $i++) { $names[$i] = $reader.GetName($i) }

  while ($reader.Read()) {
    $row = [ordered]@{}
    for ($i = 0; $i -lt $fc; $i++) {
      $v = $reader.GetValue($i)
      if ($v -is [System.DBNull]) {
        $row[$names[$i]] = $null
      } elseif ($v -is [datetime]) {
        $row[$names[$i]] = $v.ToString('yyyy-MM-ddTHH:mm:ss')
      } elseif ($v -is [byte[]]) {
        $row[$names[$i]] = $null
      } else {
        $row[$names[$i]] = $v
      }
    }
    $sw.WriteLine(($row | ConvertTo-Json -Compress -Depth 3))
    $n++
  }
  $reader.Close()
  $sw.Flush(); $sw.Close()
  Write-Output "ROWS=$n"
} finally {
  $conn.Close()
}
