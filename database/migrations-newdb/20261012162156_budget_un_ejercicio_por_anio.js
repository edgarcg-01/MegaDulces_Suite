/**
 * `[TES.23]` **UN solo ejercicio real por año fiscal — y lo garantiza la base, no la convención.**
 *
 * ── DE DÓNDE SALE ─────────────────────────────────────────────────────────
 *
 * Decisión de Dirección (2026-10-12): el presupuesto lo arma Dirección General, hay **una sola
 * verdad absoluta y un único camino**, y además **nadie firma: todo es automático**.
 *
 * ⭐ Esa segunda mitad es lo que le sube el peso a este índice. Con un humano autorizando,
 * alguien podía notar que convivían dos versiones del mismo año. **Sin revisor, este índice es
 * lo único que impide tres verdades.** Pasa de higiene a control.
 *
 * ── POR QUÉ `IS NOT TRUE` Y NO `= false` ──────────────────────────────────
 *
 * `is_test` es `NOT NULL DEFAULT false` hoy, y aun así el código de la política compara con
 * `!== true` a propósito —está comentado en `budget-autopilot.policy.ts`— porque una fila vieja
 * podría traer NULL. Un predicado `WHERE is_test = false` **dejaría pasar un segundo ejercicio
 * con NULL** y el índice se vería puesto sin estarlo.
 *
 * ⇒ `WHERE is_test IS NOT TRUE` cubre NULL **y** false. Medido en prod el 2026-10-12:
 * `is_test IS NULL` da **0 filas**, así que hoy los dos predicados coinciden — y justamente por
 * eso la diferencia no se notaría nunca hasta el día que muerde.
 *
 * ── PRE-VUELO, MEDIDO ANTES DE ESCRIBIR ESTO ──────────────────────────────
 *
 * ```
 *   colisiones (tenant, año) con más de un no-prueba ....... 0
 *   filas con is_test NULL ................................. 0
 *   FY2026  no_prueba 1              FY2027  no_prueba 1 + prueba 1
 * ```
 *
 * El índice entra sin conflicto. ⚠️ Y el ejercicio `is_test = true` de FY2027 **queda fuera del
 * índice a propósito**: es la copia de prueba y tiene que poder convivir con el real — si el
 * índice la incluyera, aplicar esta migración fallaría.
 *
 * ── ⛔ LO QUE ESTE ÍNDICE NO HACE ─────────────────────────────────────────
 *
 * No decide **cuál** de dos es el bueno: impide que haya dos. Si algún día aparece una colisión,
 * la migración **falla y nombra el año**, que es el comportamiento correcto — resolver cuál se
 * queda es una decisión de negocio, no de un `ON CONFLICT`.
 */

const INDICE = 'ux_budget_budgets_un_real_por_anio';

exports.up = async function up(knex) {
  // ⛔ Pre-vuelo DENTRO de la migración, no sólo en el chat: si alguien la aplica en otro
  // entorno donde sí hay colisión, tiene que saber QUÉ año, no leer un error de Postgres.
  const { rows } = await knex.raw(`
    SELECT fiscal_year, count(*)::int AS n
      FROM budget.budgets
     WHERE is_test IS NOT TRUE
     GROUP BY fiscal_year
    HAVING count(*) > 1
     ORDER BY fiscal_year`);
  if (rows.length) {
    const detalle = rows.map((r) => `FY${r.fiscal_year} tiene ${r.n}`).join(' · ');
    throw new Error(
      `[TES.23] No se puede imponer un ejercicio real por año: ${detalle}. `
      + 'Cuál se queda es una decisión de negocio: resolvela antes de aplicar esta migración.',
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE}
        ON budget.budgets (tenant_id, fiscal_year)
     WHERE is_test IS NOT TRUE`);

  await knex.raw(`
    COMMENT ON INDEX budget.${INDICE} IS
      '[TES.23] Una sola verdad por año fiscal. El ejercicio is_test queda FUERA a proposito: es la copia y debe poder convivir con el real. Sin revisor humano -decision 2026-10-12, nadie firma- este indice es el unico control que impide dos versiones del mismo anio.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS budget.${INDICE}`);
};
