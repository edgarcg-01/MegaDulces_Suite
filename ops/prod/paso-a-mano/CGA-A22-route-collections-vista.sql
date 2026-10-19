-- =============================================================================
-- [CGA-A.22] analytics.route_collections pasa de TABLA a VISTA sobre el runner.
--            Equivalente en SQL de la migracion 20261019143732. Idempotente:
--            si ya es vista, no hace nada.
--
-- ⭐ La definicion de finance.v_caja_movimientos_pendientes NO se pega aca: se
--    CAPTURA de la base viva antes de soltarla y se vuelve a crear textual. Asi
--    no puede quedar desincronizada de lo que prod tiene hoy.
-- =============================================================================
DO $mig$
DECLARE
  def_pend text;
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

  -- Guarda 1: el servidor FDW existe. Sin esto la tabla foranea se crea igual y
  -- falla recien al leerla, o sea en la pantalla y no aca.
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = 'runner_rutas') THEN
    RAISE EXCEPTION '[A.22] no existe el servidor FDW runner_rutas. ABORTA.';
  END IF;

  -- La definicion VIVA de la vista dependiente, antes de soltar nada.
  SELECT pg_get_viewdef('finance.v_caja_movimientos_pendientes'::regclass, true)
    INTO def_pend;
  IF def_pend IS NULL OR length(def_pend) < 100 THEN
    RAISE EXCEPTION '[A.22] no se pudo capturar la definicion de la vista de la cola. ABORTA.';
  END IF;

  -- La tabla foranea.
  IF to_regclass('analytics.ft_cobros_ruta') IS NULL THEN
    EXECUTE 'IMPORT FOREIGN SCHEMA mart LIMIT TO (cobros_ruta) FROM SERVER runner_rutas INTO analytics';
    EXECUTE 'ALTER FOREIGN TABLE analytics.cobros_ruta RENAME TO ft_cobros_ruta';
  END IF;

  -- Guarda 2: el runner RESPONDE y no trae menos que la copia local. Un origen con
  -- menos filas que la copia es una perdida, no una migracion.
  EXECUTE 'SELECT count(*) FROM analytics.ft_cobros_ruta'   INTO n_rem;
  EXECUTE 'SELECT count(*) FROM analytics.route_collections' INTO n_loc;
  IF n_rem < n_loc THEN
    RAISE EXCEPTION '[A.22] el runner tiene % filas y la copia local %. Cambiar PERDERIA filas. ABORTA.',
      n_rem, n_loc;
  END IF;

  -- Postgres exige soltar el dependiente para soltar la tabla.
  EXECUTE 'DROP VIEW finance.v_caja_movimientos_pendientes';
  EXECUTE 'DROP TABLE analytics.route_collections';

  EXECUTE $v$
    CREATE VIEW analytics.route_collections AS
     SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
        f.truck, f.almacen, f.cobro_folio, f.fecha, f.cuenta, f.doc_tipo, f.folio_corte,
        f.importe, f.referencia,
        f._merged_at AS created_at,
        f._merged_at AS updated_at
       FROM analytics.ft_cobros_ruta f $v$;

  EXECUTE format('CREATE VIEW finance.v_caja_movimientos_pendientes AS %s', def_pend);

  -- Los GRANT no sobreviven a un DROP: sin esto las compuertas que leen prod quedan ciegas.
  EXECUTE 'GRANT SELECT ON analytics.route_collections TO dev_ro';
  EXECUTE 'GRANT SELECT ON finance.v_caja_movimientos_pendientes TO dev_ro';

  -- El carril deja de existir, su latido tambien. Si se dejara, cron_runs tendria
  -- para siempre un route_collections congelado: un carril fantasma que ningun
  -- tablero puede arreglar. Verificado: ningun componente lee ese job_key.
  DELETE FROM analytics.cron_runs WHERE job_key = 'route_collections';
  GET DIAGNOSTICS n_lat = ROW_COUNT;

  RAISE NOTICE '[A.22] listo: % filas en vivo (copia tenia %) · % latido(s) retirado(s)',
    n_rem, n_loc, n_lat;
END
$mig$;

-- Comprobacion: tiene que decir 'v' y traer las filas de HOY.
SELECT relkind AS tipo FROM pg_class WHERE oid = 'analytics.route_collections'::regclass;
SELECT truck, max(fecha) AS ultima, count(*) AS filas
  FROM analytics.route_collections GROUP BY 1 ORDER BY 2 DESC;
