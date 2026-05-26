# ---------------------------------------------------------------------------
# backup-db.ps1 - Respaldo diario de la base de datos de produccion.
#
# Uso manual:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# Programado: ver scripts\register-backup-task.ps1 para registrar en
# Windows Task Scheduler.
# ---------------------------------------------------------------------------

param(
    [string]$BackupDir   = "$env:USERPROFILE\backups\trade_marketing",
    [int]   $RetainDays  = 30,
    [string]$EnvFile     = (Join-Path $PSScriptRoot '..\.env'),
    [string]$PgDumpPath  = ''
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$msg) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$stamp] $msg"
}

# 1. Localizar pg_dump - preferimos la version mas ALTA instalada (no la que
#    aparezca primero en PATH). Esto evita el problema clasico de tener
#    pg_dump 16 en PATH mientras Railway corre Postgres 18.
if (-not $PgDumpPath) {
    $candidates = @(
        'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe',
        'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe',
        'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe',
        'C:\Program Files\PostgreSQL\15\bin\pg_dump.exe'
    )
    $PgDumpPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $PgDumpPath) {
        $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
        if ($cmd) { $PgDumpPath = $cmd.Source }
    }
}
if (-not $PgDumpPath -or -not (Test-Path $PgDumpPath)) {
    throw "pg_dump no encontrado. Instala PostgreSQL client tools o pasa -PgDumpPath."
}
Write-Log "Usando pg_dump: $PgDumpPath"

# 2. Leer DATABASE_URL del .env (sin importar el resto al entorno)
if (-not (Test-Path $EnvFile)) {
    throw "No se encontro el archivo .env en: $EnvFile"
}
$databaseUrl = $null
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') {
        $databaseUrl = $matches[1].Trim('"').Trim("'")
    }
}
if (-not $databaseUrl) {
    throw "DATABASE_URL no esta definida en $EnvFile"
}

# 3. Preparar destino
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}
$stamp     = (Get-Date).ToString('yyyy-MM-dd_HHmm')
$dumpFile  = Join-Path $BackupDir "trade_marketing_$stamp.dump"
$logFile   = Join-Path $BackupDir "trade_marketing_$stamp.log"

Write-Log "Iniciando dump -> $dumpFile"

# 4. Ejecutar pg_dump
#    -Fc  : custom format (comprimido, restaurable con pg_restore, selectivo)
#    -Z 6 : nivel de compresion razonable
#    --no-owner / --no-privileges : portabilidad entre entornos al restaurar
$pgArgs = @(
    '--dbname', $databaseUrl,
    '--format', 'custom',
    '--compress', '6',
    '--no-owner',
    '--no-privileges',
    '--verbose',
    '--file', $dumpFile
)

$proc = Start-Process -FilePath $PgDumpPath `
    -ArgumentList $pgArgs `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardError $logFile

if ($proc.ExitCode -ne 0) {
    Write-Log "pg_dump fallo con exit code $($proc.ExitCode). Ver log: $logFile"
    if (Test-Path $dumpFile) { Remove-Item $dumpFile -Force }
    exit $proc.ExitCode
}

$size = (Get-Item $dumpFile).Length
$sizeMb = [math]::Round($size / 1MB, 2)
Write-Log "Dump OK ($sizeMb MB)."

# 5. Validacion minima: el archivo no debe estar vacio y debe abrir con pg_restore -l
$pgRestore = Join-Path (Split-Path $PgDumpPath) 'pg_restore.exe'
if (Test-Path $pgRestore) {
    $listOk = & $pgRestore --list $dumpFile 2>$null | Select-Object -First 1
    if (-not $listOk) {
        Write-Log "ADVERTENCIA: pg_restore --list no devolvio contenido. Dump posiblemente corrupto."
        exit 2
    }
}

# 6. Retencion: borrar dumps y logs mas viejos que $RetainDays
$cutoff = (Get-Date).AddDays(-$RetainDays)
$old = Get-ChildItem $BackupDir -File |
    Where-Object { $_.Name -match '^trade_marketing_.*\.(dump|log)$' -and $_.LastWriteTime -lt $cutoff }
foreach ($f in $old) {
    Write-Log "Eliminando antiguo: $($f.Name)"
    Remove-Item $f.FullName -Force
}

Write-Log "Backup terminado."
exit 0
