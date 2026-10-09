'use strict';
/**
 * `[PU.VG.2]` — `budget.v_expense_plan_coverage`: el renglón del plan de gasto DECLARA de dónde
 * salió su número, y la celda que no existe se ENUMERA.
 *
 * ── El defecto ──────────────────────────────────────────────────────────────────────────────
 * Hoy los tres orígenes se suman igual y ninguno se distingue en pantalla:
 *
 *   · **observado** — el monto es el gasto contable realizado de ese mes (`historico_ajustado`).
 *   · **promedio_plano** — el motor rellenó el mes con `suma(meses observados) / n`, idéntico en
 *     todos los meses rellenados. Está rotulado `estacional`, que dice lo contrario de lo que
 *     hace: para una dulcería aplana justo el trimestre más caro del año.
 *   · **ausente** — no hay renglón para ese (cuenta, mes). Una ausencia suma `$0.00` en cualquier
 *     agregado **sin marcar nada**, que es la forma más barata de publicar un cero inventado.
 *
 * ⭐ Esto es una VISTA, no una tabla: se deriva de `expense_plan_lines`, no se materializa ni hay
 * importer que alguien tenga que acordarse de correr. Mismo patrón que `v_unit_truth_coverage`
 * (ADR-057): *lo que el resolvedor no cubre se enumera, porque una fila ausente llega NULL a un
 * LEFT JOIN y se lee como sana*.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 2026-10-08) ──────────────────────────────────────
 *  · FY2027 «Presupuesto 2027»: **115 observado · 43 promedio_plano · 10 ausente**.
 *    El relleno plano son **$18,871,884.76 de $74,852,190.82 = 25.21 %** del presupuesto de
 *    gasto, publicado hoy sin distinguirse de lo observado.
 *  · FY2026 «prueba 2»: 58 observado · **0 promedio_plano** · 2 ausente (cuenta `604` en 2026-08
 *    y `659` en 2026-10). Su base ago–dic 2025 estaba completa, por eso no hubo nada que rellenar.
 *  · Las 10 ausentes de FY2027 son **todas de la cuenta `612`**, que sólo existe en marzo y junio.
 *
 * ⚠️ `year_month` es `character varying` con la forma `'2026-08'`, **no `date`**. Un `::date`
 *    sobre ese valor revienta (`invalid input syntax for type date: "2027-05"`), y el planner lo
 *    poda cuando la columna no se proyecta — o sea que el error aparece o no según la consulta.
 *    El orden lexicográfico de `'YYYY-MM'` sí coincide con el cronológico, así que ordenar como
 *    texto es correcto acá.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW budget.v_expense_plan_coverage AS
    SELECT b.tenant_id,
           b.id                AS budget_id,
           b.fiscal_year,
           b.name              AS ejercicio,
           b.is_test,
           g.account_code,
           g.year_month,
           CASE
             WHEN e.id IS NULL            THEN 'ausente'
             WHEN e.method = 'estacional' THEN 'promedio_plano'
             WHEN e.base_amount IS NULL   THEN 'sin_base_declarada'
             ELSE 'observado'
           END                 AS estado,
           e.monto,
           e.base_amount,
           e.method            AS metodo_crudo
      FROM budget.budgets b
      JOIN LATERAL (
            SELECT c.account_code, m.year_month
              FROM (SELECT DISTINCT account_code FROM budget.expense_plan_lines WHERE budget_id = b.id) c
             CROSS JOIN (SELECT DISTINCT year_month FROM budget.expense_plan_lines WHERE budget_id = b.id) m
           ) g ON true
      LEFT JOIN budget.expense_plan_lines e
             ON e.budget_id = b.id
            AND e.account_code = g.account_code
            AND e.year_month   = g.year_month`);

  // ⚠️ `security_invoker` NO se hereda y se pierde en cada `CREATE OR REPLACE VIEW`: sin esto la
  // vista leería con los permisos del DUEÑO y saltaría el RLS forzado de `expense_plan_lines`
  // —o sea un tenant vería renglones de otro—. Lección de ADR-057, que ya costó una migración.
  await knex.raw(`ALTER VIEW budget.v_expense_plan_coverage SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON budget.v_expense_plan_coverage TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW budget.v_expense_plan_coverage IS
    'PU.VG.2 — de donde salio cada celda del plan de gasto: observado (gasto contable real del mes) | promedio_plano (el motor la relleno con suma/n, rotulada "estacional") | ausente (no hay renglon: suma $0.00 sin avisar) | sin_base_declarada. Es VISTA, no tabla: se deriva, no se materializa. Medido 2026-10-08 en FY2027: el relleno plano es el 25.21% del presupuesto de gasto.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS budget.v_expense_plan_coverage`);
};
