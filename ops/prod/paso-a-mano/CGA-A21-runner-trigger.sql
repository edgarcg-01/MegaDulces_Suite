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
