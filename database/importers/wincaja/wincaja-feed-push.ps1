<#
  WR.8.0 -- CLI de UNA tabla: .mdb -> feeds-ingest -> wincaja_ods.<Tabla>. Envoltorio delgado sobre
  `wincaja-ods-lib.ps1` (ahi vive la logica y el porque). Sirve para pruebas y empujes puntuales;
  el ciclo continuo de la caja es `wincaja-ods-agent.ps1`.

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
  [string]$IngestUrl = $env:FEEDS_INGEST_URL,             # .../ingest  (sin el nombre del feed)
  [string]$IngestKey = $env:FEEDS_INGEST_KEY,
  [string]$TenantId = $(if ($env:CRON_TENANT_ID) { $env:CRON_TENANT_ID } else { '00000000-0000-0000-0000-00000000d01c' }),
  [int]$MaxRows = 0,
  [switch]$Dry
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wincaja-ods-lib.ps1')

if (-not $Dry) {
  if (-not $IngestUrl) { throw 'Falta FEEDS_INGEST_URL (-IngestUrl o env).' }
  if (-not $IngestKey) { throw 'Falta FEEDS_INGEST_KEY (-IngestKey o env).' }
}

$conn = Open-Mdb $Mdb
try {
  $r = Push-AccessTable -Conn $conn -Table $Table -Branch $Branch -Pk $Pk -Where $Where `
        -Schema $Schema -Feed $Feed -IngestUrl $IngestUrl -IngestKey $IngestKey `
        -TenantId $TenantId -MaxRows $MaxRows -Dry:$Dry
  if ($r.dry) {
    Write-Host ("{0}/{1}: {2} filas -> {3} KB gzip  [DRY] {4}" -f $Branch, $Table, $r.rows, $r.kb, $r.path)
  } else {
    Write-Host ("{0}/{1}: {2} filas -> {3} KB gzip -> cambiaron {4}" -f $Branch, $Table, $r.rows, $r.kb, $r.changed)
  }
} finally { $conn.Close() }
