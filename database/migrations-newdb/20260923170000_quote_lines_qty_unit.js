/**
 * `[COT.1b]` — El renglón de una cotización DICE en qué peldaño se cotizó.
 *
 * ── El hueco, medido ────────────────────────────────────────────────────────────────────────
 *
 * `addLine` acepta `rung` (`base` | `pack` | `box`), el motor **precia con él** —el precio de
 * una caja no es el de una pieza— y `insertLine` **no lo escribe**. Leyendo la fila guardada no
 * se puede saber si el `10` eran 10 piezas o 10 cajas. El precio queda; la unidad se pierde.
 *
 * Y no queda ni el rastro indirecto: `requested_text` se fuerza a NULL cuando hay `product_id`
 * (`quote-pricing.service.ts:560`), así que tampoco sobrevive lo que se tecleó.
 *
 * Es exactamente la falla que `[VU.0]` puso por escrito — *una cantidad que no dice su unidad no
 * es un dato, es un número*— y que ADR-055 ya cobró en `replenishment_plan.stock_pz` por
 * **$866,805 de sobre-pedido** y **$2.68M de inventario invisible**.
 *
 * ── El vocabulario NO se inventa ────────────────────────────────────────────────────────────
 *
 * Las mismas TRES columnas, con los mismos nombres y el mismo dominio que ya llevan
 * `commercial.order_lines`, `commercial.vendor_sale_lines` y `commercial.stock_movements`
 * (mig `20260912040000_qty_unit_stamp.js`, contrato en
 * `libs/contracts/src/http/quantity-unit.contract.ts`). Una cuarta forma de decir lo mismo sería
 * un segundo resolvedor disfrazado.
 *
 * ⭐ Con UN valor nuevo en el dominio, y está medido, no supuesto: `kepler_ladder`. El motor de
 * cotizaciones saca el factor de `analytics.v_label_prices`, que deriva `pack_size`/`box_size`
 * de **las dos ranuras de unidad de `kdii`** — `c83`/`c84` y, si esa no trae el rótulo,
 * `c80`/`c81` (ver el `CROSS JOIN LATERAL` de `20260919140000_v_label_prices.js`). Rotularlo
 * `kepler_c84` afirmaría una procedencia que en la rama `c81` es **falsa**.
 *
 * ── Aditiva y sin rellenar ──────────────────────────────────────────────────────────────────
 *
 * ⛔ Las filas ya escritas se quedan en NULL. El contrato `[VU.0]` lo prohíbe explícitamente:
 * *"el día que alguien escriba 'pieza' sobre las filas viejas para completar, habrá convertido
 * una ignorancia medible en una afirmación falsa"*. NULL no es pieza: es "no se registró".
 *
 * El conteo antes/después es el candado de que esta migración no tocó ni una fila.
 */
'use strict';

const TABLA = 'commercial.quote_lines';

const COMENTARIOS = {
  qty_unit:
    'COT.1b - El peldano en que se COTIZO el renglon, con el rotulo del ERP (PZA, PAQ, CJA...). '
    + 'Mismo campo que commercial.order_lines.qty_unit. NULL = no se registro (renglon anterior a '
    + 'esta migracion, o renglon sin casar que nunca tuvo peldano). NULL NO es pieza.',
  qty_factor:
    'COT.1b - Cuantas unidades base trae ese peldano (v_label_prices.pack_size/box_size). '
    + 'NULL = el peldano era la base, o no se pudo resolver.',
  qty_factor_source:
    'COT.1b - Con que autoridad. kepler_ladder = la escalera de precio del ERP via '
    + 'v_label_prices (las DOS ranuras de kdii: c83/c84 o c80/c81). No es kepler_c84: rotularlo '
    + 'asi seria falso en la rama c81. Resto del dominio, igual que order_lines.',
};

exports.up = async function up(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [TABLA]);
  if (!existe.rows[0].t) {
    console.log(`  [cot1b] ${TABLA} no existe en esta DB — se salta`);
    return;
  }

  const antes = Number((await knex(TABLA).count('* as n'))[0].n);

  if (!(await knex.schema.withSchema('commercial').hasColumn('quote_lines', 'qty_unit'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN qty_unit varchar(16)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('quote_lines', 'qty_factor'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN qty_factor numeric(14,4)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('quote_lines', 'qty_factor_source'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN qty_factor_source varchar(24)`);
  }

  // ⚠️ COMMENT ON no admite parámetros de bind: el texto va inline con las comillas simples
  // escapadas a mano. Un `?` de knex ahí da "syntax error at or near $1".
  for (const [col, txt] of Object.entries(COMENTARIOS)) {
    await knex.raw(`COMMENT ON COLUMN ${TABLA}.${col} IS '${txt.replace(/'/g, "''")}'`);
  }

  // Un factor tiene que ser un factor: 0 o negativo convertiría la cantidad en basura, y el
  // día que alguien escriba 0 acá el renglón se lee como "cero unidades base por peldaño".
  const yaTieneCheck = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'commercial_quote_lines_qty_factor_positive'`,
  );
  if (!yaTieneCheck.rows.length) {
    await knex.raw(
      `ALTER TABLE ${TABLA}
         ADD CONSTRAINT commercial_quote_lines_qty_factor_positive
         CHECK (qty_factor IS NULL OR qty_factor > 0)`,
    );
  }

  const despues = Number((await knex(TABLA).count('* as n'))[0].n);
  const sinUnidad = Number((await knex(TABLA).whereNull('qty_unit').count('* as n'))[0].n);
  console.log(
    `  [cot1b] ${TABLA}: ${despues} filas · ${sinUnidad} sin peldaño declarado`
    + ' (histórico, NO se rellena — VU.0)',
  );

  if (antes !== despues) {
    throw new Error(
      `${TABLA} cambió de ${antes} a ${despues} filas: esta migración sólo agrega columnas.`,
    );
  }
};

exports.down = async function down(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [TABLA]);
  if (!existe.rows[0].t) return;
  await knex.raw(
    `ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS commercial_quote_lines_qty_factor_positive`,
  );
  for (const col of ['qty_unit', 'qty_factor', 'qty_factor_source']) {
    if (await knex.schema.withSchema('commercial').hasColumn('quote_lines', col)) {
      await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${col}`);
    }
  }
};
