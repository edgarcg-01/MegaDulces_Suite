/**
 * Análisis semanal de Tienda (/tienda/analisis-semanal) — permiso STORE_ANALYTICS_VER.
 *
 * Solo-lectura → se otorga a todos los que ya tienen acceso a Tienda (operadores de
 * sucursal + tienda legacy + admin) y a prevención/auditoría. Sin datos ni feeds
 * nuevos: agrega on-the-fly analytics.sales_daily + product_sales_daily (ya poblados
 * por el nightly).
 *
 * Idempotente (merge `||` guardado por `@>`; match case-insensitive por role_name).
 * Los permisos viajan en el JWT → los usuarios afectados deben RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */
const ROLES = [
  'superadmin', 'admin', 'sucursal',
  'encargado_sucursal', 'jefe_de_tienda', 'auxiliar_sucursal', 'supervisora',
  'auxiliar_de_tienda', 'prevencion_auditoria',
];

exports.up = async function (knex) {
  const patch = JSON.stringify({ STORE_ANALYTICS_VER: true });
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE lower(role_name) = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch, roles: ROLES.map((r) => r.toLowerCase()) },
  );
};

exports.down = async function (knex) {
  const off = JSON.stringify({ STORE_ANALYTICS_VER: false });
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || :off::jsonb
      WHERE lower(role_name) = ANY(:roles)`,
    { off, roles: ROLES.map((r) => r.toLowerCase()) },
  );
};
