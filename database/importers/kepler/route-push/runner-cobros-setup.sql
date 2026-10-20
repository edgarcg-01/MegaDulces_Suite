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


-- =============================================================================
-- [CGA-A.21] EL MERGE DEJA DE SER UN PASO QUE ALGUIEN PUEDE SALTEAR.
--
-- Por que, medido el 2026-10-19 (GOTCHAS §87)
-- -------------------------------------------
-- La ruta 27 entrego su dia -- 27 filas en `stg`, fecha 19-oct, 27 de 27 validas
-- para los filtros del merge -- y el merge NUNCA corrio sobre ese lote. El dato
-- quedo en la bandeja y en la suite no existio. Los dos latidos del carril
-- estaban VERDES, porque los dos estan del mismo lado del corte.
--
-- El `.cmd` de cada camioneta hace tres cosas: DELETE de su rebanada, \copy, y
-- `SELECT merge_route_collections(...)`. Si la tercera no corre -- la maquina se
-- apaga, la red se cae, alguien cierra la ventana -- no hay error en ningun lado.
--
-- La solucion no es vigilar mejor el tercer paso: es que no exista.
-- El `\copy` MISMO dispara el merge. Un paso que no existe no se puede saltear.
--
-- Lo que NO cambia
-- ----------------
-- * El `.cmd` desplegado en las 11 camionetas se deja como esta. Su llamada al
--   merge pasa a ser redundante, y es inofensiva (ver abajo).
-- * El grano, los filtros y el latido siguen siendo los mismos.
-- =============================================================================

-- ⛔ PRIMERO el arreglo que hace inofensiva la llamada redundante del `.cmd`.
--
-- Con el disparador puesto, cuando el `.cmd` llame al merge la bandeja YA va a
-- estar vacia. El merge de antes igual escribia el latido -- con `rows_last = 0` --
-- o sea que PISABA un latido bueno con un cero que se lee como fallo. Ahora sale
-- antes de tocar nada si no hay nada que mezclar.
--
-- ⭐ Y se agrega `rows_pendientes`, que es lo que §87 dice que faltaba: un latido
-- que no publica lo que quedo SIN consumir no puede medir entrega.
ALTER TABLE ingest.route_collections_heartbeat
  ADD COLUMN IF NOT EXISTS rows_pendientes integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION ingest.merge_route_collections(p_truck text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mart', 'ingest', 'public'
AS $function$
DECLARE n bigint; v numeric; pend integer;
BEGIN
  -- [CGA-A.21] Sin nada en la bandeja no hay merge, y sobre todo no hay latido:
  -- escribir `rows_last = 0` aca pisaria el latido bueno del disparador.
  PERFORM 1 FROM ingest.route_collections_stg WHERE truck = p_truck LIMIT 1;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

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

  -- ⭐ [CGA-A.21] Lo que quedo SIN consumir, en la misma escritura que el "ok".
  -- Con los filtros de arriba esto deberia ser 0 siempre; si no lo es, el latido
  -- lo dice en vez de que haya que ir a mirar la bandeja. §87.
  SELECT count(*)::int INTO pend FROM ingest.route_collections_stg WHERE truck = p_truck;

  INSERT INTO ingest.route_collections_heartbeat (truck, last_ok, rows_last, valor_last, last_run, client_ip, rows_pendientes)
       VALUES (p_truck, now(), n, v, now(), inet_client_addr(), pend)
  ON CONFLICT (truck) DO UPDATE
     SET last_ok = excluded.last_ok, rows_last = excluded.rows_last,
         valor_last = excluded.valor_last, last_run = excluded.last_run,
         rows_pendientes = excluded.rows_pendientes,
         client_ip = COALESCE(excluded.client_ip, ingest.route_collections_heartbeat.client_ip);
  RETURN n;
END; $function$;

-- ── EL DISPARADOR ────────────────────────────────────────────────────────────
--
-- `AFTER INSERT ... FOR EACH STATEMENT`: un `COPY` dispara triggers de sentencia,
-- asi que el `\copy` del `.cmd` lo activa sin que el `.cmd` cambie una linea.
--
-- ⚠️ Recorre las camionetas presentes en la bandeja, NO una sola: un lote podria
-- traer mas de una, y asumir que trae una es la clase de supuesto que no avisa
-- cuando deja de ser cierto.
--
-- ⚠️ No hay recursion: el merge sobre `stg` solo hace DELETE, y este disparador
-- es de INSERT.
CREATE OR REPLACE FUNCTION ingest.tg_route_collections_stg_merge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'mart', 'ingest', 'public'
AS $function$
DECLARE t text;
BEGIN
  FOR t IN SELECT DISTINCT truck FROM ingest.route_collections_stg WHERE truck IS NOT NULL LOOP
    PERFORM ingest.merge_route_collections(t);
  END LOOP;
  RETURN NULL;
END; $function$;

DROP TRIGGER IF EXISTS tg_route_collections_stg_merge ON ingest.route_collections_stg;
CREATE TRIGGER tg_route_collections_stg_merge
  AFTER INSERT ON ingest.route_collections_stg
  FOR EACH STATEMENT
  EXECUTE FUNCTION ingest.tg_route_collections_stg_merge();


-- =============================================================================
-- [CGA-A.22] EL PERMISO QUE FALTABA PARA QUE PROD LEA ESTA TABLA EN VIVO.
--
-- Medido el 2026-10-19: el servidor FDW `runner_rutas` de prod entra con el rol
-- `prod_fdw_ro`, que YA tenia USAGE en `mart` y SELECT sobre `mart.existencias_ruta`
-- -- pero nadie le dio `mart.cobros_ruta` cuando se creo. El sintoma no es un
-- error de conexion sino:
--
--     ERROR: permission denied for table cobros_ruta
--     CONTEXT: remote SQL command: SELECT count(*) FROM mart.cobros_ruta
--
-- ⚠️ Es el tipo de hueco que no se ve hasta que alguien USA la tuberia: el
-- servidor existia desde antes con CERO tablas foraneas, asi que el permiso que
-- le faltaba nunca se ejercio.
-- =============================================================================
GRANT USAGE ON SCHEMA mart TO prod_fdw_ro;
GRANT SELECT ON mart.cobros_ruta TO prod_fdw_ro;
