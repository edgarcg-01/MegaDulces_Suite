'use strict';
/**
 * `[E.25]` — El renglón de una cotización guarda SU impuesto: IVA e IEPS del producto, por separado.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · El servidor descomponía TODO total con IVA 16 % fijo (`DEFAULT_TAX_RATE`). En los renglones
 *    cotizados en prod: 182 de 217 ($454,298, 86 %) son productos con IEPS 8 % e IVA 0.
 *  · Kepler calcula el impuesto con la tasa de CADA producto: `kdii.c18` (IVA) y `c19` (IEPS),
 *    negativas = incluidas en el precio. La del maestro = la del renglón del pedido (`kdm2.c17/c18`)
 *    en 2,011 de 2,011 renglones de telemarketing.
 *  · Replay (AUDITORIA_COTIZACIONES §11–§12): con la tasa de cada producto, IVA (`kdm1.c14`) e IEPS
 *    (`c15`) cuadran al centavo en 79 de 79 pedidos; con el 16 % fijo, el IVA en 25.
 *
 * ── Por qué dos columnas y no sólo `tax_rate` ───────────────────────────────────────────────
 * El documento de Kepler separa IVA de IEPS, y una sola tasa no deja reconstruir cuál es cuál.
 * `tax_rate` (NOT NULL) sigue existiendo y pasa a valer iva + ieps.
 *
 * ── Aditiva y sin rellenar ──────────────────────────────────────────────────────────────────
 * ⛔ Los renglones ya escritos se quedan en NULL: "no se registró". Rellenarlos con la tasa de
 * HOY afirmaría la de entonces (mismo criterio que COT.1b / VU.0). La cuenta compartida
 * (`libs/contracts` `totalesCotizacion`) los trata como IVA 16 % ASUMIDO y lo DECLARA.
 *
 * Idempotente. El conteo antes/después es el candado de que no tocó ni una fila.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.quote_lines';

const COMENTARIOS = {
  iva_rate:
    'E.25 - Tasa de IVA del producto al cotizar (0.16 = 16 %), de kepler_ods.kdii.c18 (negativa = '
    + 'incluida en el precio). NULL = renglon anterior a E.25: no se registro (la cuenta lo trata '
    + 'como IVA 16 % asumido y lo declara).',
  ieps_rate:
    'E.25 - Tasa de IEPS del producto al cotizar (0.08 = 8 %), de kepler_ods.kdii.c19. NULL = no '
    + 'se registro. tax_rate = iva_rate + ieps_rate.',
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [TABLA]);
  if (!existe.rows[0].t) {
    console.log(`  [e25] ${TABLA} no existe en esta DB — se salta`);
    return;
  }
  const antes = Number((await knex(TABLA).count('* as n'))[0].n);

  for (const col of Object.keys(COMENTARIOS)) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('quote_lines', col))) {
      await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${col} numeric(5,4)`);
    }
    // COMMENT ON no admite parámetros de bind: el texto va inline con las comillas escapadas.
    await knex.raw(`COMMENT ON COLUMN ${TABLA}.${col} IS '${COMENTARIOS[col].replace(/'/g, "''")}'`);
  }

  // Una tasa es una fracción entre 0 y 1: un 16 escrito como entero multiplicaría el impuesto ×100.
  const yaTieneCheck = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'commercial_quote_lines_tax_rates_fraction'`,
  );
  if (!yaTieneCheck.rows.length) {
    await knex.raw(
      `ALTER TABLE ${TABLA}
         ADD CONSTRAINT commercial_quote_lines_tax_rates_fraction
         CHECK ((iva_rate IS NULL OR (iva_rate >= 0 AND iva_rate < 1))
            AND (ieps_rate IS NULL OR (ieps_rate >= 0 AND ieps_rate < 1)))`,
    );
  }

  const despues = Number((await knex(TABLA).count('* as n'))[0].n);
  console.log(`  [e25] ${TABLA}: ${despues} filas · las existentes quedan con tasa NULL (no se rellena)`);
  if (antes !== despues) {
    throw new Error(`${TABLA} cambió de ${antes} a ${despues} filas: esta migración sólo agrega columnas.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [TABLA]);
  if (!existe.rows[0].t) return;
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS commercial_quote_lines_tax_rates_fraction`);
  for (const col of Object.keys(COMENTARIOS)) {
    if (await knex.schema.withSchema('commercial').hasColumn('quote_lines', col)) {
      await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${col}`);
    }
  }
};
