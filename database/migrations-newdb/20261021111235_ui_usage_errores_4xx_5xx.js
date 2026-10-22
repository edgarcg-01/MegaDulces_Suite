'use strict';
/**
 * `[ERR.1]` — `analytics.ui_usage` separa los RECHAZOS (4xx) de las FALLAS (5xx).
 *
 * Hoy `errores` es un solo contador: suma igual un 400 «elige la sucursal» que un 500. Con eso no
 * se puede abrir un issue por falla real sin ahogarse en rechazos esperados.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 2026-10-21) ─────────────────────────────────────
 *  · 1,598 errores en 7 días (~200/día) en 37 rutas.
 *  · `/api/store/arqueo/rutas`: 1,197 de 4,163 llamadas «con error» (29 %) — y son 400 de
 *    `resolverSucursal()` (el usuario no eligió/no tiene sucursal), no caídas del servidor.
 *  · `/api/auth-mt/login`: 136 de 1,182 — contraseñas equivocadas, no fallas de la app.
 *
 * Aditiva: dos columnas con DEFAULT 0, sin tocar la PK. `errores` sigue siendo el total
 * (4xx + 5xx + lo que no trae código) para no romper a quien ya lo lee. El único que escribe en
 * la tabla es `UsageMetricsInterceptor`, que tolera que esta migración todavía no esté aplicada
 * (vuelve a escribir sin las columnas nuevas), así que el orden de despliegue no pierde métricas.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const col of ['errores_4xx', 'errores_5xx']) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('ui_usage', col))) {
      await knex.schema.withSchema('analytics').alterTable('ui_usage', (t) => {
        t.integer(col).notNullable().defaultTo(0);
      });
    }
  }
  await knex.raw(`COMMENT ON COLUMN analytics.ui_usage.errores_4xx IS
    '[ERR.1] Respuestas 4xx: rechazos (validación, permiso, no encontrado). Esperados en su mayoría; no abren issue por sí solos.'`);
  await knex.raw(`COMMENT ON COLUMN analytics.ui_usage.errores_5xx IS
    '[ERR.1] Respuestas 5xx: fallas del servidor. Son las que abren issue.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const col of ['errores_5xx', 'errores_4xx']) {
    if (await knex.schema.withSchema('analytics').hasColumn('ui_usage', col)) {
      await knex.schema.withSchema('analytics').alterTable('ui_usage', (t) => t.dropColumn(col));
    }
  }
};
