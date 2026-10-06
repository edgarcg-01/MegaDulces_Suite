-- ============================================================================
--  [RD.32.2] Que la camioneta diga DONDE ESTA, sola, cada vez que empuja.
--  Corre en kepler_consolidado (192.168.0.222:5433). Aditivo.
--
--  ── El problema que resuelve ───────────────────────────────────────────────
--  Para tocar una laptop hay que encontrarla, y hoy eso sale de una tabla a
--  mano en INVENTARIO_Y_PLAN_RUTAS.md que el propio documento declara poco
--  confiable: son laptops que viajan y toman DHCP. Ya cobro una vez -- la IP
--  de `ruta_27` estaba mal y mando a alguien a la maquina equivocada. El
--  documento lo dice con todas sus letras: "una IP equivocada en una tabla de
--  control es peor que un hueco".
--
--  ⭐ Pero la van se conecta al runner cada 15 minutos. El runner YA SABE de
--  donde viene; solo no lo estaba anotando. `inet_client_addr()` dentro del
--  merge devuelve la direccion de ESA conexion, que es la de la van.
--
--  ⇒ Deja de haber una tabla que mantener: la flota se auto-inventaria.
--
--  ⚠️ Es la direccion DESDE LA QUE SE CONECTO, no una propiedad de la van: si
--  cambia de red cambia el dato, y eso es exactamente lo que se quiere. Por eso
--  viaja junto a `last_ok` -- una IP sin su fecha miente igual que la tabla.
-- ============================================================================

ALTER TABLE ingest.route_push_heartbeat  ADD COLUMN IF NOT EXISTS client_ip inet;
ALTER TABLE ingest.route_stock_heartbeat ADD COLUMN IF NOT EXISTS client_ip inet;

COMMENT ON COLUMN ingest.route_push_heartbeat.client_ip IS
  '[RD.32.2] Desde donde se conecto la camioneta en SU ultimo push. Se lee junto a last_ok: una IP sin fecha miente igual que una tabla a mano. NULL = todavia no empuja desde que existe la columna.';

-- Misma funcion que ya corria, con UNA linea mas. El resto se copia de la
-- definicion VIVA (pg_get_functiondef), no del archivo del repo: si alguien la
-- hubiera tocado en el servidor, reescribirla desde el repo lo borraria.
CREATE OR REPLACE FUNCTION ingest.merge_route_sales(p_truck text, p_days integer DEFAULT 15)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'mart','ingest','public'
AS $function$
DECLARE n bigint;
BEGIN
  DELETE FROM mart.ventas v
   USING (SELECT DISTINCT fecha FROM ingest.route_sales_stg WHERE truck=p_truck) b
   WHERE v.sucursal=p_truck AND v.fecha=b.fecha;
  INSERT INTO mart.ventas (sucursal, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe)
    SELECT truck, almacen, folio, fecha, forma_pago, sku, producto, unidad, cantidad, precio_neto, importe
    FROM ingest.route_sales_stg WHERE truck = p_truck;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM ingest.route_sales_stg WHERE truck = p_truck;

  -- Latido: solo se escribe si el merge llegó hasta aquí (push exitoso).
  INSERT INTO ingest.route_push_heartbeat (truck, last_ok, rows_last, last_run, client_ip)
  VALUES (p_truck, now(), n, now(), inet_client_addr())
  ON CONFLICT (truck) DO UPDATE
    SET last_ok = EXCLUDED.last_ok,
        rows_last = EXCLUDED.rows_last,
        last_run = EXCLUDED.last_run,
        -- COALESCE: si algun dia el merge se llamara desde un socket local
        -- (sin client_addr), no se pierde la ultima direccion conocida.
        client_ip = COALESCE(EXCLUDED.client_ip, ingest.route_push_heartbeat.client_ip);

  RETURN n;
END; $function$;

-- El de existencia, igual (nacio en runner-stock-setup.sql, se le agrega lo mismo).
CREATE OR REPLACE FUNCTION ingest.merge_route_stock(p_truck text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mart, ingest, public AS $fn$
DECLARE
  n   bigint;
  v   numeric;
  hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
BEGIN
  DELETE FROM mart.existencias_ruta WHERE truck = p_truck AND fecha = hoy;

  INSERT INTO mart.existencias_ruta (truck, fecha, sku, unidad, producto, existencia, costo, importe)
  SELECT p_truck, hoy, btrim(s.sku), upper(btrim(s.unidad)), s.producto,
         sum(s.existencia), max(s.costo), sum(s.importe)
    FROM ingest.route_stock_stg s
   WHERE s.truck = p_truck
     AND coalesce(btrim(s.sku),'') <> ''
     AND coalesce(btrim(s.unidad),'') <> ''
     AND s.existencia > 0
   GROUP BY 1,2,3,4,5;
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT coalesce(sum(importe),0) INTO v
    FROM mart.existencias_ruta WHERE truck = p_truck AND fecha = hoy;

  DELETE FROM ingest.route_stock_stg WHERE truck = p_truck;

  INSERT INTO ingest.route_stock_heartbeat (truck, last_ok, rows_last, valor_last, last_run, client_ip)
       VALUES (p_truck, now(), n, v, now(), inet_client_addr())
  ON CONFLICT (truck) DO UPDATE
     SET last_ok = excluded.last_ok, rows_last = excluded.rows_last,
         valor_last = excluded.valor_last, last_run = excluded.last_run,
         client_ip = COALESCE(excluded.client_ip, ingest.route_stock_heartbeat.client_ip);

  RETURN n;
END; $fn$;
