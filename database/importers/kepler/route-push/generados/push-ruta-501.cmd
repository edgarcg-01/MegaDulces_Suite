@echo off
REM ============================================================================
REM  PUSH de camioneta v3 — GENERADO, NO ESCRITO A MANO.
REM
REM    node database/importers/kepler/route-push/armar-push-camioneta.js \
REM         --truck ruta_501 --serie UD1002 --dias 15
REM
REM  ⛔ NO EDITAR A MANO. Si hace falta un cambio, va en el generador y se
REM     regenera: un archivo editado a mano es el defecto que [CGA-A.12] cierra.
REM     Para comprobar que lo desplegado sigue siendo esto:
REM       node ...\armar-push-camioneta.js --verificar C:\KeplerPush\push-ruta.cmd
REM
REM  Copiar a C:\KeplerPush\push-ruta.cmd (FUERA del repo: lleva credenciales)
REM  y llenar SOLO los <CLAVE_...>. Una camioneta = un archivo + una tarea.
REM
REM  Cuatro bloques, y los cuatro son obligatorios:
REM    1) VENTAS       -> ingest.route_sales_stg       -> merge_route_sales
REM    2) EXISTENCIA   -> ingest.route_stock_stg       -> merge_route_stock
REM    3) COBROS       -> ingest.route_collections_stg -> merge_route_collections
REM  El heartbeat de cada carril lo escribe su propio merge en el runner.
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

set TRUCK=ruta_501
set DAYS=15
set ROUTE_SERIE=UD1002

REM  ⛔ [VL.7.6] EL RUNNER ES 192.168.0.222 (el servidor Linux `md`), NO 192.168.0.249.
REM  El :5433 de .249 sobrevive como reenvio TCP, asi que una van mal dada de alta FUNCIONA
REM  y por eso el error no se ve. Alta nueva => 192.168.0.222 directo.
REM
REM  ⚠️ `connect_timeout=5` NO es cosmetico: sin el, una red lenta deja el push colgado y el
REM  log dice "tiempo de espera agotado" sin que nadie lo mire. Paso en ruta_23 el 2026-10-16.
set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>?connect_timeout=5
set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.222:5433/kepler_consolidado?connect_timeout=5

set LOG=C:\KeplerPush\push_%TRUCK%.log
REM ============================================================================

if not defined PSQL echo [%date% %time%] ERROR: psql.exe no encontrado >> "%LOG%"
if not defined PSQL goto :eof

REM 0) PRECHECK: el runner responde? Si no, salir rapido (se reintenta al reconectar).
%PSQL% -d "%DST%" -tAc "select 1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] OFFLINE: runner 192.168.0.222 no alcanzable; se reintenta al reconectar >> "%LOG%"
  goto :eof
)
echo [%date% %time%] --- ONLINE, push %TRUCK% (serie %ROUTE_SERIE%) --- >> "%LOG%"

REM ===========================================================================
REM  BLOQUE 1 — VENTAS
REM  Si la base tiene VARIAS rutas, el filtro por %ROUTE_SERIE% es OBLIGATORIO
REM  (si no, doble conteo). Verificar la serie con:
REM    %PSQL% -d "%SRC%" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
REM ===========================================================================
%PSQL% -d "%DST%" -c "delete from ingest.route_sales_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% -d "%SRC%" -c "\copy (select '%TRUCK%',h.c1,h.c6,h.c9::date,h.c10,d.c8,d.c10,d.c11,d.c9::numeric,d.c12::numeric,d.c13::numeric from md.kdm2 d join md.kdm1 h on h.c1=d.c1 and h.c2=d.c2 and h.c3=d.c3 and h.c4=d.c4 and h.c5=d.c5 and h.c6=d.c6 where d.c2='U' and d.c3='D' and h.c4=10 and rtrim(btrim(h.c63),'-')='%ROUTE_SERIE%' and h.c9>=current_date-%DAYS%) to stdout csv" | %PSQL% -d "%DST%" -c "\copy ingest.route_sales_stg (truck,almacen,folio,fecha,forma_pago,sku,producto,unidad,cantidad,precio_neto,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge ventas -^> filas: >> "%LOG%"
%PSQL% -d "%DST%" -c "select ingest.merge_route_sales('%TRUCK%', %DAYS%)" >> "%LOG%" 2>&1

REM ===========================================================================
REM  BLOQUE 2 — EXISTENCIA  [RD.32]
REM  Kepler CENTRAL no publica saldo de ruta; el Kepler DE ESTA LAPTOP si.
REM  Columnas verificadas contra el ODS, NO adivinadas:
REM    kdii.c1=SKU  kdii.c2=descripcion  kdii.c11=unidad
REM    kdik.c2=SKU  kdik.c5=existencia   kdik.c16=costo
REM  OJO: existencia > 0 (el catalogo trae miles en cero) y es una FOTO del
REM  momento: el merge REEMPLAZA la del dia, no acumula.
REM ===========================================================================
%PSQL% -d "%DST%" -c "delete from ingest.route_stock_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% -d "%SRC%" -c "\copy (select '%TRUCK%',btrim(k.c2),btrim(i.c2),btrim(i.c11),k.c5::numeric,k.c16::numeric,(k.c5*k.c16)::numeric from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0) to stdout csv" | %PSQL% -d "%DST%" -c "\copy ingest.route_stock_stg (truck,sku,producto,unidad,existencia,costo,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge existencia -^> filas: >> "%LOG%"
%PSQL% -d "%DST%" -c "select ingest.merge_route_stock('%TRUCK%')" >> "%LOG%" 2>&1

REM ===========================================================================
REM  BLOQUE 3 — COBROS UA0501  [RC.2]
REM
REM  El push mandaba VENTAS y EXISTENCIA, no COBROS, y por eso la Fase CSU midio
REM  1.5% cobrado sobre $4.53M de cortes POS: los cortes UD2301 se ven y el cobro
REM  UA0501 que los salda se captura aca y nunca salia.
REM
REM  ⛔⛔ EL FILTRO DE ALMACEN NO ES OPCIONAL. Medido en ruta_27 el 2026-10-12:
REM      md.kdm1  almacen 00      16,641 cobros  <- CEDIS, ajenos
REM               almacen 01-005       9 cobros  <- lo propio de esta camioneta
REM  Sin `btrim(h.c1)=<almacen propio>` esto mandaria 16,641 cobros ajenos Y
REM  DUPLICADOS (ya llegan a prod por el ODS desde md_00). El almacen se deriva
REM  del nombre de la base: md_01-005 -> 01-005.
REM
REM  ⚠️ c63 NO sirve para filtrar: vale 'UA0501' en los 16,650 -- es la SERIE.
REM
REM  El grano es la APLICACION (cobro x corte), no el encabezado: es N:M de
REM  verdad -- un cobro se parte entre cortes y un corte recibe varios cobros.
REM  Guardar solo la cabecera daria el total sin poder decir QUE corte quedo
REM  saldado, que es justo lo que se necesita.
REM
REM  ⚠️ Todo con btrim(x::text): los tipos estan mezclados y asumir uno rompe el
REM  JOIN EN SILENCIO -- devolveria cero filas, que se lee igual que "no hay".
REM
REM  NO se filtra por cuenta: van los de caja (0011) y los de banco (2169). La
REM  cuenta viaja en su columna y se separa del otro lado.
REM ===========================================================================
%PSQL% -d "%DST%" -v ON_ERROR_STOP=1 -c "DELETE FROM ingest.route_collections_stg WHERE truck='%TRUCK%'" 2>>"%LOG%"

%PSQL% -d "%SRC%" -v ON_ERROR_STOP=1 -c "\copy (select '%TRUCK%', btrim(h.c1::text), btrim(h.c6::text), h.c9::date, btrim(h.c45::text), btrim(a.c8::text)||'-'||btrim(a.c9::text)||'-'||btrim(a.c10::text), btrim(a.c11::text), a.c12::numeric, btrim(a.c14::text) from md.kdm5 a join md.kdm1 h on btrim(h.c1::text)=btrim(a.c1::text) and btrim(h.c2::text)=btrim(a.c2::text) and btrim(h.c3::text)=btrim(a.c3::text) and btrim(h.c4::text)=btrim(a.c4::text) and btrim(h.c5::text)=btrim(a.c5::text) and btrim(h.c6::text)=btrim(a.c6::text) where btrim(a.c2::text)='U' and btrim(a.c3::text)='A' and btrim(a.c4::text)='5' and btrim(h.c1::text)=regexp_replace(current_database(),'^md_','') and h.c9 >= current_date - %DAYS%) to stdout csv" | %PSQL% -d "%DST%" -v ON_ERROR_STOP=1 -c "\copy ingest.route_collections_stg (truck,almacen,cobro_folio,fecha,cuenta,doc_tipo,folio_corte,importe,referencia) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge cobros -^> filas: >> "%LOG%"
%PSQL% -d "%DST%" -tAc "SELECT ingest.merge_route_collections('%TRUCK%')" >> "%LOG%" 2>&1

echo [%date% %time%] OK %TRUCK% >> "%LOG%"

endlocal
