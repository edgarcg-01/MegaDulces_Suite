<#
  Fase CG — Extractor genérico de los .mdb de Finanzas (Base Movimientos SI/NO y
  BMovimientosCajas) → JSONL. Hermano de los extractores Wincaja, pero usa el
  proveedor ACE.OLEDB.16.0 (funciona en 64-bit para estos archivos; no requiere
  el SysWOW64/Jet 32-bit que sí pide Wincaja Access 97).

  Lee READ-ONLY (Mode=Read) → seguro sobre el .mdb vivo o una copia-sombra.
  Conversiones: DateTime→ISO 'yyyy-MM-ddTHH:mm:ss' (incluye años basura tal cual;
  el importer Node los filtra), DBNull→null, byte[]→null. Última línea: "ROWS=<n>".

    powershell -File extract-mdb.ps1 -Mdb "<ruta>" -Query "SELECT ... FROM [tabla]" -Out "out.jsonl"
#>
param(
  [Parameter(Mandatory = $true)][string]$Mdb,
  [Parameter(Mandatory = $true)][string]$Query,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$cs = "Provider=Microsoft.ACE.OLEDB.16.0;Data Source=`"$Mdb`";Mode=Read;"
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
        # .NET soporta años 1..9999; emitimos ISO y el importer descarta fuera de 2009-2027.
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
