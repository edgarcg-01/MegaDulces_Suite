-- Consolidación de VENTA real por sucursal (kepler_consolidado @ on-prem localhost:5433).
-- Llena mart.ventas por dblink desde las 6 sucursales Kepler (dim.sucursales).
--
-- 🔴 FIX 2026-07-01 — DOBLE CONTEO ×2:
--   La versión previa filtraba `d.c2='U' AND d.c3='D'` SIN restringir c4, así que
--   por cada venta traía DOS documentos: el movimiento de almacén (c4=6) Y la
--   venta (c4=10) — casi gemelos. Resultado: mart.ventas → sales_daily → Sell-Out
--   y Command Center inflados ~2× (verificado: 8 Esquinas junio Hershey nuestro
--   $206,358 vs Kepler $110,824.79; por SKU c4=10 cuadra al centavo con el ERP).
--   VENTA real = c2='U' AND c3='D' AND c4=10 (única, ver import-product-sales-monthly.js).
--   FIX: agregar `AND h.c4=10` al WHERE del remote_sql en AMBAS funciones.
--
-- Tras aplicar: rebuild con `SELECT * FROM mart.refresh_ventas(<días que cubran el
-- período afectado>)` y re-correr `import-sales-fact.js` para propagar a prod.
--
-- ⭐ K.3 2026-09-08 — COBERTURA: el fact sólo contaba el TICKET (U-D-10) y dejaba fuera
--   dos doctypes de VENTA que Kepler sí entrega. Medido contra prod (90 d, anti-réplica
--   `btrim(c1)=sucursal`, `kepler_ods.kdm2`):
--       U-D-10  670,776 renglones  $44,758,538   <- lo único que entraba
--       U-D-8    15,266 renglones  $14,580,181   Factura Telemarketing  (= MAYOREO)
--       U-D-12    6,305 renglones   $1,491,784   Factura Cont No Fiscal
--   La brecha era $16,071,965 / 90 d (+31% sobre el ticket). Es el MISMO corte que
--   `analytics.mv_kepler_sales_daily` (8/10/12), así que el fact y el sell-out dejan de
--   contradecirse. `U-D-6` (Factura global) queda FUERA a propósito: re-factura los
--   tickets de U-D-10 en 93.1% de los pares (SKU,día) → sumarla duplicaría.
--
--   Y por qué la tabla gana `doctype`: `mart.ventas` NO llevaba el tipo de documento, y
--   `mart.ventas_enriched` deriva el canal SÓLO de `forma_pago` (= kdm1.c10). Medido: el
--   100% de U-D-8 ($14.58M) cae en `credito` por esa regla — la etiqueta `TI%`→mayoreo
--   NUNCA se dispara con esta data. Sin la columna, arreglar el total habría inflado el
--   crédito publicado de $10.9M a $25.5M (+133%): un número correcto pagado con otro
--   número falso. Con el doctype, U-D-8 va a `mayoreo` como en el matview.
--   La columna va AL FINAL y es NULLABLE a propósito: hay un escritor FUERA de este repo
--   (las filas `ruta_NN` del push de camionetas de .249) y un INSERT posicional corto
--   sigue siendo válido en Postgres (verificado) → esas filas llegan con doctype NULL y
--   el CASE de la vista cae en la rama de siempre. Cero cambio para ellas.

-- Idempotente. La columna es aditiva y va al final (ver nota K.3 arriba).
ALTER TABLE mart.ventas ADD COLUMN IF NOT EXISTS doctype smallint;
COMMENT ON COLUMN mart.ventas.doctype IS
  'K.3: kdm1.c4 — 10=Ticket Contado, 8=Factura Telemarketing (mayoreo), 12=Factura Cont No Fiscal. NULL = fila de un escritor que no lo informa (push de rutas .249).';

CREATE OR REPLACE FUNCTION mart._refresh_one(p_db text, p_days integer)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE
  r record; n bigint; v_cut date := current_date - p_days;
  conninfo text; remote_sql text;
BEGIN
  SELECT host, port, dbname INTO r FROM dim.sucursales WHERE db = p_db;
  conninfo := format('host=%s port=%s dbname=%s user=platform_ro password=kepler123', r.host, r.port, r.dbname);
  remote_sql := format($q$
    SELECT h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric, h.c4::int
    FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
    WHERE d.c2='U' AND d.c3='D' AND h.c4 IN (8,10,12) AND h.c9 >= %L
      AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(d.c10) <> ''
  $q$, v_cut);
  EXECUTE format('DELETE FROM mart.ventas WHERE sucursal=%L AND fecha >= %L', p_db, v_cut);
  -- Lista de columnas EXPLÍCITA (K.3): el `SELECT %L, t.*` posicional se rompía al agregar
  -- `doctype`, y peor, un día una columna nueva en otro orden lo habría desalineado en silencio.
  EXECUTE format($i$ INSERT INTO mart.ventas
      (sucursal, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe, doctype)
      SELECT %L, t.* FROM dblink(%L,%L) AS t(
      almacen text, folio text, fecha date, forma_pago text, sku text, producto text, unidad text,
      cantidad numeric, precio_neto numeric, importe numeric, doctype int) $i$, p_db, conninfo, remote_sql);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END; $function$;

CREATE OR REPLACE FUNCTION mart.refresh_ventas(p_days integer DEFAULT 7)
 RETURNS TABLE(sucursal text, filas_cargadas bigint)
 LANGUAGE plpgsql
AS $function$
DECLARE
  r record; n bigint; total bigint := 0;
  v_cut date := current_date - p_days;   -- corte ABSOLUTO, igual para DELETE y remoto
  conninfo text; remote_sql text;
BEGIN
  FOR r IN SELECT db, host, port, dbname FROM dim.sucursales ORDER BY db LOOP
    conninfo := format('host=%s port=%s dbname=%s user=platform_ro password=kepler123', r.host, r.port, r.dbname);
    remote_sql := format($q$
      SELECT h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric, h.c4::int
      FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
      WHERE d.c2='U' AND d.c3='D' AND h.c4 IN (8,10,12) AND h.c9 >= %L
        AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(d.c10) <> ''
    $q$, v_cut);
    -- RESILIENCIA (2026-08-10): sub-bloque BEGIN..EXCEPTION = savepoint por sucursal.
    -- Si una tienda está caída (dblink "could not connect"), se OMITE y el loop sigue con
    -- las demás. El DELETE vive dentro del mismo bloque → en el rollback del savepoint la
    -- sucursal conserva su ventana previa (no queda vacía). Antes: una tienda caída abortaba
    -- TODA la consolidación → todas las sucursales quedaban sin refrescar.
    BEGIN
      EXECUTE format('DELETE FROM mart.ventas WHERE sucursal=%L AND fecha >= %L', r.db, v_cut);
      EXECUTE format($i$ INSERT INTO mart.ventas
          (sucursal, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe, doctype)
          SELECT %L, t.* FROM dblink(%L,%L) AS t(
          almacen text, folio text, fecha date, forma_pago text, sku text, producto text, unidad text,
          cantidad numeric, precio_neto numeric, importe numeric, doctype int) $i$, r.db, conninfo, remote_sql);
      GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
      sucursal := r.db; filas_cargadas := n; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'refresh_ventas: omito sucursal % (%): %', r.db, r.host, SQLERRM;
      sucursal := r.db; filas_cargadas := -1; RETURN NEXT;  -- -1 = omitida (caída), conserva datos previos
    END;
  END LOOP;
  INSERT INTO mart.refresh_log(dias, filas) VALUES (p_days, total);
END; $function$;
