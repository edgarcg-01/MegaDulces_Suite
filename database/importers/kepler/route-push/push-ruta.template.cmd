@echo off
REM ============================================================================
REM  Agente PUSH de ventas de RUTA (camioneta -> runner).
REM  Cada camioneta corre esto por Task Scheduler (13:00-18:00 cada 15 min).
REM  La camioneta SALE hacia el runner (no necesita IP fija ni router).
REM
REM  Copiar a  C:\KeplerPush\push-ruta.cmd  (FUERA del repo: lleva credenciales)
REM  y llenar los <...>.  Ver README.md.
REM ============================================================================
setlocal

REM ===== CONFIG (llenar por camioneta) ========================================
set PSQL="C:\Program Files\PostgreSQL\16\bin\psql.exe"
set TRUCK=cam_01
set DAYS=15

REM  <<< OJO: doc-type de VENTA DE RUTA. NO asumir 10 (eso es venta de mostrador).
REM      Hay que decodificarlo por camioneta (ver README). Dejar el confirmado aqui:
set DOCTYPE=10

REM  Conexion LOCAL (Postgres de la camioneta). Sin espacios en la clave.
set LOCAL_CONN=host=localhost port=<PUERTO> dbname=<DB> user=<USR_RO> password=<CLAVE_LOCAL>

REM  Conexion al RUNNER (fija). connect_timeout=6 -> falla rapido si esta en ruta.
set RUNNER_CONN=host=192.168.0.249 port=5433 dbname=kepler_consolidado user=ingest password=<INGEST_PWD> connect_timeout=6

set WORK=C:\KeplerPush
REM ============================================================================

set PGCLIENTENCODING=UTF8
set CSV=%WORK%\stg_%TRUCK%.csv
set LOG=%WORK%\push_%TRUCK%.log
if not exist "%WORK%" mkdir "%WORK%"
echo [%date% %time%] --- push %TRUCK% inicio --- >> "%LOG%"

REM 0) Runner alcanzable? Si no, probablemente en ruta -> salir SIN error.
%PSQL% "%RUNNER_CONN%" -tAc "SELECT 1" >nul 2>>"%LOG%"
if errorlevel 1 ( echo [%date% %time%] runner no alcanzable ^(en ruta?^) - skip >> "%LOG%" & goto :fin )

REM 1) Dump venta local (ultimos %DAYS% dias, doc-type de ruta) a CSV.
%PSQL% "%LOCAL_CONN%" -v ON_ERROR_STOP=1 -c "\copy (SELECT '%TRUCK%' AS truck, h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6 WHERE d.c2='U' AND d.c3='D' AND h.c4=%DOCTYPE% AND h.c9 >= current_date - %DAYS% AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8)<>'' AND btrim(d.c10)<>'') TO '%CSV%' CSV" 2>>"%LOG%"
if errorlevel 1 ( echo [%date% %time%] ERROR dump local >> "%LOG%" & goto :fin )

REM 2) Limpiar staging de esta camioneta + cargar CSV al runner.
%PSQL% "%RUNNER_CONN%" -v ON_ERROR_STOP=1 -c "DELETE FROM ingest.route_sales_stg WHERE truck='%TRUCK%'" 2>>"%LOG%"
%PSQL% "%RUNNER_CONN%" -v ON_ERROR_STOP=1 -c "\copy ingest.route_sales_stg (truck,almacen,folio,fecha,forma_pago,sku,producto,unidad,cantidad,precio_neto,importe) FROM '%CSV%' CSV" 2>>"%LOG%"
if errorlevel 1 ( echo [%date% %time%] ERROR carga runner >> "%LOG%" & goto :fin )

REM 3) Merge en mart.ventas (overlap-reload idempotente). Loguea filas.
echo [%date% %time%] merge -> filas: >> "%LOG%"
%PSQL% "%RUNNER_CONN%" -tAc "SELECT ingest.merge_route_sales('%TRUCK%', %DAYS%)" >> "%LOG%" 2>&1
echo [%date% %time%] OK push %TRUCK% >> "%LOG%"

:fin
del "%CSV%" 2>nul
endlocal
