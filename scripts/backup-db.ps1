# ---------------------------------------------------------------------------
# backup-db.ps1 - Respaldo diario de la base de datos de produccion.
#
# Uso manual:
#   powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#
# Programado: ver scripts\register-backup-task.ps1 para registrar en
# Windows Task Scheduler.
#
# ---------------------------------------------------------------------------
# ATENCION - por que este script lee FLEET_DB_URL y no DATABASE_URL
# ---------------------------------------------------------------------------
# Hasta el 2026-09-08 leia DATABASE_URL, y por eso NO respaldaba produccion.
#
# En esta maquina DATABASE_URL apunta a localhost:5433/postgres_platform (la
# copia local vieja); el unico puntero a prod en el .env es FLEET_DB_URL. Y por
# GOTCHAS.md #25 DATABASE_URL TIENE que ser la misma base fisica que
# DATABASE_URL_NEW - o sea la de desarrollo. Nunca va a ser prod, por diseno.
#
# Lo medido el 2026-09-08 sobre el dump del 6-sep:
#     kepler_ods:   1 tabla   (prod tiene 226)
#     identity:     8         (prod tiene 15)
#     commercial: 104         (prod tiene 107)
#   y 236.1 MB IDENTICOS cinco dias seguidos, cuando el heap de prod son
#   15.9 GB. Coincidia exacto con :5433/postgres_platform.
#
# La tarea TradeMarketing-DailyBackup estuvo en verde todo ese tiempo. Por eso
# ahora no alcanza con leer la variable correcta: el paso 2b clasifica el
# destino y ABORTA si no es prod, y el paso 5b exige un piso de tablas. Un
# respaldo que corre contra la base equivocada tiene que ROMPER, no pasar.
# ---------------------------------------------------------------------------

param(
    [string]$BackupDir   = "$env:USERPROFILE\backups\trade_marketing",
    [int]   $RetainDays  = 30,
    [string]$EnvFile     = (Join-Path $PSScriptRoot '..\.env'),
    [string]$PgDumpPath  = '',
    # Variable del .env que lleva la URL a respaldar. FLEET_DB_URL es prod.
    [string]$UrlVar      = 'FLEET_DB_URL',
    # Piso de tablas con datos que debe traer el dump. Prod tiene ~605; si el
    # dump trae menos que esto, se conecto a otra base o se quedo corto.
    [int]   $MinTables   = 400,
    # Espacio libre minimo antes de arrancar. Un dump de prod pesa ~3 GB.
    [int]   $MinFreeGb   = 15,
    # Retencion GFS: se conservan TODOS los de los ultimos $KeepDailyDays dias,
    # y despues solo el del domingo, hasta $RetainDays.
    [int]   $KeepDailyDays = 7,
    # Permite respaldar un destino que NO es prod (uso puntual, nunca la tarea).
    [switch]$AllowNonProd,
    # Clasifica el destino y termina, sin dumpear. Existe para poder PROBAR la
    # compuerta del paso 2b: una compuerta sin prueba negativa es una intencion.
    [switch]$CheckOnly
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

# 2. Leer la URL del .env (sin importar el resto al entorno)
if (-not (Test-Path $EnvFile)) {
    throw "No se encontro el archivo .env en: $EnvFile"
}
$databaseUrl = $null
$pattern = '^\s*' + [regex]::Escape($UrlVar) + '\s*=\s*(.+?)\s*$'
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match $pattern) {
        $databaseUrl = $matches[1].Trim('"').Trim("'")
    }
}
if (-not $databaseUrl) {
    throw "$UrlVar no esta definida en $EnvFile. Es la URL de PRODUCCION; sin ella no hay respaldo que tomar."
}

# 2b. Clasificar el destino. Se imprime host/base, NUNCA la URL (lleva credenciales).
$host_ = '(host desconocido)'
$dbName = '(base desconocida)'
if ($databaseUrl -match '^[a-z]+://[^@/]*@([^:/?]+)(?::(\d+))?/([^?]+)') {
    $host_  = $matches[1]
    $dbName = $matches[3]
}
$esProd = ($databaseUrl -match 'rlwy\.net|railway\.internal|\.railway\.app') -or ($dbName -eq 'railway')

Write-Log "Destino: $host_/$dbName  ->  $(if ($esProd) { 'PRODUCCION' } else { 'NO es produccion' })"

if (-not $esProd -and -not $AllowNonProd) {
    Write-Log "ABORT: '$UrlVar' apunta a $host_/$dbName, que no clasifica como produccion."
    Write-Log "  Este script es el respaldo de PROD. Un respaldo de la base equivocada es peor que"
    Write-Log "  no tener respaldo, porque la tarea queda en verde. (Fue el bug hasta el 2026-09-08.)"
    Write-Log "  Si de verdad querias respaldar otra base: -AllowNonProd."
    exit 2
}

if ($CheckOnly) {
    Write-Log "-CheckOnly: destino aceptado, no se dumpea nada."
    exit 0
}

# 3. Preparar destino
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

# 3b. Espacio libre. Mientras el script respaldaba la base equivocada cada dump
#     pesaba 236 MB; uno de prod pesa del orden de 3 GB (heap+toast 15.9 GB
#     comprimido). O sea que arreglar el bug MULTIPLICA por ~13 lo que ocupa
#     esta carpeta, y con la retencion vieja (30 dias planos) se comia el disco.
#     Por eso: piso de espacio antes de empezar, y retencion GFS en el paso 6.
$drive = (Get-Item $BackupDir).PSDrive
if ($drive -and $drive.Free) {
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    Write-Log "Espacio libre en $($drive.Name): $freeGb GB."
    if ($freeGb -lt $MinFreeGb) {
        Write-Log "ABORT: hacen falta al menos $MinFreeGb GB libres y hay $freeGb."
        Write-Log "  Un pg_dump que se queda sin disco deja un archivo truncado que"
        Write-Log "  pg_restore --list igual abre. Prefiero no empezar."
        exit 2
    }
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
    $toc = & $pgRestore --list $dumpFile 2>$null
    if (-not $toc) {
        Write-Log "ADVERTENCIA: pg_restore --list no devolvio contenido. Dump posiblemente corrupto."
        exit 2
    }

    # 5b. El dump tiene que PARECERSE a prod. "Abre bien" no es "trajo lo que hay":
    #     el dump del 6-sep abria perfecto y le faltaban 225 tablas de kepler_ods.
    $tablas = ($toc | Select-String -SimpleMatch 'TABLE DATA').Count
    $ods    = ($toc | Select-String -SimpleMatch 'TABLE DATA kepler_ods ').Count
    Write-Log "Contenido: $tablas tablas con datos (kepler_ods: $ods)."

    if ($esProd -and $tablas -lt $MinTables) {
        Write-Log "ABORT: el dump trae $tablas tablas y el piso es $MinTables."
        Write-Log "  El destino clasifico como prod pero el contenido no lo parece."
        Write-Log "  No se conserva un respaldo que no puedo afirmar que este completo."
        Remove-Item $dumpFile -Force
        exit 2
    }
}

# 6. Retencion GFS. Antes era "borrar todo lo mas viejo que 30 dias", que con
#    dumps de 236 MB daba 7 GB y con dumps de prod daria ~90 GB.
#      - todo lo de los ultimos $KeepDailyDays dias                  -> se queda
#      - entre eso y $RetainDays, solo el del DOMINGO                -> se queda
#      - mas viejo que $RetainDays                                   -> se borra
$ahora       = Get-Date
$cutoffFinal = $ahora.AddDays(-$RetainDays)
$cutoffDiario= $ahora.AddDays(-$KeepDailyDays)

$candidatos = Get-ChildItem $BackupDir -File |
    Where-Object { $_.Name -match '^trade_marketing_.*\.(dump|log)$' }

foreach ($f in $candidatos) {
    $t = $f.LastWriteTime
    $borrar = $false
    $motivo = ''
    if ($t -lt $cutoffFinal) {
        $borrar = $true; $motivo = "mas de $RetainDays dias"
    } elseif ($t -lt $cutoffDiario -and $t.DayOfWeek -ne [System.DayOfWeek]::Sunday) {
        $borrar = $true; $motivo = "fuera de la ventana diaria y no es domingo"
    }
    if ($borrar) {
        Write-Log "Eliminando ($motivo): $($f.Name)"
        Remove-Item $f.FullName -Force
    }
}

$quedan   = Get-ChildItem $BackupDir -File -Filter '*.dump' -ErrorAction SilentlyContinue
$ocupado  = if ($quedan) { [math]::Round((($quedan | Measure-Object Length -Sum).Sum) / 1GB, 2) } else { 0 }
Write-Log "Retencion: quedan $($quedan.Count) dumps, $ocupado GB."

Write-Log "Backup terminado."
exit 0
