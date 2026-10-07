<#
  TDA live — Extractor Wincaja por QUERY arbitraria (Access 97 / Jet 4.0) → JSONL.
  Hermano de extract-table.ps1, pero acepta un SELECT completo (con WHERE/JOIN) para
  lecturas INCREMENTALES (solo tickets nuevos) del .mdb.

  DEBE correr en proceso 32-bit:
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File extract-query.ps1 -Mdb "<ruta>" -Query "SELECT ... WHERE ..." -Out "out.jsonl"

  Lee READ-ONLY (Mode=Read) → seguro sobre una copia-sombra del .mdb vivo del POS.
  DateTime→ISO, DBNull→null, blobs→null. Última línea a stdout: "ROWS=<n>".
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Query,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
try {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $Query
  $reader = $cmd.ExecuteReader()

  $sw = New-Object System.IO.StreamWriter($Out, $false, (New-Object System.Text.UTF8Encoding($false)))
  $n = 0
  $fieldCount = $reader.FieldCount
  $names = New-Object 'string[]' $fieldCount
  for ($i = 0; $i -lt $fieldCount; $i++) { $names[$i] = $reader.GetName($i) }

  while ($reader.Read()) {
    $row = [ordered]@{}
    for ($i = 0; $i -lt $fieldCount; $i++) {
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
