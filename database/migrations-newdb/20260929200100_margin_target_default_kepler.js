'use strict';
/**
 * `[PR.E0d]` — **El default de la meta deja de ser un 15 sin fuente y pasa a ser la política de
 * precios que Kepler ya aplica, ponderada por el peldaño que DE VERDAD se vende.**
 *
 * ── El antes ───────────────────────────────────────────────────────────────────────────────
 * `[PR.E0b]` sembró la fila default con **15**, con `source = 'default_medido'`. Ese 15 no salía
 * de ningún lado: era la constante que estaba clavada en tres archivos del código. Se conservó
 * para que el cambio fuera cero-diff, y se declaró como deuda. Esto la paga.
 *
 * ── ⭐⭐ EL HALLAZGO QUE DEFINE EL NÚMERO: el peldaño ──────────────────────────────────────
 * `[PR.E0c]` publicó la meta de Kepler por (sucursal, SKU, **peldaño**). La tentación era
 * ponderar el peldaño **base** por la venta — eso da **19.56 %**. Es un error de 8 pp, y se ve
 * en cuanto se pregunta *en qué peldaño ocurre la venta*:
 *
 *   | peldaño | venta 90 d | meta de Kepler |
 *   |---|---|---|
 *   | 1 · pieza      | $ 4,537,689 | 16.82 % |
 *   | 2 · mayoreo    | $29,622,251 | 11.34 % |
 *   | 3 · mayoreo    | $51,888,006 | 11.21 % |
 *
 * **El 94.5 % de la venta es mayoreo.** Ponderar por el peldaño vendido da **11.55 %**, con una
 * cobertura de pareo del **99.74 %** (el peldaño se identifica cruzando `factor_sale` de la venta
 * contra el `factor` de la escalera).
 *
 * ⭐ **Y lo valida un testigo independiente:** el negocio reporta un margen de **~11.5 %**. Dos
 * caminos que no se tocan —la ficha de precios de Kepler por un lado, el resultado que reporta
 * la empresa por el otro— dan el mismo número. Eso dice que **los precios se están fijando como
 * la política manda**, y que la brecha que el motor tiene que atacar no está en la meta: está en
 * la **fuga** (descuento sobre lista, 1.82 % medido en 30 d) y en el **costo real**.
 *
 * ⛔ Con el 15 clavado, el catálogo entero se veía "bajo meta" estando en meta. Con el 19.56 del
 * peldaño base se habría visto **peor**.
 *
 * ── Lo que esta migración NO hace ──────────────────────────────────────────────────────────
 * ⛔ No pisa una fila con `manual_lock` — si un humano la fijó, gana el humano (ADR-021/076).
 * ⛔ No inventa el número: lo **calcula** contra este destino. Si acá no hay venta con qué
 *    medirlo, **no toca nada y lo declara** (ADR-056) — un destino sin datos no es un destino
 *    con meta cero.
 * ⛔ No toca `margen_minimo`, que sigue **NULL con motivo** hasta que se resuelva D13.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const MT = 'commercial.margin_targets';

/** Rango de cordura. Fuera de esto el cálculo está mal, no el negocio. */
const MIN_PLAUSIBLE = 3;
const MAX_PLAUSIBLE = 60;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_kepler_margin_target') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.E0d] falta analytics.v_kepler_margin_target ([PR.E0c])');

  // ── El ANTES. Sin esto el commit cambia un número sin decir de cuánto a cuánto. ──────
  const [antes] = (await knex.raw(`
    SELECT margen_objetivo, source, manual_lock FROM ${MT}
     WHERE tenant_id = ? AND product_id IS NULL AND categoria IS NULL AND supplier_code IS NULL
     ORDER BY vigencia_desde DESC LIMIT 1`, [TENANT])).rows;

  if (!antes) {
    // eslint-disable-next-line no-console
    console.log('  ⓘ [PR.E0d] NO MEDIDO: no hay fila default en este destino. No se toca nada.');
    return;
  }
  if (antes.manual_lock) {
    // eslint-disable-next-line no-console
    console.log(`  ⓘ [PR.E0d] la fila default tiene manual_lock — la fijó un humano. `
      + `Se respeta (${antes.margen_objetivo}%). No se toca nada.`);
    return;
  }

  /**
   * ⭐ El cálculo. El peldaño vendido se identifica pareando el factor: `factor_sale` de la
   * venta contra el `factor` de la escalera de Kepler. NO se asume el peldaño base — asumirlo
   * es el error de 8 pp que esta migración existe para no cometer.
   */
  const [m] = (await knex.raw(`
    WITH s AS (
      SELECT source_branch AS sucursal, sku, factor_sale, sum(monto_neto) AS venta
        FROM analytics.mv_kepler_sales_daily
       WHERE business_date >= CURRENT_DATE - 90 AND monto_neto > 0
       GROUP BY 1, 2, 3
    ), pareado AS (
      SELECT s.venta, m.margen_venta_pct
        FROM s
        JOIN analytics.v_kepler_margin_target m
          ON m.sucursal = s.sucursal
         AND m.sku      = s.sku
         AND m.veredicto = 'capturado'
         AND abs(COALESCE(m.factor, 1) - COALESCE(s.factor_sale, 1)) < 0.01
    )
    SELECT round((sum(venta * margen_venta_pct) / NULLIF(sum(venta), 0))::numeric, 3) AS meta,
           round(sum(venta)::numeric, 0) AS venta_pareada,
           count(*)::int AS filas
      FROM pareado`)).rows;

  if (!m || m.meta === null) {
    // eslint-disable-next-line no-console
    console.log('  ⓘ [PR.E0d] NO MEDIDO: sin venta pareada en este destino. '
      + `Se deja el default como está (${antes.margen_objetivo}%) y se declara.`);
    return;
  }

  const meta = Number(m.meta);
  if (!(meta > MIN_PLAUSIBLE && meta < MAX_PLAUSIBLE)) {
    throw new Error(`[PR.E0d] la meta calculada (${meta}%) está fuera del rango de cordura `
      + `(${MIN_PLAUSIBLE}–${MAX_PLAUSIBLE}). Eso es un cálculo roto, no un negocio raro.`);
  }

  await knex(MT)
    .where({ tenant_id: TENANT })
    .whereNull('product_id').whereNull('categoria').whereNull('supplier_code')
    .update({
      margen_objetivo: meta,
      source: 'kepler_ponderado_peldano_vendido',
      updated_at: knex.fn.now(),
    });

  // eslint-disable-next-line no-console
  console.log(`  · [PR.E0d] meta default ${antes.margen_objetivo}% (${antes.source}) → `
    + `${meta}% (kepler_ponderado_peldano_vendido) · pareado $`
    + `${Number(m.venta_pareada).toLocaleString()} en ${m.filas} combos`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const [d] = (await knex.raw(`
    SELECT count(*)::int n,
           max(margen_objetivo) AS obj,
           count(*) FILTER (WHERE margen_minimo IS NOT NULL)::int con_piso
      FROM ${MT}
     WHERE tenant_id = ? AND product_id IS NULL AND categoria IS NULL AND supplier_code IS NULL`,
  [TENANT])).rows;

  if (d.n !== 1) {
    throw new Error(`[PR.E0d] debe haber EXACTAMENTE una fila default y hay ${d.n}.`);
  }
  if (Number(d.obj) !== meta) {
    throw new Error(`[PR.E0d] el update no pegó: la fila dice ${d.obj}, se esperaba ${meta}.`);
  }
  // ⛔ El piso sigue sin determinarse (D13). Si alguien lo rellenó de paso, hay que saberlo.
  if (d.con_piso > 0) {
    throw new Error('[PR.E0d] el default ganó un margen_minimo y D13 sigue abierta — '
      + 'un piso dibujado decide precios.');
  }
};

exports.down = async function down(knex) {
  // Vuelve al 15 declarado de [PR.E0b]. No es "el valor bueno": es el valor anterior.
  await knex(MT)
    .where({ tenant_id: TENANT })
    .whereNull('product_id').whereNull('categoria').whereNull('supplier_code')
    .update({ margen_objetivo: 15, source: 'default_medido', updated_at: knex.fn.now() });
};
