'use strict';
/**
 * `[PVI.4]` — El `COMMENT` de `growth_provenance` enumera los `basis` posibles, y se quedó corto.
 *
 * `[PVI.3]` (migración `20261008180749`, batch 853 en prod) dejó escrito en la columna:
 *   *«basis: yoy_paired (medido) | global (heredó el del total) | default (NO se pudo medir) |
 *     manual (lo puso una persona)»*
 *
 * Hoy existe un quinto, y no es cosmético: **`preexistente`**. Nació de medir, el 2026-10-09 a las
 * 09:19 MX, que la columna seguía **NULL en los 3 ejercicios** aunque el código ya estaba
 * desplegado (`commit 4e963f78`) y el cron había corrido esa madrugada con `status: ok`:
 *
 *   analytics.cron_runs job_key=budget_autopilot → 2026-10-09 07:30:06 -06 · ok · 2497 celdas
 *   budget.sales_plan_settings → growth_provenance NULL x3
 *
 * La causa fue doble, y la segunda estaba escondida por la primera (detalle y candado en
 * `libs/finance/src/lib/budget/budget-growth-provenance.engine.ts`):
 *
 *  (A) el `upsert` preguntaba por `derivado` en vez de por la procedencia, así que con los 4
 *      canales ya guardados **nunca escribía**;
 *  (B) y si (A) se arreglaba solo, estampaba `manual` sobre valores que había escrito una pasada
 *      VIEJA del autopilot — o sea **certificaba como decisión humana** el `+26.67 %` de `mayoreo`,
 *      que mide **−9.36 %**, sobre **$169,970,622** de meta.
 *
 * ⭐ `preexistente` es el estado que faltaba: *hay un número y nadie puede decir de dónde salió*.
 *    No es `manual` (nadie firmó) ni `default` (no se midió hoy). Las dos ausencias no son la
 *    misma — `default` la arregla el motor recomputando, `preexistente` la arregla una PERSONA
 *    decidiendo. ADR-056.
 *
 * ── Por qué esto es una migración y no editar el archivo de PVI.3 ───────────────────────────
 *
 * El comentario **ya está persistido en producción**. Cambiar el `.js` de una migración aplicada
 * no mueve un solo byte de la base: el texto viejo seguiría ahí, enumerando cuatro valores de una
 * columna que ahora admite cinco. Es exactamente la lección de `[CDRP.2.1]` — *un comentario no
 * avisa cuando deja de ser cierto*. Y renombrar o reescribir una migración aplicada está
 * prohibido (Knex valida `knex_migrations` contra el filesystem).
 *
 * Sólo toca metadatos: ni un dato cambia, ni una fila se escribe. `NULL` sigue significando lo
 * mismo que el 8 de octubre.
 *
 * Idempotente (un `COMMENT ON` es un reemplazo, no un acumulado).
 *
 * ⛔ **`COMMENT ON` NO acepta parámetros.** Primer intento contra prod (2026-10-09 09:4x):
 *     COMMENT ON COLUMN budget.sales_plan_settings.growth_provenance IS $1
 *     → syntax error at or near "$1"
 * Es una sentencia de **utilidad**: Postgres no la planea, así que no hay dónde atar un bind.
 * `knex.raw(sql, [valor])` traduce su `?` a `$1` y revienta. El texto va **inlineado**, con las
 * comillas simples duplicadas. ⭐ Falló limpio: el ledger NO registró la migración y el comentario
 * quedó como estaba — se verificó antes de reintentar, porque «falló» y «falló sin dejar rastro»
 * no son lo mismo.
 *
 * @param { import("knex").Knex } knex
 */

/** Literal SQL seguro: duplica las comillas simples. No hay interpolación de datos externos acá
 *  —los dos textos son constantes de este archivo— pero se escapa igual, porque la regla no es
 *  «cuando viene de afuera», es «siempre que se arma SQL con una cadena». */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const TABLA = 'budget.sales_plan_settings';
const COL = 'growth_provenance';

const COMENTARIO_NUEVO = `[PVI.3/PVI.4] Procedencia de growth_by_channel, misma llave de canal: {basis, paired_periods, years_used, cobertura, at}. basis: yoy_paired (medido) | global (heredo el del total) | default (se intento medir y NO alcanzo) | preexistente (hay numero y NADIE puede decir de donde salio: lo escribio una pasada anterior a PVI.3) | manual (lo puso una persona y el autopilot lo respeta). NULL = la fila se guardo antes de PVI.3 y su procedencia NO se puede reconstruir sin recomputar - no es {} ni "sin procedencia", es desconocida. OJO: preexistente NO es manual - estampar manual ahi certifica como decision humana un numero que nadie firmo.`;

const COMENTARIO_VIEJO = `[PVI.3] Procedencia de growth_by_channel, misma llave de canal: {basis, paired_periods, years_used, cobertura}. basis: yoy_paired (medido) | global (heredó el del total) | default (NO se pudo medir) | manual (lo puso una persona). NULL = la fila se guardó antes de PVI.3 y su procedencia NO se puede reconstruir sin recomputar — no es {} ni "sin procedencia", es desconocida.`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // Si la columna no existe, no hay nada que comentar: la migración de PVI.3 no corrió acá.
  const existe = await knex.schema.withSchema('budget').hasColumn('sales_plan_settings', COL);
  if (!existe) return;

  await knex.raw(`COMMENT ON COLUMN ${TABLA}.${COL} IS ${lit(COMENTARIO_NUEVO)}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: devuelve el texto de PVI.3, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = await knex.schema.withSchema('budget').hasColumn('sales_plan_settings', COL);
  if (!existe) return;
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.${COL} IS ${lit(COMENTARIO_VIEJO)}`);
};
