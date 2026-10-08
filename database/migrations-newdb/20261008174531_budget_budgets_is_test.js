'use strict';
/**
 * `[PU.VG.1]` — `budget.budgets.is_test`: separar el ejercicio de PRUEBA del que manda.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 2026-10-08 16:13 MX) ─────────────────────────────
 *  · `budget.budgets` tiene **3 filas y 2 son de prueba**: `prueba 2` (FY2026) y
 *    `PRUEBA ciclo ledger — no usar` (FY2027). Los tres en `borrador`.
 *  · Los dos ejercicios FY2027 son **el mismo duplicado**: misma huella md5 sobre
 *    `(concept, line_type, vigente_amount)` = `12e0cfab4891f2e3`, 47 partidas cada uno.
 *    → **todo agregado por `fiscal_year` publica el doble**: gasto $149,704,381.64 cuando el
 *      real es $74,852,190.82; ingreso $1,209,550,232.42 cuando el real es $604,775,116.21.
 *  · Y el `@Cron` del autopiloto (`0 30 7 * * *` MX) **corre sobre los tres**, incluido el que
 *    se llama «no usar» (`generation_runs` GEN-20261008-015..020, `trigger: cron`), así que lo
 *    mantiene fresco y por lo tanto con pinta de legítimo.
 *
 * Esta migración SÓLO agrega la columna. **No marca ninguna fila**: marcar es un acto con dueño
 * y se hace por `id` verificado, nunca por nombre (hay dos ejercicios cuyo nombre empieza con
 * «prueba» y uno de ellos podría ser el bueno algún día). El filtro del autopiloto viaja en el
 * mismo cambio de código, con su prueba negativa.
 *
 * ⚠️ `DEFAULT false` a propósito: el lado seguro de equivocarse es que un ejercicio NUEVO se
 *    considere real. Un default `true` escondería ejercicios de verdad.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('budget').hasColumn('budgets', 'is_test'))) {
    await knex.raw(`ALTER TABLE budget.budgets
                      ADD COLUMN is_test boolean NOT NULL DEFAULT false`);
  }

  // Índice parcial: las consultas que importan preguntan por los NO-prueba, que son la enorme
  // mayoría. Un índice sobre los `true` es chico y sirve para listarlos en la pantalla.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_budget_budgets_is_test
                    ON budget.budgets (tenant_id, fiscal_year)
                    WHERE is_test`);

  await knex.raw(`COMMENT ON COLUMN budget.budgets.is_test IS
    'Ejercicio de PRUEBA: no lo toca el autopiloto, no cuenta para «ya existe el ejercicio del año» y no entra en agregados publicados. Se marca a mano por id, con dueño. Default false = el lado seguro (un ejercicio nuevo se asume real).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS budget.ix_budget_budgets_is_test`);
  if (await knex.schema.withSchema('budget').hasColumn('budgets', 'is_test')) {
    await knex.raw(`ALTER TABLE budget.budgets DROP COLUMN is_test`);
  }
};
