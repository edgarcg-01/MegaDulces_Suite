# ---------------------------------------------------------------------------
# restore-local.ps1 - Restaura el ultimo dump de produccion en una BD local.
#
# Uso manual:
#   powershell -ExecutionPolicy Bypass -File scripts\restore-local.ps1
#
# Lee LOCAL_DATABASE_URL del .env y restaura el .dump mas reciente que
# encuentre en $BackupDir. Si no encuentra dump, sale con error sin tocar
# nada.
#
# DROP + CREATE: la BD local queda EXACTAMENTE como la de produccion al
# momento del dump. Cualquier cambio manual local se pierde.
# ---------------------------------------------------------------------------

param(
    [string]$BackupDir   = "$env:USERPROFILE\backups\trade_marketing",
    [string]$EnvFile     = (Join-Path $PSScriptRoot '..\.env'),
    [string]$DumpFile    = '',
    [string]$PgBinDir    = ''
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$msg) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $msg"
}

# 1. Localizar binarios (psql, pg_restore) - preferimos version mas ALTA
#    instalada en disco antes de caer a PATH (mismo motivo que backup-db.ps1).
if (-not $PgBinDir) {
    $candidates = @(
        'C:\Program Files\PostgreSQL\18\bin',
        'C:\Program Files\PostgreSQL\17\bin',
        'C:\Program Files\PostgreSQL\16\bin',
        'C:\Program Files\PostgreSQL\15\bin'
    )
    $PgBinDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'pg_restore.exe') } | Select-Object -First 1
    if (-not $PgBinDir) {
        $pgRestoreCmd = Get-Command pg_restore -ErrorAction SilentlyContinue
        if ($pgRestoreCmd) { $PgBinDir = Split-Path $pgRestoreCmd.Source }
    }
}
$pgRestore = Join-Path $PgBinDir 'pg_restore.exe'
$psql      = Join-Path $PgBinDir 'psql.exe'
if (-not (Test-Path $pgRestore) -or -not (Test-Path $psql)) {
    throw "No se encontraron pg_restore.exe/psql.exe. Pasa -PgBinDir o instala PostgreSQL."
}
Write-Log "Binarios Postgres: $PgBinDir"

# 2. Leer LOCAL_DATABASE_URL
if (-not (Test-Path $EnvFile)) {
    throw "No se encontro el archivo .env en: $EnvFile"
}
$localUrl = $null
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*LOCAL_DATABASE_URL\s*=\s*(.+?)\s*$') {
        $localUrl = $matches[1].Trim('"').Trim("'")
    }
}
if (-not $localUrl) {
    throw "LOCAL_DATABASE_URL no esta definida en $EnvFile. Agregar: LOCAL_DATABASE_URL=postgresql://postgres:PASS@localhost:5432/trade_marketing_local"
}

# 3. Parsear URL local para sacar nombre de BD y armar URL admin (maintenance: postgres)
$builder   = [System.UriBuilder]::new($localUrl)
$targetDb  = $builder.Path.TrimStart('/')
if (-not $targetDb) { throw "LOCAL_DATABASE_URL no incluye nombre de base de datos." }
$builder.Path = '/postgres'
$adminUrl  = $builder.Uri.AbsoluteUri
Write-Log "BD destino local: $targetDb"

# 4. Elegir dump a restaurar
if (-not $DumpFile) {
    $latest = Get-ChildItem $BackupDir -Filter 'trade_marketing_*.dump' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latest) {
        throw "No hay ningun .dump en $BackupDir. Corre primero scripts\backup-db.ps1."
    }
    $DumpFile = $latest.FullName
}
if (-not (Test-Path $DumpFile)) {
    throw "Dump no encontrado: $DumpFile"
}
Write-Log "Restaurando desde: $DumpFile"

# 5. Terminar conexiones activas a la BD destino + DROP + CREATE
$terminateSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$targetDb' AND pid <> pg_backend_pid();"
$dropSql      = "DROP DATABASE IF EXISTS `"$targetDb`";"
$createSql    = "CREATE DATABASE `"$targetDb`";"

Write-Log "Terminando conexiones activas a $targetDb..."
& $psql --dbname $adminUrl -v ON_ERROR_STOP=1 -c $terminateSql | Out-Null

Write-Log "Drop + create $targetDb..."
& $psql --dbname $adminUrl -v ON_ERROR_STOP=1 -c $dropSql
if ($LASTEXITCODE -ne 0) { throw "Fallo el DROP DATABASE." }
& $psql --dbname $adminUrl -v ON_ERROR_STOP=1 -c $createSql
if ($LASTEXITCODE -ne 0) { throw "Fallo el CREATE DATABASE." }

# 6. pg_restore
$restoreArgs = @(
    '--dbname', $localUrl,
    '--no-owner',
    '--no-privileges',
    '--jobs', '4',
    '--verbose',
    $DumpFile
)
Write-Log "Ejecutando pg_restore..."
& $pgRestore @restoreArgs
$rc = $LASTEXITCODE
# pg_restore retorna 1 con warnings no-fatales (ej. extensions ya existentes).
# Solo tratamos como error si es >= 2.
if ($rc -ge 2) {
    throw "pg_restore fallo con exit code $rc."
}

Write-Log "Restore local OK. BD '$targetDb' actualizada en localhost:$($builder.Port)."
exit 0
