-- RL.13 — Permisos de LECTURA en la réplica `kepler_md_08` (Morelia Abastos).
-- Se corre DENTRO del contenedor de réplicas, contra la base `kepler_md_08`:
--   docker exec pgvector-md psql -U postgres -d kepler_md_08 -v ON_ERROR_STOP=1 -f <este archivo>
--
-- ── POR QUÉ, medido el 2026-09-21 ───────────────────────────────────────────────────────────
-- Al dar de alta `md_08` en `dim.sucursales` (ver `dim_sucursales_md08.sql`), la consolidación
-- falló con `permission denied for schema md`: la réplica nació SIN ningún permiso para
-- `platform_ro`, que es el usuario con el que `mart.refresh_si_cambio()` abre su `dblink`.
--
--     kepler_md_07 (sana)  platform_ro · USAGE=true  · 334 tablas legibles
--     kepler_md_08         platform_ro · USAGE=FALSE ·   0 tablas legibles
--
-- ⛔ Y NO es un fallo cosmético: `refresh_si_cambio` **no tiene bloque EXCEPTION por sucursal**
-- (sólo lo tiene su hermana `refresh_ventas`). Una rama que no se puede leer aborta la función
-- entera, o sea que deja de refrescarse `mart.ventas` de TODAS las sucursales. Es el mismo
-- defecto de fondo que §4.2b, pero del lado del suscriptor y con radio de daño mayor.
--
-- ── Qué se replica ──────────────────────────────────────────────────────────────────────────
-- Exactamente lo que tiene la réplica sana, ni más ni menos. `app_runtime` e `ingest` NO
-- aparecen a propósito: en `md_07` tampoco tienen acceso a `md` (allí leen el ODS, no la réplica).
-- El `ALTER DEFAULT PRIVILEGES` calca el `pg_default_acl` de `md_07`
-- (`postgres -> platform_ro=r, dev_ro=r`) y es lo que hace que las tablas de póliza mensuales
-- `kdc2YYMM`, que Kepler crea solas cada mes, nazcan legibles en vez de trabarse en enero.
--
-- Idempotente: `GRANT` sobre lo ya otorgado no falla.

GRANT USAGE ON SCHEMA md TO platform_ro, dev_ro;

GRANT SELECT ON ALL TABLES IN SCHEMA md TO platform_ro, dev_ro;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA md
  GRANT SELECT ON TABLES TO platform_ro, dev_ro;

-- Verificación: ambas cifras deben quedar igual que en `kepler_md_07` (true / 334+).
SELECT rolname,
       has_schema_privilege(rolname, 'md', 'USAGE') AS usage_md,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'md' AND c.relkind = 'r'
           AND has_table_privilege(rolname, c.oid, 'SELECT')) AS tablas_legibles
  FROM pg_roles
 WHERE rolname IN ('platform_ro', 'dev_ro')
 ORDER BY 1;
