-- =============================================================================
-- [CGA-A.22] analytics.route_collections pasa de TABLA a VISTA sobre el runner.
--            Equivalente en SQL de la migracion 20261019143732. Idempotente:
--            si ya es vista, no hace nada.
--
-- ⛔ LA CADENA DE DEPENDIENTES SON TRES NIVELES, NO UNO. El primer intento
--    (2026-10-19) fallo porque se habia medido solo el primer escalon:
--
--      analytics.route_collections              (tabla)
--        -> finance.v_caja_movimientos_pendientes   (vista)
--             -> analytics.mv_caja_autofill_entidad (MATVISTA)
--
--    Error literal: "cannot drop view ... because other objects depend on it".
--    Buscar los dependientes de una tabla y no los dependientes de SUS
--    dependientes es la forma de descubrir el tercer escalon en produccion.
--    Verificado con un recorrido RECURSIVO: son exactamente tres, nada mas alla.
--
-- ⭐ Las dos definiciones se CAPTURAN de la base viva antes de soltar nada, no se
--    pegan aca. Pegar una definicion a mano es como se desincronizan las cosas.
-- =============================================================================
DO $mig$
DECLARE
  def_pend text;
  def_mv   text;
  n_rem    bigint;
  n_loc    bigint;
  k        "char";
  n_lat    bigint;
BEGIN
  SELECT relkind INTO k FROM pg_class WHERE oid = 'analytics.route_collections'::regclass;
  IF k = 'v' THEN
    RAISE NOTICE '[A.22] route_collections ya es vista. Nada que hacer.';
    RETURN;
  END IF;

  -- Guarda 1: el servidor FDW existe.
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'runner_rutas') THEN
    RAISE EXCEPTION '[A.22] no existe el servidor FDW runner_rutas. ABORTA.';
  END IF;

  -- Las definiciones VIVAS de los dos dependientes, antes de soltar nada.
  SELECT pg_get_viewdef('finance.v_caja_movimientos_pendientes'::regclass, true) INTO def_pend;
  SELECT pg_get_viewdef('analytics.mv_caja_autofill_entidad'::regclass, true)    INTO def_mv;
  IF def_pend IS NULL OR length(def_pend) < 100 THEN
    RAISE EXCEPTION '[A.22] no se pudo capturar la vista de la cola. ABORTA.';
  END IF;
  IF def_mv IS NULL OR length(def_mv) < 100 THEN
    RAISE EXCEPTION '[A.22] no se pudo capturar la matvista del autollenado. ABORTA.';
  END IF;

  -- La tabla foranea.
  IF to_regclass('analytics.ft_cobros_ruta') IS NULL THEN
    EXECUTE 'IMPORT FOREIGN SCHEMA mart LIMIT TO (cobros_ruta) FROM SERVER runner_rutas INTO analytics';
    EXECUTE 'ALTER FOREIGN TABLE analytics.cobros_ruta RENAME TO ft_cobros_ruta';
  END IF;

  -- Guarda 2: el runner RESPONDE y no trae menos que la copia local.
  EXECUTE 'SELECT count(*) FROM analytics.ft_cobros_ruta'    INTO n_rem;
  EXECUTE 'SELECT count(*) FROM analytics.route_collections' INTO n_loc;
  IF n_rem < n_loc THEN
    RAISE EXCEPTION '[A.22] el runner tiene % filas y la copia local %. PERDERIA filas. ABORTA.',
      n_rem, n_loc;
  END IF;

  -- Se sueltan los TRES, de arriba hacia abajo.
  EXECUTE 'DROP MATERIALIZED VIEW analytics.mv_caja_autofill_entidad';
  EXECUTE 'DROP VIEW finance.v_caja_movimientos_pendientes';
  EXECUTE 'DROP TABLE analytics.route_collections';

  -- Y se recrean al reves.
  EXECUTE $v$
    CREATE VIEW analytics.route_collections AS
     SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
        f.truck, f.almacen, f.cobro_folio, f.fecha, f.cuenta, f.doc_tipo, f.folio_corte,
        f.importe, f.referencia,
        f._merged_at AS created_at,
        f._merged_at AS updated_at
       FROM analytics.ft_cobros_ruta f $v$;

  EXECUTE format('CREATE VIEW finance.v_caja_movimientos_pendientes AS %s', def_pend);
  EXECUTE format('CREATE MATERIALIZED VIEW analytics.mv_caja_autofill_entidad AS %s', def_mv);

  -- ⛔ Sin este indice unico, `REFRESH ... CONCURRENTLY` falla y el refrescador
  -- bloquea a los lectores. No es opcional.
  EXECUTE 'CREATE UNIQUE INDEX mv_caja_autofill_entidad_uq
             ON analytics.mv_caja_autofill_entidad USING btree (tenant_id, entidad_code)';

  -- Los GRANT no sobreviven a un DROP.
  EXECUTE 'GRANT SELECT ON analytics.route_collections TO dev_ro';
  EXECUTE 'GRANT SELECT ON finance.v_caja_movimientos_pendientes TO dev_ro';

  -- El carril deja de existir, su latido tambien.
  DELETE FROM analytics.cron_runs WHERE job_key = 'route_collections';
  GET DIAGNOSTICS n_lat = ROW_COUNT;

  RAISE NOTICE '[A.22] listo: % filas en vivo (copia tenia %) · % latido(s) retirado(s)',
    n_rem, n_loc, n_lat;
END
$mig$;

-- Comprobacion: 'v', las filas de HOY, y la matvista de vuelta con sus filas.
SELECT relkind AS tipo FROM pg_class WHERE oid = 'analytics.route_collections'::regclass;
SELECT truck, max(fecha) AS ultima, count(*) AS filas
  FROM analytics.route_collections GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*) AS autollenado_filas FROM analytics.mv_caja_autofill_entidad;
