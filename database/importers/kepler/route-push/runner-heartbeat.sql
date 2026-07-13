-- Lado RUNNER — HEARTBEAT del push de ruta. Aditivo sobre runner-ingest-setup.sql.
-- Aplicar UNA vez en kepler_consolidado (192.168.0.249:5433).
-- Da observabilidad: cada push exitoso deja su latido; un scanner central alerta
-- si una ruta lleva > N horas sin reportar (lo que faltaba cuando cayeron ruta_23/27).

CREATE SCHEMA IF NOT EXISTS ingest;

-- 1) Tabla de latidos (un renglon por camioneta).
CREATE TABLE IF NOT EXISTS ingest.route_push_heartbeat (
  truck      text PRIMARY KEY,
  last_ok    timestamptz NOT NULL,
  rows_last  bigint,
  last_run   timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT, UPDATE, SELECT ON ingest.route_push_heartbeat TO ingest;

-- 2) merge_route_sales con escritura de latido (idéntica a runner-ingest-setup.sql
--    + el UPSERT del heartbeat antes del RETURN). Sigue idempotente.
CREATE OR REPLACE FUNCTION ingest.merge_route_sales(p_truck text, p_days int DEFAULT 15)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mart, ingest, public AS $fn$
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
  INSERT INTO ingest.route_push_heartbeat (truck, last_ok, rows_last, last_run)
  VALUES (p_truck, now(), n, now())
  ON CONFLICT (truck) DO UPDATE
    SET last_ok = EXCLUDED.last_ok,
        rows_last = EXCLUDED.rows_last,
        last_run = EXCLUDED.last_run;

  RETURN n;
END; $fn$;

-- 3) Consulta de frescura (para el scanner/alerta central).
--    SELECT truck, last_ok, rows_last,
--           round(extract(epoch FROM now()-last_ok)/3600,1) AS horas_sin_reportar
--    FROM ingest.route_push_heartbeat
--    ORDER BY last_ok;
