-- =============================================================================
-- [RC.1] Lado RUNNER del push de COBROS de ruta. Corre UNA vez en
--        `kepler_consolidado` (192.168.0.222:5433). ADITIVO: no toca nada vivo.
--
-- Por que existe
-- -------------
-- El push de camioneta ya empuja VENTAS (`mart.ventas`), EXISTENCIA
-- (`mart.existencias_ruta`) y MOVIMIENTOS. No empuja COBROS.
--
-- Y eso explica un numero que ya estaba medido y sin explicacion: la Fase CSU
-- midio **1.5% cobrado** sobre $4.53M de cortes de caja POS (1-5 oct). Los cortes
-- `UD2301` viven en la base de la plaza y se ven; el cobro `UA0501` que los salda
-- se captura en el Kepler LOCAL de la camioneta (`//127.0.0.1/cobro.kpl`,
-- "Movil 005 de Suc 01") y nunca sale de ahi. No es que no cobren: es que el
-- cobro no viaja.
--
-- El grano: UNA FILA POR APLICACION, no por cobro
-- -----------------------------------------------
-- Un cobro salda VARIOS cortes (en la pantalla real: `UA0501-0000010` saldaba
-- `UD2301-0000007/8/9`). Lo que salda es la APLICACION, no el encabezado, asi que
-- la fila es (cobro x corte). Guardar solo el encabezado daria el total cobrado
-- sin poder decir QUE corte quedo saldado -- que es justo lo que se necesita.
--
-- Decodificado contra el ODS **y contra la pantalla**, no supuesto:
--   kdm5.c2-c6  = el COBRO            (U-A-5-1 folio)
--   kdm5.c7-c11 = el DOCUMENTO SALDADO (1-D-23-1 folio = el corte de caja POS)
--   kdm5.c12    = importe aplicado
--   kdm5.c14    = referencia de caja  ('Caja 1-95')
-- Verificado: en `kepler_ods.kdm5` sucursal '01', `U-A-5-1 0000095` salda
-- `1-D-23-1 0000053` por $28,204.50 con referencia `Caja 4-94`; en la pantalla de
-- la camioneta el mismo shape con `Caja 1-95/96/97`.
--
-- ⚠️ La ventana la BORRA por fecha presente en el lote, igual que ventas: no una
-- ventana fija. Si la laptop purga y retiene poco, no se pierde lo ya acumulado.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS ingest;

CREATE TABLE IF NOT EXISTS ingest.route_collections_stg (
  truck        text NOT NULL,
  almacen      text,
  cobro_folio  text,          -- UA0501-xxxxxxx (kdm1.c6)
  fecha        date,          -- kdm1.c9
  cuenta       text,          -- kdm1.c45: cuenta de tesoreria. '0011' = Caja General; otra = banco.
  doc_tipo     text,          -- el documento saldado, armado: c8-c9-c10 (ej. 'D-23-1')
  folio_corte  text,          -- kdm5.c11: folio del corte UD2301
  importe      numeric,       -- kdm5.c12
  referencia   text,          -- kdm5.c14: 'Caja 1-95'
  _loaded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_route_cob_stg_truck ON ingest.route_collections_stg(truck);

CREATE TABLE IF NOT EXISTS mart.cobros_ruta (
  truck        text NOT NULL,
  almacen      text,
  cobro_folio  text NOT NULL,
  fecha        date NOT NULL,
  cuenta       text,
  doc_tipo     text,
  folio_corte  text NOT NULL,
  importe      numeric,
  referencia   text,
  _merged_at   timestamptz NOT NULL DEFAULT now(),
  -- La llave natural: un cobro aplica UNA vez a un corte. Si el mismo lote vuelve,
  -- reescribe el mismo valor en vez de duplicar el dinero.
  PRIMARY KEY (truck, cobro_folio, folio_corte)
);
CREATE INDEX IF NOT EXISTS ix_cobros_ruta_fecha ON mart.cobros_ruta(fecha);
CREATE INDEX IF NOT EXISTS ix_cobros_ruta_corte ON mart.cobros_ruta(folio_corte);

CREATE TABLE IF NOT EXISTS ingest.route_collections_heartbeat (
  truck      text PRIMARY KEY,
  last_ok    timestamptz,
  rows_last  bigint,
  valor_last numeric,
  last_run   timestamptz,
  client_ip  inet
);

-- SECURITY DEFINER: el rol `ingest` (least-privilege) no toca mart directo.
CREATE OR REPLACE FUNCTION ingest.merge_route_collections(p_truck text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = mart, ingest, public AS $fn$
DECLARE n bigint; v numeric;
BEGIN
  -- Borra SOLO las fechas presentes en el lote (no una ventana fija).
  DELETE FROM mart.cobros_ruta c
   USING (SELECT DISTINCT fecha FROM ingest.route_collections_stg WHERE truck = p_truck) b
   WHERE c.truck = p_truck AND c.fecha = b.fecha;

  INSERT INTO mart.cobros_ruta (truck, almacen, cobro_folio, fecha, cuenta, doc_tipo, folio_corte, importe, referencia)
  SELECT p_truck, btrim(s.almacen), btrim(s.cobro_folio), s.fecha, btrim(s.cuenta),
         btrim(s.doc_tipo), btrim(s.folio_corte), sum(s.importe), btrim(s.referencia)
    FROM ingest.route_collections_stg s
   WHERE s.truck = p_truck
     AND s.fecha IS NOT NULL
     AND coalesce(btrim(s.cobro_folio),'') <> ''
     AND coalesce(btrim(s.folio_corte),'') <> ''
   GROUP BY 1,2,3,4,5,6,7,9
  ON CONFLICT (truck, cobro_folio, folio_corte) DO UPDATE
     SET importe = excluded.importe, fecha = excluded.fecha, cuenta = excluded.cuenta,
         doc_tipo = excluded.doc_tipo, referencia = excluded.referencia, _merged_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT coalesce(sum(importe),0) INTO v FROM mart.cobros_ruta WHERE truck = p_truck;

  DELETE FROM ingest.route_collections_stg WHERE truck = p_truck;

  -- ⚠️ El latido va ACA y no en el .cmd: si lo escribiera el agente, un push que
  -- sube cero filas igual diria "ok". Escrito por el merge, mide ENTREGA.
  INSERT INTO ingest.route_collections_heartbeat (truck, last_ok, rows_last, valor_last, last_run, client_ip)
       VALUES (p_truck, now(), n, v, now(), inet_client_addr())
  ON CONFLICT (truck) DO UPDATE
     SET last_ok = excluded.last_ok, rows_last = excluded.rows_last,
         valor_last = excluded.valor_last, last_run = excluded.last_run,
         client_ip = COALESCE(excluded.client_ip, ingest.route_collections_heartbeat.client_ip);
  RETURN n;
END; $fn$;

GRANT USAGE ON SCHEMA ingest TO ingest;
GRANT INSERT, DELETE, SELECT ON ingest.route_collections_stg TO ingest;
GRANT EXECUTE ON FUNCTION ingest.merge_route_collections(text) TO ingest;
