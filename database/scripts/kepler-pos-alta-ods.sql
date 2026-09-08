-- =====================================================================================
-- ALTA DE UN POS KEPLER EN EL PIPELINE DEL ODS  ·  se corre EN EL POS, como superusuario
-- =====================================================================================
-- Disparador: Morelia Madero (Wincaja `32`) migró su punto de venta a Kepler. Para que su venta
-- llegue al `kepler_ods` hace falta abrirle acceso a este servidor, igual que las 7 sucursales que
-- ya están cableadas.
--
-- ⚠️ NADA DE ESTO ESTÁ INVENTADO: cada línea es lo que ya corre en los POS `02` (192.168.42.42) y
--    `03` (192.168.40.40), leído de sus catálogos el 2026-09-08. Si algo difiere, gana el POS que
--    ya funciona, no este archivo.
--
-- El modelo medido:
--   PostgreSQL 16.4 · listen_addresses = * · wal_level = logical
--   max_replication_slots = 10 · max_wal_senders = 10 · max_connections = 500
--   DOS roles, con propósitos distintos y sin solaparse:
--     · `platform_ro`  SELECT, SIN replicación → lo usan los importers para consultar.
--     · `ods_repl`     CON replicación         → lo usa la suscripción lógica que copia el WAL.
--   UNA publicación `ods_pub_pilot` declarada **FOR TABLES IN SCHEMA md** (no lista explícita:
--   así una tabla nueva de Kepler entra al pipeline sola). En el POS `02` cubre 336 de 336 tablas,
--   y las 336 tienen PRIMARY KEY → no hace falta tocar REPLICA IDENTITY.
--
-- IDEMPOTENTE: se puede correr dos veces. No borra nada y **no pisa contraseñas ya puestas** — eso
-- último importa, porque cambiarle la password a `ods_repl` en un POS ya cableado le rompe la
-- suscripción a esa sucursal.
--
-- USO (desde el propio POS, con el superusuario del Kepler — `postgres` o `sa`):
--     psql -U postgres -d md_NN -f kepler-pos-alta-ods.sql
--
-- Pide las contraseñas por prompt a propósito: **no se escriben en el archivo ni quedan en el
-- historial de shell**. La de `ods_repl` tiene que ser la MISMA que usan las otras sucursales — el
-- DBA la saca del suscriptor con:
--     SELECT subconninfo FROM pg_subscription;      -- en :5433, como postgres
--
-- ⚠️ Ojo con psql: las variables NO se interpolan dentro de cadenas `$$ … $$`, así que el alta usa
--    `\gset` + `\if` en vez de un bloque `DO`. Escrito con `DO` el script crea el rol con la
--    contraseña literal ":'pw_ro'".
-- =====================================================================================

\set ON_ERROR_STOP on
\echo '── alta de este POS en el pipeline del ODS ────────────────────────'

-- ── 1. Los dos roles ────────────────────────────────────────────────────────────────
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_ro') AS crear_ro,
       NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ods_repl')    AS crear_repl,
       COALESCE((SELECT rolreplication FROM pg_roles WHERE rolname = 'ods_repl'), true) AS repl_ok,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sa')              AS hay_sa
\gset

\if :crear_ro
  \prompt 'Password para platform_ro (lectura, la misma que las otras sucursales): ' pw_ro
  CREATE ROLE platform_ro LOGIN PASSWORD :'pw_ro';
  \echo '  rol platform_ro CREADO'
\else
  \echo '  rol platform_ro ya existia — no se toca su password'
\endif

\if :crear_repl
  \prompt 'Password para ods_repl (replicacion, la misma que las otras sucursales): ' pw_repl
  CREATE ROLE ods_repl LOGIN REPLICATION PASSWORD :'pw_repl';
  \echo '  rol ods_repl CREADO (con REPLICATION)'
\else
  \echo '  rol ods_repl ya existia — no se toca su password'
  \if :repl_ok
  \else
    ALTER ROLE ods_repl REPLICATION;
    \echo '  … le faltaba el atributo REPLICATION: agregado (sin eso la suscripcion nunca conecta)'
  \endif
\endif

-- ── 2. Permisos de lectura sobre el schema de Kepler ────────────────────────────────
-- Los dos roles necesitan SELECT. `ods_repl` también: la sincronización inicial de la replicación
-- lógica LEE las tablas, no sólo el WAL.
GRANT CONNECT ON DATABASE :"DBNAME" TO platform_ro, ods_repl;
GRANT USAGE ON SCHEMA md TO platform_ro, ods_repl;
GRANT SELECT ON ALL TABLES IN SCHEMA md TO platform_ro, ods_repl;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA md TO platform_ro, ods_repl;

-- Y para las tablas que Kepler cree MAÑANA. Sin esto, una tabla nueva entra a la publicación
-- (es FOR TABLES IN SCHEMA) pero la sincronización inicial no la puede leer → la rama se rompe con
-- "permission denied" y el slot se queda atrás acumulando WAL hasta llenar el disco del POS.
-- Se declara por dueño, que es lo que muestran los POS ya cableados en `pg_default_acl`
-- (dueño `sa` para platform_ro, dueño `postgres` para ods_repl).
\if :hay_sa
  ALTER DEFAULT PRIVILEGES FOR ROLE sa IN SCHEMA md GRANT SELECT ON TABLES TO platform_ro, ods_repl;
  \echo '  default privileges declarados para tablas futuras de `sa`'
\else
  \echo '  ⚠️ no existe el rol `sa` en este POS: revisar quien es dueño de las tablas de md'
\endif
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA md GRANT SELECT ON TABLES TO platform_ro, ods_repl;

-- ── 3. La publicación ───────────────────────────────────────────────────────────────
-- `FOR TABLES IN SCHEMA md` y NO `FOR ALL TABLES`: fuera de `md` no hay nada que nos interese, y
-- publicar todo arrastraría catálogos ajenos. El nombre `ods_pub_pilot` es el que usan 6 de las 7
-- ramas (la `00` quedó con `ods_pub`, por historia); se conserva para que el suscriptor no necesite
-- un caso especial.
SELECT NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'ods_pub_pilot') AS crear_pub \gset
\if :crear_pub
  CREATE PUBLICATION ods_pub_pilot FOR TABLES IN SCHEMA md;
  \echo '  publicacion ods_pub_pilot CREADA (FOR TABLES IN SCHEMA md)'
\else
  \echo '  publicacion ods_pub_pilot ya existia'
\endif

-- ── 4. Verificación, en el mismo lugar ──────────────────────────────────────────────
-- Un alta sin comprobación es una intención. Si algo sale en 0 o en `false`, la rama NO está lista
-- aunque el script haya terminado sin error.
\echo ''
\echo '── estado tras el alta ────────────────────────────────────────────'
SELECT rolname, rolcanlogin AS puede_entrar, rolreplication AS replica
  FROM pg_roles WHERE rolname IN ('platform_ro', 'ods_repl') ORDER BY 1;

SELECT p.pubname, n.nspname AS schema_publicado,
       (SELECT count(*) FROM pg_publication_tables t WHERE t.pubname = p.pubname) AS tablas
  FROM pg_publication p
  LEFT JOIN pg_publication_namespace pn ON pn.pnpubid = p.oid
  LEFT JOIN pg_namespace n ON n.oid = pn.pnnspid
 WHERE p.pubname = 'ods_pub_pilot';

SELECT name, setting FROM pg_settings
 WHERE name IN ('wal_level', 'listen_addresses', 'max_replication_slots', 'max_wal_senders', 'port')
 ORDER BY name;

-- Tablas de `md` sin identidad de fila: la publicación las incluye pero NO propagaría UPDATE/DELETE.
-- En los POS medidos son 0.
SELECT count(*) AS tablas_sin_identidad_de_fila
  FROM pg_class k
  JOIN pg_namespace n ON n.oid = k.relnamespace
 WHERE k.relkind = 'r' AND n.nspname = 'md'
   AND k.relreplident = 'd'
   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = k.oid AND c.contype = 'p');

\echo ''
\echo 'Si `wal_level` no dice `logical`, o `listen_addresses` no expone la LAN, falta editar'
\echo 'postgresql.conf y pg_hba.conf y REINICIAR el servicio. Los renglones exactos y el resto'
\echo 'del cableado (suscripcion, registro de la rama, corte del carril Wincaja) estan en:'
\echo '  docs/RUNBOOK_ALTA_SUCURSAL_KEPLER.md'
