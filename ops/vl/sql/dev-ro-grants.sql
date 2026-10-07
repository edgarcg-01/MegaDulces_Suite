-- ============================================================================
-- VL.10 — Lectura para DESARROLLO sobre el cluster de réplicas de `md`.
--
-- Se corre UNA VEZ POR BASE (los permisos de Postgres son por base, no por
-- cluster). El driver es ops/vl/dev-ro-setup.sh. Es IDEMPOTENTE: correrlo dos
-- veces no cambia nada.
--
-- Qué crea: el rol de GRUPO `dev_ro`, que no puede iniciar sesión y sólo existe
-- para cargar los permisos. Las personas son roles aparte que se hacen miembros
-- (ver dev-ro-persona.sql). Así, dar de alta a alguien es una línea, darlo de
-- baja es `DROP ROLE`, y nadie comparte credencial — que es exactamente lo que
-- salió mal con `app_runtime` en el cluster `.245` (GOTCHAS §24).
--
-- ⛔ LO QUE NO SE OTORGA, Y POR QUÉ IMPORTA
--
-- `kepler_consolidado` tiene 30 TABLAS FORÁNEAS (postgres_fdw, servidores
-- srv_md00..05) que apuntan a los POS de las sucursales, y las vistas `dic.*`
-- leen de ellas. Otorgarlas no sería "dar lectura": sería que cada consulta de
-- un dev **viaje por la LAN y golpee la caja de la sucursal**, que es la máquina
-- donde se cobra. Además el único `user mapping` que existe es el de `postgres`
-- (medido), así que un dev ni siquiera podría leerlas sin que se le cree uno.
--
-- El dato equivalente está LOCAL y más fresco: las réplicas `kepler_md_0X`,
-- schema `md`, que el CDC mantiene al segundo. Un dev que quiera `kdii` lee
-- `kepler_md_03.md.kdii`, no `kepler_consolidado.md_03.kdii`.
--
-- ⭐ La exclusión se decide POR PROPIEDAD, NO POR NOMBRE: se calcula qué
-- relaciones son foráneas y qué vistas dependen de ellas (recursivo), y se salta
-- todo eso. Si mañana alguien agrega una foránea nueva, o una vista que la lea,
-- queda excluida sola. Una lista de nombres a mano se desactualiza en silencio,
-- y el silencio es el modo de falla que esta fase entera existe para evitar.
-- ============================================================================
\set ON_ERROR_STOP on

-- ── El grupo ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    CREATE ROLE dev_ro NOLOGIN;
    COMMENT ON ROLE dev_ro IS
      'VL.10 — grupo portador de permisos de LECTURA para desarrollo. NOLOGIN: '
      'nadie se conecta como dev_ro. Las personas son roles nominales miembros de este.';
  END IF;
END $$;

DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO dev_ro', current_database()); END $$;

-- ── Los permisos, calculados ────────────────────────────────────────────────
DO $$
DECLARE
  s            record;   -- schema (bucle externo)
  rel          record;   -- relación (bucle interno) — VARIABLE APARTE a propósito:
                         -- reusar la del externo la pisa y vuelve el código una trampa.
  n_schemas    int := 0;
  n_rel        int := 0;
  n_saltadas   int := 0;
  n_omitidos   int := 0;
  excluidas    oid[];
BEGIN
  -- Relaciones PROHIBIDAS = las foráneas + todo lo que derive de ellas.
  -- El WITH RECURSIVE sube por pg_depend/pg_rewrite: una vista sobre una vista
  -- sobre una foránea también queda marcada.
  WITH RECURSIVE foraneas AS (
    SELECT c.oid FROM pg_class c WHERE c.relkind = 'f'
  ), derivadas AS (
    SELECT oid FROM foraneas
    UNION
    SELECT v.oid
      FROM derivadas d
      JOIN pg_depend dep ON dep.refobjid = d.oid
                        AND dep.refclassid = 'pg_class'::regclass
                        AND dep.classid    = 'pg_rewrite'::regclass
      JOIN pg_rewrite rw ON rw.oid = dep.objid
      JOIN pg_class v    ON v.oid = rw.ev_class AND v.oid <> d.oid
  )
  SELECT array_agg(oid) INTO excluidas FROM derivadas;
  excluidas := COALESCE(excluidas, '{}'::oid[]);

  FOR s IN
    SELECT n.oid AS nsp_oid, n.nspname
      FROM pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND n.nspname NOT LIKE 'pg\_temp%'
       AND n.nspname NOT LIKE 'pg\_toast%'
     ORDER BY n.nspname
  LOOP
    -- Un schema que SÓLO contiene cosas excluidas no se expone ni con USAGE:
    -- dar USAGE sobre un schema del que no se puede leer nada sólo confunde
    -- (el dev lo ve en el árbol, entra, y todo le dice "permission denied").
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.relnamespace = s.nsp_oid
         AND c.relkind IN ('r', 'v', 'm', 'p')
         AND NOT (c.oid = ANY (excluidas))
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO dev_ro', s.nspname);
    n_schemas := n_schemas + 1;

    -- Relación por relación, saltando las excluidas. NO se usa
    -- `GRANT SELECT ON ALL TABLES IN SCHEMA`, porque ese atajo incluye las
    -- foráneas del schema y acá el objetivo es justamente no incluirlas.
    FOR rel IN
      SELECT c.oid, c.relname
        FROM pg_class c
       WHERE c.relnamespace = s.nsp_oid
         AND c.relkind IN ('r', 'v', 'm', 'p')
    LOOP
      IF rel.oid = ANY (excluidas) THEN
        n_saltadas := n_saltadas + 1;
        CONTINUE;
      END IF;
      EXECUTE format('GRANT SELECT ON %I.%I TO dev_ro', s.nspname, rel.relname);
      n_rel := n_rel + 1;
    END LOOP;
  END LOOP;

  -- ⚠️ El contador se cuenta APARTE de lo que recorre el bucle, a propósito. La
  -- primera versión reportaba "0 saltadas" en `kepler_consolidado` — y era
  -- verdad para el bucle, porque las foráneas ni siquiera entran en él (sólo
  -- itera relkind r/v/m/p) y los schemas que sólo tienen foráneas se descartan
  -- antes. O sea: saltó 9 schemas y 33 relaciones, y el log decía que no había
  -- saltado nada. Un número que dice "no pasó nada" cuando sí pasó es
  -- exactamente la clase de mentira que este proyecto ya pagó varias veces.
  SELECT count(*) INTO n_saltadas
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND (c.relkind = 'f' OR c.oid = ANY (excluidas));

  SELECT count(*) INTO n_omitidos
    FROM pg_namespace n
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND n.nspname NOT LIKE 'pg\_temp%' AND n.nspname NOT LIKE 'pg\_toast%'
     AND NOT has_schema_privilege('dev_ro', n.oid, 'USAGE');

  RAISE NOTICE '[%] expuesto: % schema(s), % relación(es) · NO expuesto: % schema(s), % relación(es) por foráneas',
    current_database(), n_schemas, n_rel, n_omitidos, n_saltadas;
END $$;

-- ── Las tablas FUTURAS ──────────────────────────────────────────────────────
-- ⚠️ Sin esto, una tabla creada mañana NO es legible y el dev ve un "permission
-- denied" que parece un bug de su código. Es exactamente la trampa que dejó 7
-- tablas de `md_00` sin sincronizar durante meses: el `ALTER DEFAULT PRIVILEGES`
-- estaba puesto para un rol y las tablas las creaba otro.
-- Acá el dueño de TODO en este cluster es `postgres` (medido), así que el
-- `FOR ROLE postgres` es el correcto.
-- ⚠️ Efecto colateral aceptado y declarado: si alguien crea una tabla FORÁNEA
-- nueva en un schema ya expuesto, el default privilege se la va a otorgar. El
-- cálculo de arriba sólo protege lo que existe al momento de correr esto; por eso
-- dev-ro-verify.sh vuelve a comprobar la exclusión y hay que re-correr este
-- script cuando cambie el esquema.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname
      FROM pg_namespace n
     WHERE has_schema_privilege('dev_ro', n.oid, 'USAGE')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA %I GRANT SELECT ON TABLES TO dev_ro',
      r.nspname);
  END LOOP;
END $$;
