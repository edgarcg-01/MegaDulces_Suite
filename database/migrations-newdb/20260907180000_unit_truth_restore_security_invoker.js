/**
 * U.7 fix — `CREATE OR REPLACE VIEW` se llevó `security_invoker` y la vista dejó de filtrar RLS.
 *
 * ── Qué pasó ───────────────────────────────────────────────────────────────────────────────
 * La mig 20260907170000 reescribió `analytics.v_unit_truth` con `CREATE OR REPLACE VIEW` y NO
 * volvió a poner `ALTER VIEW ... SET (security_invoker = true)`. Resultado: la vista pasó a
 * ejecutarse con los permisos de su DUEÑO, no del que consulta, así que la RLS de
 * `catalog.products` / `commercial.warehouses` deja de aplicarse y un tenant podría ver filas de
 * otro. Hoy hay un solo tenant productivo, pero es precisamente la clase de defecto que no se
 * nota hasta que hay dos.
 *
 * Lo atrapó el candado de U.4 (`test-newdb-unit-truth.js`), que afirma la reloption en vez de
 * confiar en que "ya se puso una vez". Vale registrarlo: **una aserción sobre metadata que parece
 * redundante es la única que ve este tipo de pérdida**, porque la vista sigue devolviendo datos
 * correctos para el tenant actual y ninguna prueba funcional la nota.
 *
 * Regla que sale: después de CADA `CREATE OR REPLACE VIEW` sobre una vista con RLS, re-aplicar
 * `security_invoker` y el `GRANT`. No se heredan.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER VIEW analytics.v_unit_truth SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth TO app_runtime');

  // La de cobertura se recreó en la 160000 y sí quedó con la reloption, pero se re-afirma acá para
  // que las dos queden verificadas en el mismo lugar.
  await knex.raw('ALTER VIEW analytics.v_unit_truth_coverage SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth_coverage TO app_runtime');

  const r = await knex.raw(`
    SELECT c.relname, c.reloptions::text AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics'
       AND c.relname IN ('v_unit_truth', 'v_unit_truth_coverage')`);
  for (const row of r.rows) {
    if (!String(row.opts || '').includes('security_invoker=true')) {
      throw new Error(`analytics.${row.relname} quedó SIN security_invoker: ${row.opts}`);
    }
    console.log(`  analytics.${row.relname} → ${row.opts}`);
  }
};

exports.down = async function down() {
  // No-op a propósito: quitar `security_invoker` sería reintroducir el defecto.
};
