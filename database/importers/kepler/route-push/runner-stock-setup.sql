-- ============================================================================
--  [RD.32] Lado RUNNER del push de EXISTENCIA de ruta.
--  Corre en kepler_consolidado (192.168.0.222:5433). Aditivo: calca el lado de
--  ventas (runner-ingest-setup.sql) y no toca nada de lo que ya existe.
--
--  ── Por qué, en una línea ──────────────────────────────────────────────────
--  Kepler central NO publica saldo de ruta (`kdik` sólo tiene una fila por
--  sucursal; los almacenes 01-00N no aparecen) y no existe documento de retorno,
--  así que el saldo del camión se venía RECONSTRUYENDO de embarque menos venta.
--  Medido el 2026-10-05 en la ruta 21: la pantalla publicaba 18,427 y el camión
--  traía 37,766 -- el 89% de la diferencia es mercancía que ya traía antes de
--  que pudiéramos ver sus ventas, y que ningún documento registra.
--
--  ⭐ Pero el Kepler DE LA CAMIONETA sí lo sabe: de ahí salió el archivo que
--  destapó todo esto. Y ya existe un canal que lo trae -- el mismo push que
--  sube la venta cada 15 minutos. No hace falta una pantalla para subir un
--  Excel: hace falta una segunda consulta en el agente que ya corre.
--
--  ── La diferencia con la venta, que es lo que hay que leer ─────────────────
--  ⛔ La venta ACUMULA; la existencia es una FOTO. Por eso el merge de acá
--  BORRA todo lo del par (truck, fecha) antes de insertar, en vez de agregar:
--  un producto que el camión ya no trae tiene que DESAPARECER de la foto, y un
--  merge aditivo lo dejaría vivo para siempre. Es el mismo criterio que hace
--  que un conteo resetee en vez de parchear.
--
--  ⚠️ La fecha la pone el RUNNER en hora de México, no el reloj de la laptop
--  de la camioneta: son once relojes que nadie sincroniza, y la fecha es parte
--  de la llave.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ingest;

-- Staging: lo que empuja cada camioneta. Se vacía tras el merge, igual que ventas.
CREATE TABLE IF NOT EXISTS ingest.route_stock_stg (
  truck       text NOT NULL,
  sku         text,
  producto    text,
  unidad      text,
  existencia  numeric,
  costo       numeric,
  importe     numeric,
  _loaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_route_stock_stg_truck ON ingest.route_stock_stg(truck);

-- Destino: una FOTO por camioneta y día. La PK impide que dos pushes del mismo
-- día se dupliquen, y la unidad va en la llave porque el mismo SKU se trae en
-- PZA y en PAQ y mezclarlos es el error que ADR-055/057 documentan.
CREATE TABLE IF NOT EXISTS mart.existencias_ruta (
  truck       text NOT NULL,
  fecha       date NOT NULL,
  sku         text NOT NULL,
  unidad      text NOT NULL,
  producto    text,
  existencia  numeric,
  costo       numeric,
  importe     numeric,
  _updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (truck, fecha, sku, unidad)
);
CREATE INDEX IF NOT EXISTS ix_existencias_ruta_fecha ON mart.existencias_ruta(fecha DESC, truck);

-- Latido propio: sin esto, un carril que deja de empujar se ve igual que uno
-- que empuja cero. Es la lección de ADR-053 -- el latido mide ENTREGA.
CREATE TABLE IF NOT EXISTS ingest.route_stock_heartbeat (
  truck      text PRIMARY KEY,
  last_ok    timestamptz,
  rows_last  bigint,
  valor_last numeric,
  last_run   timestamptz
);

CREATE OR REPLACE FUNCTION ingest.merge_route_stock(p_truck text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mart, ingest, public AS $fn$
DECLARE
  n   bigint;
  v   numeric;
  hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
BEGIN
  -- ⛔ Una foto REEMPLAZA. Borrar primero es lo que hace que un producto que el
  -- camion ya no trae desaparezca; sin esto la foto acumularia fantasmas.
  DELETE FROM mart.existencias_ruta WHERE truck = p_truck AND fecha = hoy;

  INSERT INTO mart.existencias_ruta (truck, fecha, sku, unidad, producto, existencia, costo, importe)
  SELECT p_truck, hoy, btrim(s.sku), upper(btrim(s.unidad)), s.producto,
         sum(s.existencia), max(s.costo), sum(s.importe)
    FROM ingest.route_stock_stg s
   WHERE s.truck = p_truck
     AND coalesce(btrim(s.sku),'') <> ''
     AND coalesce(btrim(s.unidad),'') <> ''
     -- Existencia cero NO es mercancia: el catalogo del camion trae miles de
     -- productos en 0 y subirlos todos los dias es ruido, no dato.
     AND s.existencia > 0
   GROUP BY 1,2,3,4,5;
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT coalesce(sum(importe),0) INTO v
    FROM mart.existencias_ruta WHERE truck = p_truck AND fecha = hoy;

  DELETE FROM ingest.route_stock_stg WHERE truck = p_truck;

  INSERT INTO ingest.route_stock_heartbeat (truck, last_ok, rows_last, valor_last, last_run)
       VALUES (p_truck, now(), n, v, now())
  ON CONFLICT (truck) DO UPDATE
     SET last_ok = excluded.last_ok, rows_last = excluded.rows_last,
         valor_last = excluded.valor_last, last_run = excluded.last_run;

  RETURN n;
END; $fn$;

GRANT USAGE ON SCHEMA ingest TO ingest;
GRANT INSERT, DELETE, SELECT ON ingest.route_stock_stg TO ingest;
GRANT EXECUTE ON FUNCTION ingest.merge_route_stock(text) TO ingest;

-- ============================================================================
--  ACEPTACIÓN -- se corre UNA vez, en UNA camioneta, antes de repartir a once.
--
--  La ruta 21 imprimió su existencia el 2026-10-05: 257 renglones, $37,765.58.
--  Si la consulta del agente está bien, esto lo reproduce:
--
--    SELECT count(*) AS renglones, round(sum(importe),2) AS importe
--      FROM mart.existencias_ruta WHERE truck='ruta_21' AND fecha='2026-10-05';
--    -- esperado: 257 | 37765.58   (±0.04 por redondeo de renglón)
--
--  ⚠️ Si NO cuadra, lo que está mal es la consulta del lado de la camioneta --
--  probablemente el peldaño de la unidad o el filtro de existencia. No se
--  reparte a las otras diez hasta que esta cuadre.
-- ============================================================================
