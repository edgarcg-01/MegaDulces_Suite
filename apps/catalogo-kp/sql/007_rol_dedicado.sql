-- ============================================================================
--  Fase CV — Rol dedicado para catalogo-kp
--
--  QUE PROBLEMA RESUELVE
--  El proyecto origen usaba `app_runtime` para conectarse a KP_CONCENTRADA.
--  Pero 192.168.0.245 es UN SOLO cluster Postgres que también hospeda
--  `postgres_platform` (esta Suite), y en Postgres el password de un rol es
--  DEL CLUSTER, no de una base — ver docs/GOTCHAS.md §24. Es decir: el
--  `app_runtime` de KP_CONCENTRADA y el `app_runtime` multi-tenant de la Suite
--  son, literalmente, el mismo rol. Rotar uno tumba al otro sin avisar.
--  Sospecha fundada (no confirmada): la caída de 6h del 27/08/2026 registrada
--  en el proyecto origen ("nadie sabe quién cambió la contraseña en .245") es
--  una instancia de este mismo patrón.
--
--  Este script crea un rol NUEVO y EXCLUSIVO de catalogo-kp, con exactamente
--  los mismos permisos que `app_runtime` ya tiene sobre KP_CONCENTRADA. Es
--  ADITIVO: no toca, no revoca, no depende de `app_runtime`.
--
--  CORRER COMO postgres, contra KP_CONCENTRADA:
--    psql -h 192.168.0.245 -U postgres -d KP_CONCENTRADA -f 007_rol_dedicado.sql
--
--  Después de correrlo:
--    1. Poner el password real (reemplazar CAMBIA_ESTE_PASSWORD abajo antes de
--       ejecutar, o rotarlo después con ALTER ROLE).
--    2. Actualizar DATABASE_URL_KP_CONCENTRADA en el .env de catalogo-kp para
--       usar catalogo_kp_runtime en vez de app_runtime.
--    3. Mientras ambos roles sigan concediendo acceso, el corte se puede hacer
--       sin downtime: cambiar el .env y reiniciar el proceso.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalogo_kp_runtime') THEN
    CREATE ROLE catalogo_kp_runtime WITH LOGIN PASSWORD 'CAMBIA_ESTE_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- ── kp.* — sólo lectura, igual que app_runtime ──────────────────────────────
GRANT USAGE ON SCHEMA kp TO catalogo_kp_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA kp TO catalogo_kp_runtime;
-- concentrate-kepler.js crea tablas kp.<tabla> dinámicamente (schema-discovery);
-- sin esto, una tabla nueva no heredaría el permiso hasta correr este GRANT de nuevo.
ALTER DEFAULT PRIVILEGES IN SCHEMA kp GRANT SELECT ON TABLES TO catalogo_kp_runtime;

-- ── admin.* — sólo lectura de admin.usuarios (login del tablero) ───────────
GRANT USAGE ON SCHEMA admin TO catalogo_kp_runtime;
GRANT SELECT ON admin.usuarios TO catalogo_kp_runtime;

-- ── tienda.* — lectura + escritura, SIN DELETE (mismo criterio que app_runtime:
--    los pedidos se cancelan, no se borran) ──────────────────────────────────
GRANT USAGE ON SCHEMA tienda TO catalogo_kp_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA tienda TO catalogo_kp_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA tienda TO catalogo_kp_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA tienda
  GRANT SELECT, INSERT, UPDATE ON TABLES TO catalogo_kp_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA tienda
  GRANT USAGE, SELECT ON SEQUENCES TO catalogo_kp_runtime;

-- ── monitor.* — mismo criterio que app_runtime (sin DELETE) ────────────────
GRANT USAGE ON SCHEMA monitor TO catalogo_kp_runtime;
GRANT SELECT, INSERT, UPDATE ON monitor.errores           TO catalogo_kp_runtime;
GRANT SELECT, INSERT          ON monitor.errores_detalle   TO catalogo_kp_runtime;
GRANT SELECT                  ON monitor.v_errores_activos TO catalogo_kp_runtime;
GRANT USAGE, SELECT ON SEQUENCE monitor.errores_id_seq          TO catalogo_kp_runtime;
GRANT USAGE, SELECT ON SEQUENCE monitor.errores_detalle_id_seq  TO catalogo_kp_runtime;

DO $$
BEGIN
  RAISE NOTICE 'Migracion 007 aplicada: rol catalogo_kp_runtime listo. Falta poner password real y actualizar .env.';
END $$;
