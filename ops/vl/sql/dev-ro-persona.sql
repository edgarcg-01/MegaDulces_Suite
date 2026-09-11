-- ============================================================================
-- VL.10 — Alta de UNA persona con lectura de desarrollo.
--
--   psql -v usuario=edgar -v clave='...' -f dev-ro-persona.sql
--
-- Se corre UNA SOLA VEZ por persona (los roles son del CLUSTER), a diferencia de
-- dev-ro-grants.sql que va por BASE. Es idempotente: si el rol ya existe, sólo se
-- le refrescan la contraseña y las guardas.
--
-- Un rol POR PERSONA, no uno compartido. La diferencia no es burocrática: con rol
-- compartido `pg_stat_activity` dice `dev_ro` y no se sabe quién está corriendo la
-- consulta que se está comiendo el servidor, ni se puede revocar a una sola
-- persona sin cambiarle la credencial a todo el equipo. Ya pasó en este proyecto
-- con `app_runtime` (GOTCHAS §24).
--
-- ⚠️ POR QUÉ LAS GUARDAS VAN ACÁ Y NO EN EL GRUPO
-- `ALTER ROLE ... SET` **no se hereda por membresía**: los parámetros sólo aplican
-- al rol que efectivamente inicia la sesión. Ponerlos en `dev_ro` no haría nada —
-- y no daría ningún error, que es la peor forma de no funcionar.
--
-- ⚠️ EL ROL ES `INHERIT` (el default), a propósito. Con `NOINHERIT` la persona
-- sería miembro de `dev_ro` pero NO tendría sus permisos hasta hacer `SET ROLE
-- dev_ro` a mano en cada sesión: se conectaría bien y todo daría "permission
-- denied", que parece un problema de permisos mal puestos y no lo es.
--
-- ⛔ POR QUÉ ESTE CLUSTER NECESITA GUARDAS Y NO ES PARANOIA
-- Estas réplicas NO son una copia de laboratorio: son la FUENTE VIVA del pipeline
-- que publica la venta. En el mismo cluster corren `ods-live-hot` (@15 s),
-- `ods-live-mirror` y `ods-reconcile`. Una consulta de desarrollo sin límite
-- compite con ellos por CPU y disco, y hay un caso peor: la replicación lógica SÍ
-- replica `TRUNCATE`, que necesita ACCESS EXCLUSIVE. Un `SELECT` largo de un dev
-- retiene ACCESS SHARE y **bloquea al worker de apply**, o sea frena la
-- suscripción entera de esa sucursal.
-- Lo que acota eso es `statement_timeout` (cuánto puede SOSTENER un lock), NO
-- `lock_timeout` (cuánto espera por uno). Se ponen los dos, pero el que protege la
-- ingesta es el primero.
-- ============================================================================
\set ON_ERROR_STOP on

-- ── Crear si falta ──────────────────────────────────────────────────────────
-- Un SELECT que no devuelve filas hace que `\gexec` no ejecute nada: así el
-- script es idempotente sin necesidad de un bloque DO.
SELECT format(
  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5',
  :'usuario')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usuario')
\gexec

-- ── Atributos y contraseña (siempre, para poder rotar) ──────────────────────
-- `%L` cita el literal, así que una contraseña con comillas o barras no rompe el
-- comando ni abre una inyección.
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5',
  :'usuario', :'clave')
\gexec

-- ── Guardas de sesión + membresía ───────────────────────────────────────────
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'usuario')
UNION ALL SELECT format('ALTER ROLE %I SET statement_timeout = ''120s''', :'usuario')
UNION ALL SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = ''60s''', :'usuario')
UNION ALL SELECT format('ALTER ROLE %I SET lock_timeout = ''5s''', :'usuario')
UNION ALL SELECT format('GRANT dev_ro TO %I', :'usuario')
UNION ALL SELECT format('COMMENT ON ROLE %I IS %L', :'usuario',
                        'VL.10 - lectura de desarrollo. Miembro de dev_ro. Alta por ops/vl/dev-ro-setup.sh.')
\gexec
