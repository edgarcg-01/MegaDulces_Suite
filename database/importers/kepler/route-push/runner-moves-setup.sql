-- `[RD.35]` El TERCER TESTIGO: los movimientos del camion, abiertos por tipo de documento.
--
-- Por que existe, medido el 2026-10-06 con las 10 camionetas empujando su foto:
--
--   foto                    $505,153.32   (el kardex de la van)
--   reconstruccion NETA     $120,651.48   (carga U-D-41 menos el push de tickets)
--   Δ                       $384,501.84   -- cierra al centavo, pero ALGEBRAICAMENTE
--
-- La descomposicion dice *cuanto* y *donde*, no *por que documento*. El kardex de la
-- camioneta tiene movimientos que el ledger NO modela -- medido en la ruta 27:
-- `N-A-30` (ajuste entrada), `X-D-40` (devolucion compra), `U-A-25`, `N-D-5`, `N-D-30`.
-- La reconstruccion solo conoce `U-D-41` y el ticket. Con esta tabla, cada peso de la
-- brecha queda con un tipo de documento pegado.
--
-- ⚠️ Es ingesta CRUDA: aca no se interpreta nada. La plataforma deriva.
-- ⚠️ El doctype es `c4-c5-c6` (genero - naturaleza - numero) del propio `md.kdij`.
--    `c5='A'` entra, `c5='D'` sale. NO se confia en el signo de `c11`: viene sin signo.
--
-- Aplicar UNA vez contra el runner (kepler_consolidado).

CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS mart;

CREATE TABLE IF NOT EXISTS ingest.route_moves_stg (
  truck     text,
  sku       text,
  unidad    text,
  doctype   text,
  entradas  numeric,
  salidas   numeric,
  docs      integer,
  primera   date,
  ultima    date
);
COMMENT ON TABLE ingest.route_moves_stg IS
  '[RD.35] Zona de aterrizaje del resumen de movimientos por doctype. La vacia merge_route_moves.';

CREATE TABLE IF NOT EXISTS mart.movimientos_ruta (
  truck       text    NOT NULL,
  corte       date    NOT NULL,
  sku         text    NOT NULL,
  unidad      text    NOT NULL,
  doctype     text    NOT NULL,
  entradas    numeric NOT NULL DEFAULT 0,
  salidas     numeric NOT NULL DEFAULT 0,
  docs        integer NOT NULL DEFAULT 0,
  primera     date,
  ultima      date,
  _updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (truck, corte, sku, unidad, doctype)
);
COMMENT ON TABLE mart.movimientos_ruta IS
  '[RD.35] Lo que ENTRO y SALIO de cada camion, por SKU y por tipo de documento. El tercer testigo del inventario de ruta: permite atribuir la brecha foto-vs-reconstruccion a documentos en vez de dejarla declarada.';

CREATE INDEX IF NOT EXISTS ix_movimientos_ruta_doctype
  ON mart.movimientos_ruta (truck, corte, doctype);

CREATE TABLE IF NOT EXISTS ingest.route_moves_heartbeat (
  truck      text PRIMARY KEY,
  last_ok    timestamptz,
  last_run   timestamptz,
  rows_last  bigint,
  client_ip  inet
);

-- La foto de movimientos REEMPLAZA la del dia: el corte es (truck, corte).
CREATE OR REPLACE FUNCTION ingest.merge_route_moves(p_truck text) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE
  n   bigint;
  hoy date := (now() AT TIME ZONE 'America/Mexico_City')::date;
BEGIN
  DELETE FROM mart.movimientos_ruta WHERE truck = p_truck AND corte = hoy;

  INSERT INTO mart.movimientos_ruta
         (truck, corte, sku, unidad, doctype, entradas, salidas, docs, primera, ultima)
  SELECT p_truck, hoy, btrim(s.sku), upper(btrim(s.unidad)), upper(btrim(s.doctype)),
         sum(s.entradas), sum(s.salidas), sum(s.docs), min(s.primera), max(s.ultima)
    FROM ingest.route_moves_stg s
   WHERE s.truck = p_truck
     AND coalesce(btrim(s.sku),'')     <> ''
     AND coalesce(btrim(s.unidad),'')  <> ''
     AND coalesce(btrim(s.doctype),'') <> ''
   GROUP BY 1,2,3,4,5;
  GET DIAGNOSTICS n = ROW_COUNT;

  DELETE FROM ingest.route_moves_stg WHERE truck = p_truck;

  INSERT INTO ingest.route_moves_heartbeat (truck, last_ok, last_run, rows_last, client_ip)
       VALUES (p_truck, now(), now(), n, inet_client_addr())
  ON CONFLICT (truck) DO UPDATE
     SET last_ok = excluded.last_ok, last_run = excluded.last_run,
         rows_last = excluded.rows_last,
         client_ip = COALESCE(excluded.client_ip, ingest.route_moves_heartbeat.client_ip);

  RETURN n;
END;
$fn$;

-- El rol que lee desde prod por FDW ([RD.34]) necesita ver tambien esta tabla.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prod_fdw_ro') THEN
    GRANT SELECT ON mart.movimientos_ruta TO prod_fdw_ro;
  END IF;
END $$;
