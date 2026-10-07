/**
 * Sprint M.3 — FDW read-only sobre `Mega_Dulces.ventas` para analytics.
 *
 * postgres_fdw permite consultar tablas de otra DB Postgres como si fueran
 * locales. Las queries van vía conexión TCP a .245; los planificadores hacen
 * pushdown de WHERE/LIMIT/AGG cuando pueden (importante para esta tabla de
 * 2.1M filas).
 *
 * Resultado:
 *   - Schema `analytics_external` con foreign table `ventas_legacy` apuntando
 *     a `Mega_Dulces.public.ventas`.
 *   - El service `commercial-analytics` puede leerla con:
 *       SELECT zona, sum(venta_diaria) FROM analytics_external.ventas_legacy
 *        WHERE fecha BETWEEN $1 AND $2 GROUP BY zona
 *
 * NO RLS: postgres_fdw NO respeta RLS (foreign tables no tienen RLS aplicable).
 * En este caso es aceptable porque `Mega_Dulces` no tiene tenant_id — los
 * datos son monoempresa por design. Para el futuro multi-tenant, cualquier
 * endpoint que exponga estos datos debe gatear por permiso y NUNCA exponer
 * datos cross-tenant (la app es single-tenant para Mega Dulces de momento).
 *
 * Credenciales: hardcoded `postgres / superoot` matching .env. En prod hay que
 * mover a env vars o a un USER MAPPING distinto por env (esta migración
 * actualmente solo es para dev/staging).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics_external`);

  // Server foreign — la conexión a Mega_Dulces.
  // DROP/CREATE para que sea idempotente y reflejar cambios de host si los hay.
  await knex.raw(`DROP SERVER IF EXISTS mega_dulces_srv CASCADE`);
  await knex.raw(`
    CREATE SERVER mega_dulces_srv
      FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host '192.168.0.245', port '5432', dbname 'Mega_Dulces',
               updatable 'false', fetch_size '10000')
  `);

  // User mapping — el user actual (postgres del target) se mapea al postgres
  // del source. En prod debería ser un user read-only dedicado.
  await knex.raw(`
    CREATE USER MAPPING FOR CURRENT_USER
      SERVER mega_dulces_srv
      OPTIONS (user 'postgres', password 'superoot')
  `);

  // Foreign table — refleja shape exacto de Mega_Dulces.ventas.
  await knex.raw(`
    CREATE FOREIGN TABLE analytics_external.ventas_legacy (
      fecha          DATE,
      hora           TIME WITHOUT TIME ZONE,
      zona           VARCHAR(100),
      almacen        VARCHAR(150),
      vendedor       VARCHAR(150),
      tercero_id     VARCHAR(100),
      tercero_nombre VARCHAR(150),
      folio          VARCHAR(50),
      producto_id    VARCHAR(100),
      producto       VARCHAR(250),
      subfamilia     VARCHAR(150),
      categoria      VARCHAR(150),
      cantidad       NUMERIC(12,4),
      venta_diaria   NUMERIC(12,4),
      costo          NUMERIC(12,4)
    ) SERVER mega_dulces_srv
      OPTIONS (schema_name 'public', table_name 'ventas')
  `);

  // Permitir SELECT al app_runtime — el rol runtime sigue el principio de
  // least-privilege y solo recibe SELECT (no INSERT/UPDATE/DELETE; updatable
  // false en el server tampoco lo permitiría).
  await knex.raw(`GRANT USAGE ON SCHEMA analytics_external TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics_external.ventas_legacy TO app_runtime`);

  // Mapping de usuario también para app_runtime para que las queries del
  // service no fallen por falta de credenciales.
  await knex.raw(`
    CREATE USER MAPPING IF NOT EXISTS FOR app_runtime
      SERVER mega_dulces_srv
      OPTIONS (user 'postgres', password 'superoot')
  `);

  console.log('[fdw_mega_dulces_ventas] foreign table analytics_external.ventas_legacy creada');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS analytics_external.ventas_legacy`);
  await knex.raw(`DROP USER MAPPING IF EXISTS FOR app_runtime SERVER mega_dulces_srv`);
  await knex.raw(`DROP USER MAPPING IF EXISTS FOR CURRENT_USER SERVER mega_dulces_srv`);
  await knex.raw(`DROP SERVER IF EXISTS mega_dulces_srv CASCADE`);
  // No drop schema ni extension — pueden ser usados por otras foreign tables.
};
