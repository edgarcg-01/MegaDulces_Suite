param([string]$Table, [string]$CsvPath, [string]$PkExpr = '(id)')

$env:PGPASSWORD = 'whhQQTskVhAeQbbStUUkalNyWmikxBHJ'
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
$sql | & 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h trolley.proxy.rlwy.net -p 39023 -U postgres -d railway -v ON_ERROR_STOP=1 -q -X 2>&1 | Select-String -NotMatch '^SET$','^CREATE TABLE$','^DROP TABLE$','^COPY \d+$','^INSERT 0 \d+$' | ForEach-Object { $_.Line }
