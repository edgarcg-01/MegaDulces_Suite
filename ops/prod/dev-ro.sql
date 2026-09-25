-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- `[SEG.4]` TRES CUENTAS DE SOLO LECTURA SOBRE LA BASE DE PRODUCCION (`railway` en `pg-prod`).
--
-- Se aplica asi (las claves NO viven en este archivo ni en git):
--     cat ~/secrets/.dev-ro-claves.sql ops/prod/dev-ro.sql | docker exec -i pg-prod psql -U postgres -d railway
--
-- El archivo de claves define `\set clave_david '...'` y sus hermanos, tiene permisos 600 y lo
-- genera `ops/prod/dev-ro-crear.sh`. Mismo criterio que `catalogo_kp/sql/007_rol_dedicado.sql`:
-- el archivo versionado guarda la FORMA, nunca el secreto.
--
-- ── Por que hizo falta ───────────────────────────────────────────────────────────────────────
-- Medido el 2026-09-25: `pg-prod` tenia exactamente TRES roles —`postgres`, `app_runtime` y
-- `fdw_verificador_ro`— o sea que para consultar datos un dev no tenia mas opcion que usar la
-- credencial de la aplicacion. El cluster de replicas (`pgvector-md`) ya resolvia esto bien, con
-- un grupo `dev_ro` y personas como miembros; esto copia ESE patron en vez de inventar otro.
--
-- ── Las dos trampas que este archivo existe para esquivar ────────────────────────────────────
--
-- ⛔ 1. RLS FORZADA EN 325 TABLAS (`commercial` 129 de 131, `finance` 53, `logistics` 32,
--    `wincaja` 29, `identity` 11…). Un rol de lectura sin contexto de tenant las ve **vacias, y
--    sin ningun error**: `SELECT count(*) FROM commercial.orders` devuelve 0 y parece un dato.
--    Es el modo de falla que mas veces ha cobrado en este proyecto.
--
--    ⭐ Se resuelve SIN `BYPASSRLS`. Medido: `current_tenant_id()` es
--    `NULLIF(current_setting('app.tenant_id', true),'')::uuid` y las politicas son
--    `tenant_id = current_tenant_id()`, asi que basta con que la sesion nazca con la variable
--    puesta —`ALTER ROLE … SET app.tenant_id`— para que la politica evalue normal.
--    `BYPASSRLS` habria dado el mismo resultado ROMPIENDO el aislamiento; esto lo respeta.
--    ⚠️ Hoy existe UN solo tenant (`mega_dulces`). El dia que haya dos, esta linea es lo que
--    define que ve cada dev, y hay que revisarla a proposito.
--
-- ⛔ 2. UN `GRANT SELECT` INGENUO ENTREGA SECRETOS. Medido: `identity.users.password_hash`,
--    `public.users.password_hash` y los tokens OAuth vivos de `kepler_ods.orgmail` /
--    `md.orgmail` (`k_access_token`, `k_refresh_token`). Se revocan esas tablas y se vuelve a
--    conceder **columna por columna**, sin las prohibidas.
--    ⚠️ Efecto declarado: una columna NUEVA en esas tablas NO queda concedida hasta que alguien
--    vuelva a correr esto. Falla hacia el lado seguro (se deja de ver, no se ve de mas).
--
-- ── Tres frenos mas, porque esto corre contra PRODUCCION ─────────────────────────────────────
--   · `default_transaction_read_only` — aunque un GRANT se escape, la transaccion no escribe.
--     Es cinturon, no muralla: el muro es que `dev_ro` no tiene INSERT/UPDATE/DELETE.
--   · `statement_timeout` — una consulta sin `WHERE` sobre 23 GB no puede degradar a los usuarios.
--   · `CONNECTION LIMIT` — tres personas con un cliente grafico abren mas sesiones de las que creen.
--
-- ⚠️ NO hace falta tocar `pg_hba`: `pg-prod` ya trae `host all all all scram-sha-256`. Eso mismo
-- significa que estas credenciales sirven **desde cualquier maquina de la red**; el puerto 5434
-- esta publicado en `0.0.0.0`. Es un riesgo que ya existia y que esto NO empeora, pero queda dicho.
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- Que las sentencias con `PASSWORD` no queden escritas en el diario del servidor.
SET log_statement = 'none';
SET log_min_duration_statement = -1;

BEGIN;

-- ── 1. El grupo que tiene los permisos ──────────────────────────────────────────────────────
-- Los permisos viven en el GRUPO y las personas son miembros. Asi, dar de alta o de baja a
-- alguien es una linea, y no hay que recordar veintitantos GRANT por persona.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    CREATE ROLE dev_ro NOLOGIN;
  END IF;
END $$;

-- ── 2. Lectura sobre los schemas de negocio ─────────────────────────────────────────────────
-- ⛔ `pgboss` queda FUERA a proposito: es la cola de trabajos y sus payloads pueden traer
-- argumentos sensibles. Si alguien lo necesita para depurar un cron, se agrega con su motivo.
DO $$
DECLARE s text; mv record;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'analytics','analytics_external','budget','caja_general_ods','catalog','commercial','erp',
    'fdw_export','finance','fiscal','hr','identity','intelligence','inventory','kepler_ods',
    'logistics','md','ops','public','reconciliation','trade','whatsapp','wincaja'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN CONTINUE; END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO dev_ro', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO dev_ro', s);
    -- Para lo que se cree despues. Se declara por cada rol que crea objetos: las migraciones
    -- corren como `postgres`, pero `app_runtime` tambien puede crear.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres    IN SCHEMA %I GRANT SELECT ON TABLES TO dev_ro', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE app_runtime IN SCHEMA %I GRANT SELECT ON TABLES TO dev_ro', s);
  END LOOP;

  -- ⭐ LAS VISTAS MATERIALIZADAS VAN APARTE. `GRANT … ON ALL TABLES` cubre tablas, vistas y
  -- tablas foraneas — **no matvistas**. Sin esto, justo los objetos de `analytics` que un dev
  -- mas quiere consultar responderian `permission denied`, que se lee como un permiso mal dado
  -- y no como lo que es. Se verifica leyendo una matvista real con cada cuenta.
  FOR mv IN SELECT schemaname, matviewname FROM pg_matviews
             WHERE schemaname NOT IN ('pg_catalog','information_schema','pgboss') LOOP
    EXECUTE format('GRANT SELECT ON %I.%I TO dev_ro', mv.schemaname, mv.matviewname);
  END LOOP;
END $$;

-- ── 3. Lo que NO se lee ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t record; cols text;
BEGIN
  -- ⛔⛔ `identity.users` / `public.users` SALIERON DE ESTA LISTA EL 2026-09-25, Y EL MOTIVO
  -- IMPORTA MAS QUE LA DECISION: **un permiso por columna no redacta un `SELECT *`, lo
  -- RECHAZA ENTERO**. La app hace `select * from users` para autenticar, asi que excluir
  -- `password_hash` no le ocultaba la columna: le rompia el login con `42501 permission denied
  -- for view users`, con 28 de 29 columnas concedidas. Medido en vivo.
  --
  -- O sea que la restriccion por columna sirve SOLO en tablas que nadie lee con `*`. Antes de
  -- agregar una a esta lista hay que saber como la consulta el codigo, no solo si es sensible.
  --
  -- Compromiso ASUMIDO Y DECLARADO: las cuentas `dev_ro` pueden leer los hash de contraseña de
  -- los 138 usuarios. Son hash, no contraseñas, y estas mismas cuentas ya leen nomina, fiscal,
  -- finanzas y el padron de clientes — pero el riesgo real que queda es la REUTILIZACION de
  -- contraseña fuera de esta app. Se revierte con una linea:
  --     REVOKE SELECT ON identity.users, public.users FROM dev_ro;
  --     -- (y volver a conceder por columna, sabiendo que el login deja de funcionar)
  --
  -- `orgmail` SE QUEDA restringida: son tokens OAuth VIVOS de un buzon —no un hash, una llave
  -- que abre hoy— y se midio que la app NO lee esa tabla, asi que la restriccion no cuesta nada.
  FOR t IN SELECT * FROM (VALUES
      ('kepler_ods', 'orgmail', ARRAY['k_access_token','k_refresh_token']),
      ('md',         'orgmail', ARRAY['k_access_token','k_refresh_token'])
  ) AS v(sch, tab, prohibidas) LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', t.sch, t.tab)) IS NULL;
    EXECUTE format('REVOKE SELECT ON %I.%I FROM dev_ro', t.sch, t.tab);
    SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
      FROM information_schema.columns
     WHERE table_schema = t.sch AND table_name = t.tab
       AND NOT (column_name = ANY (t.prohibidas));
    IF cols IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON %I.%I TO dev_ro', cols, t.sch, t.tab);
    END IF;
  END LOOP;
END $$;

-- ── 4. Las personas ─────────────────────────────────────────────────────────────────────────
-- Nominales a proposito: un rol compartido no deja rastro de quien consulto que, y eso es
-- justo lo que el control de acceso de esta semana vino a cerrar.
-- Mismos nombres que ya tienen en `pgvector-md`, para que nadie aprenda una credencial nueva.
--
-- ⛔ LA LISTA ES UN PARAMETRO (`\set personas` viene del archivo de claves), NO una constante.
-- En la primera version estaba clavada aca mientras el guion ofrecia `DEV_RO_PERSONAS` como si
-- la controlara: dar de alta a una persona mas obligaba a editar este archivo, y correr el
-- guion otra vez **rotaba las claves de todos** — invalidando las que ya se habian repartido.
-- Un parametro que no parametriza es peor que no tenerlo, porque se confia en el.
-- ⛔ La lista entra por `set_config` y NO por `:'personas'` directo: psql **no interpola sus
-- variables dentro de un bloque con comillas de dolar** (`$$ … $$`), asi que ahi adentro el
-- `:'personas'` llega literal y Postgres responde `syntax error at or near ":"`. `true` la hace
-- local a la transaccion, que es justo el alcance de este guion.
SELECT set_config('dev_ro.personas', :'personas', true);

DO $$
DECLARE p text;
BEGIN
  FOREACH p IN ARRAY string_to_array(current_setting('dev_ro.personas'), ',') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', p);
    END IF;
    EXECUTE format('GRANT dev_ro TO %I', p);
    EXECUTE format('ALTER ROLE %I SET app.tenant_id = %L', p, '00000000-0000-0000-0000-00000000d01c');
    EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', p);
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', p, '60s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', p, '5min');
    EXECUTE format('ALTER ROLE %I CONNECTION LIMIT 5', p);
  END LOOP;
END $$;

COMMIT;

-- Las claves NO van en este archivo. `dev-ro-crear.sh` genera un tramo final con un
-- `ALTER ROLE <persona> PASSWORD :'clave_<persona>'` por cada persona de ESTA corrida, y lo
-- concatena despues de este archivo. Asi, agregar a alguien no toca la clave de nadie mas.
