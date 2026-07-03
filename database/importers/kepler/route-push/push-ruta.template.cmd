@echo off
REM ============================================================================
REM  PUSH de ventas de RUTA (DIRECTO, sin CSV) — camioneta -> runner.
REM  Streamea la venta local al runner por pipe: \copy ... to stdout | \copy ... from stdin.
REM  (No escribe archivos; la venta viaja de la base local al runner en un solo paso.)
REM
REM  Corre por Task Scheduler cada 15 min, OCULTO (como SYSTEM, sin consolas):
REM    schtasks /Create /TN Ruta27 /TR "C:\KeplerPush\push-ruta.cmd" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST /F
REM
REM  Copiar a  C:\KeplerPush\push-ruta.cmd  (FUERA del repo: lleva credenciales)
REM  y llenar los <...>.  Una camioneta = un archivo + una tarea.
REM ============================================================================
setlocal
set PGCLIENTENCODING=UTF8

REM ===== CONFIG (por camioneta) ===============================================
REM  psql: autodetecta la version instalada (18..14). O fija la ruta a mano.
set PSQL=
if exist "C:\Program Files\PostgreSQL\18\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\18\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\17\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\17\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\16\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\16\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\15\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\15\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\14\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\14\bin\psql.exe"

REM  TRUCK = clave de sucursal en mart.ventas (convencion ruta_NN, ej. ruta_27).
set TRUCK=ruta_27
set DAYS=15

REM  SERIE local de la ruta (folio c63 SIN el guion). Verificar por base:
REM    %PSQL% "%SRC%" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
REM  OJO: si la base tiene VARIAS rutas, este filtro es OBLIGATORIO (o hay doble conteo).
REM       Si la base tiene UNA sola ruta, igual es inofensivo (debe matchear la serie real).
set ROUTE_SERIE=UD1001

REM  SRC = Postgres LOCAL de la camioneta.  DST = runner (fijo).
REM  Password embebida en la URI (sin espacios -> a prueba de comillas de cmd).
set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>
set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.249:5433/kepler_consolidado

set LOG=C:\KeplerPush\push_%TRUCK%.log
REM ============================================================================

if not defined PSQL echo [%date% %time%] ERROR: psql.exe no encontrado >> "%LOG%"
if not defined PSQL goto :eof
echo [%date% %time%] --- push %TRUCK% (serie %ROUTE_SERIE%) --- >> "%LOG%"

REM 1) Limpiar staging de esta camioneta en el runner.
%PSQL% "%DST%" -c "delete from ingest.route_sales_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

REM 2) DIRECTO: venta local -> staging del runner (pipe, sin archivo).
%PSQL% "%SRC%" -c "\copy (select '%TRUCK%',h.c1,h.c6,h.c9::date,h.c10,d.c8,d.c10,d.c11,d.c9::numeric,d.c12::numeric,d.c13::numeric from md.kdm2 d join md.kdm1 h on h.c1=d.c1 and h.c2=d.c2 and h.c3=d.c3 and h.c4=d.c4 and h.c5=d.c5 and h.c6=d.c6 where d.c2='U' and d.c3='D' and h.c4=10 and rtrim(btrim(h.c63),'-')='%ROUTE_SERIE%' and h.c9>=current_date-%DAYS%) to stdout csv" | %PSQL% "%DST%" -c "\copy ingest.route_sales_stg (truck,almacen,folio,fecha,forma_pago,sku,producto,unidad,cantidad,precio_neto,importe) from stdin csv" >> "%LOG%" 2>&1

REM 3) Merge idempotente en mart.ventas (loguea filas insertadas).
echo [%date% %time%] merge -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_sales('%TRUCK%', %DAYS%)" >> "%LOG%" 2>&1
echo [%date% %time%] OK %TRUCK% >> "%LOG%"

endlocal
