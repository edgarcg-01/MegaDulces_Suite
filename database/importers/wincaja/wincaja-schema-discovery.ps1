<#
  Fase WR.0 - Descubridor de esquema de un .mdb Wincaja (Access 97) via Jet 32-bit read-only.
  Lista las tablas con datos (row count) + las columnas/tipos de las tablas de movimiento
  (Maestro/Detalle/Corte). Base del DDL espejo auto-generado de WR.2.

  DEBE correr en proceso 32-bit (Jet 4.0 no tiene build 64-bit):
    & "C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe" -File wincaja-schema-discovery.ps1 -Mdb "Z:\Salidas\Bases\Actuales\30 MORELIA ABASTOS.MDB"

  Gotchas (WR.0): Jet GetOleDbSchemaTable(Columns/Primary_Keys) es inestable -> columnas via
  SELECT * WHERE 1=0 (reader.GetName/GetFieldType). PS32 rompe con no-ASCII (em-dash) -> solo ASCII.
#>
param([Parameter(Mandatory=$true)][string]$Mdb)
$ErrorActionPreference = 'Stop'
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=`"$Mdb`";Mode=Read;"
$conn = New-Object System.Data.OleDb.OleDbConnection $cs
$conn.Open()
try {
  $tables = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Tables, @($null,$null,$null,'TABLE'))
  $names = @()
  foreach ($r in $tables.Rows) { $n = [string]$r['TABLE_NAME']; if ($n -notlike 'MSys*' -and $n -notlike '~*') { $names += $n } }
  $names = $names | Sort-Object
  Write-Output ("TABLAS con datos (de {0}):" -f $names.Count)
  foreach ($t in $names) {
    $n = -1
    try { $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT COUNT(*) FROM [$t]"; $n = [int]$cmd.ExecuteScalar() } catch { $n = -2 }
    if ($n -gt 0) { Write-Output ("  {0,-36} filas={1,10}" -f $t, $n) }
  }
  foreach ($t in $names) {
    if ($t -match 'Maestro|Detalle|Corte') {
      Write-Output ""
      Write-Output ("### $t")
      try {
        $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT * FROM [$t] WHERE 1=0"
        $rd = $cmd.ExecuteReader()
        $cl = @(); for ($i=0; $i -lt $rd.FieldCount; $i++) { $cl += ("{0}:{1}" -f $rd.GetName($i), $rd.GetFieldType($i).Name) }
        $rd.Close()
        Write-Output ("  cols: {0}" -f ($cl -join '  '))
      } catch { Write-Output ("  (error cols: {0})" -f $_.Exception.Message) }
    }
  }
} finally { $conn.Close() }
