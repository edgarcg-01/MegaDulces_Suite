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
    SELECT h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric
    FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
    WHERE d.c2='U' AND d.c3='D' AND h.c4=10 AND h.c9 >= %L
      AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(d.c10) <> ''
  $q$, v_cut);
  EXECUTE format('DELETE FROM mart.ventas WHERE sucursal=%L AND fecha >= %L', p_db, v_cut);
  EXECUTE format($i$ INSERT INTO mart.ventas SELECT %L, t.* FROM dblink(%L,%L) AS t(
      almacen text, folio text, fecha date, forma_pago text, sku text, producto text, unidad text,
      cantidad numeric, precio_neto numeric, importe numeric) $i$, p_db, conninfo, remote_sql);
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
      SELECT h.c1, h.c6, h.c9::date, h.c10, d.c8, d.c10, d.c11, d.c9::numeric, d.c12::numeric, d.c13::numeric
      FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
      WHERE d.c2='U' AND d.c3='D' AND h.c4=10 AND h.c9 >= %L
        AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(d.c10) <> ''
    $q$, v_cut);
    EXECUTE format('DELETE FROM mart.ventas WHERE sucursal=%L AND fecha >= %L', r.db, v_cut);
    EXECUTE format($i$ INSERT INTO mart.ventas SELECT %L, t.* FROM dblink(%L,%L) AS t(
        almacen text, folio text, fecha date, forma_pago text, sku text, producto text, unidad text,
        cantidad numeric, precio_neto numeric, importe numeric) $i$, r.db, conninfo, remote_sql);
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    sucursal := r.db; filas_cargadas := n; RETURN NEXT;
  END LOOP;
  INSERT INTO mart.refresh_log(dias, filas) VALUES (p_days, total);
END; $function$;
