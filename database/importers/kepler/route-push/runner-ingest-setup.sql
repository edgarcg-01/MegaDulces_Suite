-- Lado RUNNER del push de ventas de ruta. Corre en kepler_consolidado (localhost:5433).
-- Aditivo. Recibe lo que empujan las camionetas (ingest.route_sales_stg) y lo mergea
-- a mart.ventas con sucursal='cam_XX' (overlap-reload idempotente) → entra al mismo
-- pipeline que las sucursales (→ import-sales-fact → sales_daily → Command Center).

CREATE SCHEMA IF NOT EXISTS ingest;

CREATE TABLE IF NOT EXISTS ingest.route_sales_stg (
  truck text NOT NULL, almacen text, folio text, fecha date, forma_pago text,
  sku text, producto text, unidad text, cantidad numeric, precio_neto numeric, importe numeric,
  _loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_route_stg_truck ON ingest.route_sales_stg(truck);

-- SECURITY DEFINER: el rol `ingest` (least-privilege) no toca mart.ventas directo;
-- solo llama esta función, que corre como owner.
-- Borra SOLO las fechas presentes en el lote (NO una ventana fija): así no pierde
-- datos ya acumulados si la PC de ruta purga/retiene poco (visto: md_01-003 tenía 3 días).
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
  RETURN n;
END; $fn$;

-- Rol de ingesta (least-privilege). Cambiar la clave por una real:
--   CREATE ROLE ingest LOGIN PASSWORD '***';   (o ALTER ROLE ingest PASSWORD '***';)
GRANT CONNECT ON DATABASE kepler_consolidado TO ingest;
GRANT USAGE ON SCHEMA ingest TO ingest;
GRANT INSERT, DELETE, SELECT ON ingest.route_sales_stg TO ingest;
GRANT EXECUTE ON FUNCTION ingest.merge_route_sales(text,int) TO ingest;
