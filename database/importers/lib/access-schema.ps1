<#
  Adapter Access -> Postgres (Fases WR / CA) -- DESCUBRIDOR DE ESQUEMA de un .mdb (Access 97 / Jet 4.0).
  Emite JSONL: una linea JSON por tabla ->
    {"table":"MaestroMovAlmacen","rows":12345,"columns":[{"name":"Consecutivo","jet":"Int32","ord":0},...],"pk":["Consecutivo"]}

  Base del DDL espejo auto-generado (WR.2) y del mapa tabla->carril (WR.3).

  DEBE correr 32-bit (SysWOW64). Solo ASCII (PS32 rompe con no-ASCII):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File access-schema.ps1 -Mdb "<ruta>" -Out schema.jsonl

  Gotchas WR.0: GetOleDbSchemaTable(Columns) es INESTABLE en Jet -> columnas via SELECT * WHERE 1=0
  (reader.GetName/GetFieldType). Primary_Keys tambien puede fallar -> best-effort en try/catch (pk puede venir []).
  Ultima linea a stdout: "TABLES=<n>".
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Pattern = '',
  [switch]$NoCounts
)
$ErrorActionPreference = 'Stop'
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
$sw = New-Object System.IO.StreamWriter($Out, $false, (New-Object System.Text.UTF8Encoding($false)))
try {
  $tbl = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Tables, @($null, $null, $null, 'TABLE'))
  $names = @()
  foreach ($r in $tbl.Rows) {
    $nm = [string]$r['TABLE_NAME']
    if ($nm -notlike 'MSys*' -and $nm -notlike '~*') { $names += $nm }
  }
  $names = $names | Sort-Object

  # PK best-effort (puede fallar entero o por tabla -> map vacio).
  $pkMap = @{}
  try {
    $pk = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Primary_Keys, @($null, $null, $null))
    foreach ($r in $pk.Rows) {
      $t = [string]$r['TABLE_NAME']; $c = [string]$r['COLUMN_NAME']
      if (-not $pkMap.ContainsKey($t)) { $pkMap[$t] = @() }
      $pkMap[$t] += $c
    }
  } catch { }

  $count = 0
  foreach ($t in $names) {
    if ($Pattern -and ($t -notmatch $Pattern)) { continue }
    $cols = @()
    try {
      $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT * FROM [$t] WHERE 1=0"
      $rd = $cmd.ExecuteReader()
      for ($i = 0; $i -lt $rd.FieldCount; $i++) {
        $cols += [ordered]@{ name = $rd.GetName($i); jet = $rd.GetFieldType($i).Name; ord = $i }
      }
      $rd.Close()
    } catch { }
    $rows = -1
    if (-not $NoCounts) {
      try { $c = $conn.CreateCommand(); $c.CommandText = "SELECT COUNT(*) FROM [$t]"; $rows = [int]$c.ExecuteScalar() } catch { $rows = -2 }
    }
    $pkArr = @(); if ($pkMap.ContainsKey($t)) { $pkArr = @($pkMap[$t]) }
    $obj = [ordered]@{ table = $t; rows = $rows; columns = @($cols); pk = $pkArr }
    $sw.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
    $count++
  }
  $sw.Flush()
  Write-Output "TABLES=$count"
} finally {
  $sw.Close(); $conn.Close()
}
