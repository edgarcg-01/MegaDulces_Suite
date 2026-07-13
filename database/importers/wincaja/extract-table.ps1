<#
  W.1 — Extractor genérico Wincaja (Access 97 / Jet 3.5) → JSONL.

  DEBE correr en proceso 32-bit (Jet 4.0 no tiene build 64-bit):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File extract-table.ps1 -Mdb "<ruta>" -Table "Articulos" -Out "out.jsonl"

  Lee read-only (Mode=Read, sin .ldb), vuelca una línea JSON por fila.
  Conversiones: DateTime→ISO 'yyyy-MM-ddTHH:mm:ss', DBNull→null, resto tal cual.
  Imprime el conteo de filas a stdout (última línea: "ROWS=<n>").
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Table,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Columns = '*'
)

$ErrorActionPreference = 'Stop'
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
try {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = "SELECT $Columns FROM [$Table]"
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
        $row[$names[$i]] = $null   # blobs: se ignoran en landing
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
