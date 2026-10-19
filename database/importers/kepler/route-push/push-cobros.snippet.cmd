REM ############################################################################
REM  ⛔⛔ RETIRADO el 2026-10-16 por `[CGA-A.12]`. NO SE PEGA MAS.
REM
REM  Este archivo existia para PEGARSE a mano «antes del endlocal», y ese
REM  mecanismo es el defecto: tres de los cuatro parches del 16-oct salieron de
REM  que cada camioneta es un archivo distinto que nadie valida. Uno de ellos
REM  fue justamente este bloque usando %SRC%/%DST% sobre maquinas que definen
REM  %LOCAL_CONN%/%RUNNER_CONN% -- y psql con una variable vacia NO GRITA.
REM
REM  El bloque de cobros ahora vive DENTRO de la plantilla unica, que se genera:
REM    node database/importers/kepler/route-push/armar-push-camioneta.js \
REM         --truck ruta_21 --serie UD1001 --salida push-ruta.cmd
REM
REM  Se conserva como referencia del razonamiento (el filtro de almacen, el
REM  grano N:M, por que c63 no sirve). Todo eso esta tambien en el generador.
REM ############################################################################
REM ===========================================================================
REM  [RC.2] LOS COBROS UA0501 DE LA CAMIONETA. Se PEGA en `push-ruta.cmd`,
REM  antes del `endlocal`, despues del bloque de existencia.
REM
REM  Por que: el push ya manda VENTAS, EXISTENCIA y MOVIMIENTOS. No manda COBROS,
REM  y por eso la Fase CSU midio 1.5% cobrado sobre $4.53M de cortes de caja POS.
REM  Los cortes `UD2301` estan en la base de la plaza y se ven; el cobro `UA0501`
REM  que los salda se captura aca y nunca salia.
REM
REM  ⛔⛔ EL FILTRO DE ALMACEN NO ES OPCIONAL. Medido en ruta_27 el 2026-10-12:
REM
REM      md.kdm1  almacen 00      16,641 cobros   <- CEDIS
REM               almacen 01-005       9 cobros   <- lo propio de esta camioneta
REM
REM  La base local arrastra el CEDIS entero. Sin `btrim(h.c1)=<almacen propio>`
REM  este push mandaria 16,641 cobros ajenos atribuidos a esta ruta, Y DUPLICADOS:
REM  esos mismos ya llegan a prod por el ODS desde `md_00`. Es la misma trampa que
REM  ya costo una vez en la contabilidad ("DB03 traia replicas 100% de la 02").
REM  El almacen se deriva del nombre de la base, igual que lo hace el bloque de
REM  existencia de este mismo archivo: md_01-005 -> 01-005.
REM
REM  ⚠️ `c63` NO sirve para filtrar: vale 'UA0501' en los 16,650 -- es la SERIE
REM  del documento, no la ruta (igual que ROUTE_SERIE=UD1001 en ventas).
REM
REM  El grano es la APLICACION (cobro x corte), no el encabezado. Medido:
REM      cobro 0000007 -> corte 0000006  $15,664.33
REM      cobro 0000007 -> corte 0000007  $ 4,342.67
REM      cobro 0000006 -> corte 0000006  $ 3,484.74
REM      cobro 0000008 -> corte 0000007  $10,417.00
REM  Es N:M de verdad: un cobro se parte entre cortes y un corte recibe varios
REM  cobros. Guardar solo la cabecera daria el total cobrado sin poder decir QUE
REM  corte quedo saldado -- que es justo lo que se necesita.
REM
REM  ⚠️ Todo va con `btrim(x::text)`: los tipos estan mezclados (kdm5.c4/c5/c7/c9/
REM  c12 son numeric; c1/c2/c3/c6/c8/c14 varchar) y asumir uno rompe el JOIN en
REM  silencio -- devolveria cero filas, que se lee igual que "no hay cobros".
REM
REM  NO se filtra por cuenta: van los de caja (0011, saldan cortes D-23-1) y los
REM  de banco (2169, saldan facturas D-13-1). La cuenta viaja en su columna y se
REM  separa del otro lado. Filtrar en el origen es perder dato sin poder revisarlo.
REM ===========================================================================
%PSQL% -d "%DST%" -v ON_ERROR_STOP=1 -c "DELETE FROM ingest.route_collections_stg WHERE truck='%TRUCK%'" 2>>"%LOG%"

%PSQL% -d "%SRC%" -v ON_ERROR_STOP=1 -c "\copy (select '%TRUCK%', btrim(h.c1::text), btrim(h.c6::text), h.c9::date, btrim(h.c45::text), btrim(a.c8::text)||'-'||btrim(a.c9::text)||'-'||btrim(a.c10::text), btrim(a.c11::text), a.c12::numeric, btrim(a.c14::text) from md.kdm5 a join md.kdm1 h on btrim(h.c1::text)=btrim(a.c1::text) and btrim(h.c2::text)=btrim(a.c2::text) and btrim(h.c3::text)=btrim(a.c3::text) and btrim(h.c4::text)=btrim(a.c4::text) and btrim(h.c5::text)=btrim(a.c5::text) and btrim(h.c6::text)=btrim(a.c6::text) where btrim(a.c2::text)='U' and btrim(a.c3::text)='A' and btrim(a.c4::text)='5' and btrim(h.c1::text)=regexp_replace(current_database(),'^md_','') and h.c9 >= current_date - %DAYS%) to stdout csv" | %PSQL% -d "%DST%" -v ON_ERROR_STOP=1 -c "\copy ingest.route_collections_stg (truck,almacen,cobro_folio,fecha,cuenta,doc_tipo,folio_corte,importe,referencia) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge cobros -^> filas: >> "%LOG%"
%PSQL% -d "%DST%" -tAc "SELECT ingest.merge_route_collections('%TRUCK%')" >> "%LOG%" 2>&1
