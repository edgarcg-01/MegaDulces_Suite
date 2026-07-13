@echo off
REM ============================================================================
REM  PUSH de ventas de RUTA v2 — camioneta -> runner.  REACTIVO A LA RED.
REM  Cambios vs v1:
REM    - Precheck de conectividad (connect_timeout=5): sale en <5s si no hay linea,
REM      en vez de colgarse en el timeout largo de psql. Loguea ONLINE/OFFLINE.
REM    - El heartbeat lo escribe merge_route_sales en el runner (ver runner-heartbeat.sql).
REM  Se dispara por la tarea 'ruta.task.xml' (evento red-conectada + cada 15 min).
REM
REM  Copiar a  C:\KeplerPush\push-ruta.cmd  (FUERA del repo: lleva credenciales)
REM  y llenar los <...>.  Una camioneta = un archivo + una tarea.
REM ============================================================================
setlocal
set PGCLIENTENCODING=UTF8

REM ===== CONFIG (por camioneta) ===============================================
set PSQL=
if exist "C:\Program Files\PostgreSQL\18\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\18\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\17\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\17\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\16\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\16\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\15\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\15\bin\psql.exe"
if not defined PSQL if exist "C:\Program Files\PostgreSQL\14\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\14\bin\psql.exe"

REM  TRUCK = clave de sucursal en mart.ventas (numero de ruta de la EMPRESA, ej. ruta_27).
set TRUCK=ruta_27
set DAYS=15

REM  SERIE local de la ruta (folio c63 SIN el guion). Verificar por base:
REM    %PSQL% "%SRC%" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
REM  OJO: si la base tiene VARIAS rutas, este filtro es OBLIGATORIO (o hay doble conteo).
set ROUTE_SERIE=UD1001

REM  SRC = Postgres LOCAL de la camioneta.  DST = runner (fijo).  connect_timeout=5 -> no cuelga.
set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>?connect_timeout=5
set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.249:5433/kepler_consolidado?connect_timeout=5

set LOG=C:\KeplerPush\push_%TRUCK%.log
REM ============================================================================

if not defined PSQL echo [%date% %time%] ERROR: psql.exe no encontrado >> "%LOG%"
if not defined PSQL goto :eof

REM 0) PRECHECK: el runner responde? Si no, salir rapido (se reintenta al reconectar).
%PSQL% "%DST%" -tAc "select 1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] OFFLINE: runner .249 no alcanzable; se reintenta al reconectar >> "%LOG%"
  goto :eof
)
echo [%date% %time%] --- ONLINE, push %TRUCK% (serie %ROUTE_SERIE%) --- >> "%LOG%"

REM 1) Limpiar staging de esta camioneta en el runner.
%PSQL% "%DST%" -c "delete from ingest.route_sales_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

REM 2) DIRECTO: venta local -> staging del runner (pipe, sin archivo).
%PSQL% "%SRC%" -c "\copy (select '%TRUCK%',h.c1,h.c6,h.c9::date,h.c10,d.c8,d.c10,d.c11,d.c9::numeric,d.c12::numeric,d.c13::numeric from md.kdm2 d join md.kdm1 h on h.c1=d.c1 and h.c2=d.c2 and h.c3=d.c3 and h.c4=d.c4 and h.c5=d.c5 and h.c6=d.c6 where d.c2='U' and d.c3='D' and h.c4=10 and rtrim(btrim(h.c63),'-')='%ROUTE_SERIE%' and h.c9>=current_date-%DAYS%) to stdout csv" | %PSQL% "%DST%" -c "\copy ingest.route_sales_stg (truck,almacen,folio,fecha,forma_pago,sku,producto,unidad,cantidad,precio_neto,importe) from stdin csv" >> "%LOG%" 2>&1

REM 3) Merge idempotente en mart.ventas (tambien escribe el heartbeat).
echo [%date% %time%] merge -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_sales('%TRUCK%', %DAYS%)" >> "%LOG%" 2>&1
echo [%date% %time%] OK %TRUCK% >> "%LOG%"

endlocal
