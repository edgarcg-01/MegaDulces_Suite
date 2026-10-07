/**
 * VU.1 — LA UNIDAD VIAJA CON LA CANTIDAD (las tres columnas, en las tablas donde un humano captura).
 *
 * Edgar, 2026-09-12: *"¿ya tenemos una verdad absoluta en todo lugar donde se muevan unidades,
 * existencias y ventas?"* → medido: **no**, y el hueco está del lado de la ESCRITURA.
 *
 * ── Lo que se midió, incluida una recomendación mía mal apuntada ─────────────────────────────
 *
 * Censo en prod: **12 tablas con columna de cantidad y ninguna de unidad al lado** contra 18 que la
 * declaran — y de esas 18, varias son falsos positivos de la regex (`unit_price`, `units_window`
 * no dicen la unidad de nada). ⚠️ Una primera medición mía dijo **22**: estaba inflada porque la
 * regex de cantidad incluía `counted|contado|conteo` y agarraba `counted_at`/`counted_by`, que son
 * fecha y usuario. El censo es un PISO, no un techo.
 *
 * ⚠️ Yo había recomendado arrancar por `commercial.stock_movements` y `commercial.order_lines`
 * *"donde un humano captura y el error es invisible"*. Al medirlas: **17 y 53 filas**. El error era
 * invisible porque casi no hay nada. Conté TABLAS, no realidad — el mismo error de R6 que este
 * proyecto ya pagó cinco veces. El volumen real está en `stock_lots` (68,843) y `stock` (63,583),
 * que son ESPEJO del ERP y que la verdad absoluta manda **no leer** (§5: la existencia sale de
 * `analytics.v_erp_stock_on_hand`, no de `commercial.stock`, que acierta 91%). Anotarlas seria
 * trabajo perdido sobre tablas que no se consultan.
 *
 * ── Por qué igual se hacen estas tres ───────────────────────────────────────────────────────
 *
 * Porque el problema es **prospectivo**: las tablas están casi vacías justamente porque la app
 * todavía no es el sistema de registro del movimiento, y las fases VR (venta en ruta), LM (última
 * milla) y RE (recepción) van a llenarlas. Poner la forma AHORA cuesta una columna nullable;
 * ponerla después cuesta una migración de datos sobre cifras que ya se publicaron.
 *
 * ```text
 *   commercial.order_lines ........... 53 filas   <- pedidos (portal, vendedor, bot, telemarketing)
 *   commercial.vendor_sale_lines .. 1,303 filas   <- captura del vendedor en tienda (OCR)
 *   commercial.stock_movements ....... 17 filas   <- la maquina de estados de inventario
 * ```
 *
 * ── Las tres columnas, y por qué las tres admiten NULL ──────────────────────────────────────
 *
 * `qty_unit` · `qty_factor` · `qty_factor_source`, con la forma y el vocabulario de
 * `libs/contracts/src/http/quantity-unit.contract.ts` — que reusa los rótulos de
 * `v_unit_truth.base_label` y los veredictos de `v_product_box_factor.source`, en vez de inventar
 * una enumeración paralela (un vocabulario paralelo es un segundo resolvedor disfrazado).
 *
 * ⛔ **Las filas existentes NO se rellenan.** 1,373 filas se quedan con las tres en `null`, y eso
 * es correcto: nadie registró en qué unidad se capturaron y `'pieza'` no es sinónimo de "no sé".
 * Escribir un default sobre ellas convertiría una ignorancia medible en una afirmación falsa.
 *
 * ⚠️ `ADD COLUMN` nullable sin default no reescribe la tabla en Postgres: es metadata. Por eso
 * puede correr en horario hábil sobre tablas vivas.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = [
  ['commercial', 'order_lines'],
  ['commercial', 'vendor_sale_lines'],
  ['commercial', 'stock_movements'],
];

const COMENTARIOS = {
  qty_unit: 'VU.1 - En que unidad lo escribio QUIEN lo escribio (PZA, PAQ, CJA, KG...), con el '
    + 'rotulo del ERP (analytics.v_unit_truth.base_label). NULL = no se registro. ⛔ NULL no es '
    + 'pieza: es "no se", y ningun consumidor puede suponerlo.',
  qty_factor: 'VU.1 - El factor aplicado para llegar a quantity (quantity = capturado x factor). '
    + 'NULL = no hubo conversion, o no se sabe cual.',
  qty_factor_source: 'VU.1 - Con que autoridad se aplico ese factor. Mismos valores que '
    + 'analytics.v_product_box_factor.source, mas captura_directa (no hubo conversion). '
    + '⛔ default significa que el 1 es un respaldo, NO una afirmacion.',
};

exports.up = async function up(knex) {
  for (const [sch, tab] of TABLAS) {
    const existe = await knex.raw(`SELECT to_regclass(?) t`, [`${sch}.${tab}`]);
    if (!existe.rows[0].t) {
      console.log(`  [vu1] ${sch}.${tab} no existe en esta DB — se salta`);
      continue;
    }
    const antes = Number((await knex(`${sch}.${tab}`).count('* as n'))[0].n);

    if (!(await knex.schema.withSchema(sch).hasColumn(tab, 'qty_unit'))) {
      await knex.raw(`ALTER TABLE ${sch}.${tab} ADD COLUMN qty_unit varchar(16)`);
    }
    if (!(await knex.schema.withSchema(sch).hasColumn(tab, 'qty_factor'))) {
      await knex.raw(`ALTER TABLE ${sch}.${tab} ADD COLUMN qty_factor numeric(14,4)`);
    }
    if (!(await knex.schema.withSchema(sch).hasColumn(tab, 'qty_factor_source'))) {
      await knex.raw(`ALTER TABLE ${sch}.${tab} ADD COLUMN qty_factor_source varchar(24)`);
    }
    // ⚠️ COMMENT ON no admite parametros de bind: el texto va inline, con las comillas
    // simples escapadas a mano. Un `?` de knex ahi da "syntax error at or near $1".
    for (const [col, txt] of Object.entries(COMENTARIOS)) {
      await knex.raw(`COMMENT ON COLUMN ${sch}.${tab}.${col} IS '${txt.replace(/'/g, "''")}'`);
    }

    const despues = Number((await knex(`${sch}.${tab}`).count('* as n'))[0].n);
    const sinUnidad = Number((await knex(`${sch}.${tab}`).whereNull('qty_unit').count('* as n'))[0].n);
    console.log(`  [vu1] ${sch}.${tab}: ${despues} filas · ${sinUnidad} sin unidad declarada`
      + ' (histórico, NO se rellena)');

    if (antes !== despues) {
      throw new Error(`${sch}.${tab} cambio de ${antes} a ${despues} filas: esta migracion solo `
        + 'agrega columnas, no toca datos');
    }
    if (sinUnidad !== despues) {
      throw new Error(`${sch}.${tab}: ${despues - sinUnidad} filas ya traen qty_unit. Esta `
        + 'migracion es la que crea la columna, asi que alguien la relleno — y rellenar el '
        + 'historico con un default es exactamente lo que ADR-056 prohibe');
    }
  }

  // ── PRUEBA NEGATIVA — que las columnas EXISTAN de verdad y sean nullables ──────────────────
  // Un `hasColumn` que devuelve true sobre una columna NOT NULL con default seria el defecto que
  // esta migracion existe para evitar: un rotulo obligatorio se rellena solo, y un relleno es una
  // afirmacion que nadie hizo.
  const chk = (await knex.raw(`
    SELECT table_schema||'.'||table_name AS tabla, column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'commercial'
       AND table_name IN ('order_lines','vendor_sale_lines','stock_movements')
       AND column_name IN ('qty_unit','qty_factor','qty_factor_source')
     ORDER BY 1, 2`)).rows;
  if (chk.length !== 9) {
    throw new Error(`se esperaban 9 columnas (3 tablas x 3) y hay ${chk.length}`);
  }
  const obligatorias = chk.filter((r) => r.is_nullable === 'NO' || r.column_default !== null);
  if (obligatorias.length) {
    throw new Error('alguna columna quedo NOT NULL o con default: '
      + `${obligatorias.map((r) => `${r.tabla}.${r.column_name}`).join(', ')}. La ausencia de `
      + 'unidad tiene que poder EXISTIR como ausencia');
  }
  console.log('  [vu1] 9 columnas creadas, las 9 nullables y sin default: la ausencia se puede declarar');
};

exports.down = async function down(knex) {
  for (const [sch, tab] of TABLAS) {
    const existe = await knex.raw(`SELECT to_regclass(?) t`, [`${sch}.${tab}`]);
    if (!existe.rows[0].t) continue;
    for (const col of ['qty_unit', 'qty_factor', 'qty_factor_source']) {
      await knex.raw(`ALTER TABLE ${sch}.${tab} DROP COLUMN IF EXISTS ${col}`);
    }
  }
};
