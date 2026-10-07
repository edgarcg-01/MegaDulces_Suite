param([string]$Table, [string]$CsvPath, [string]$PkExpr = '(id)')

# Conexión vía variables de entorno estándar de libpq (psql las lee solo):
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD.
# NUNCA hardcodear credenciales aquí. Setealas en la sesión antes de correr:
#   $env:PGHOST='...'; $env:PGPORT='...'; $env:PGUSER='postgres'; $env:PGDATABASE='railway'; $env:PGPASSWORD='...'
if (-not $env:PGPASSWORD -or -not $env:PGHOST) {
  Write-Error 'Faltan variables PG* (PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD). Ver comentario.'
  exit 1
}
$tempName = "tmp_$($Table.Replace('.','_'))_$(Get-Random -Maximum 99999)"
$sql = @"
SET session_replication_role = 'replica';
CREATE TEMP TABLE $tempName (LIKE $Table INCLUDING DEFAULTS);
\COPY $tempName FROM '$CsvPath' WITH (FORMAT csv, HEADER true)
INSERT INTO $Table SELECT * FROM $tempName ON CONFLICT $PkExpr DO NOTHING;
SELECT '$Table -> ' || COUNT(*) AS result FROM $Table;
DROP TABLE $tempName;
SET session_replication_role = 'origin';
"@
$sql | & 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -v ON_ERROR_STOP=1 -q -X 2>&1 | Select-String -NotMatch '^SET$','^CREATE TABLE$','^DROP TABLE$','^COPY \d+$','^INSERT 0 \d+$' | ForEach-Object { $_.Line }
