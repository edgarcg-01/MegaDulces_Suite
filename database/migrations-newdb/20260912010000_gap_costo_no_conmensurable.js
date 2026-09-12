/**
 * VA.4 — EL COSTO: KEPLER AL ÁRBITRO, WINCAJA DECLARADO.
 *
 * Edgar, 2026-09-11: *"me interesa tener una verdad absoluta en Kepler, Wincaja no me importa"*.
 *
 * `commercial-replenishment` valuaba con `COALESCE(pr.cost_with_tax, pr.cost_base, 0)`: el
 * catálogo, que da UN costo por producto cuando el **86%** tiene más de uno (10,053 productos,
 * 8,626 con varios valores entre almacenes), y encima prefería el BRUTO — sobre la existencia
 * valuaba **$5,270,072 (7.72%)** de más, ~$3.0M de eso IVA colado. El árbitro está NETO:
 * mediana contra `cost_base` exactamente **1.0000** sobre 146,432 pares.
 *
 * ── ⛔ Lo que paró el cambio a ciegas ───────────────────────────────────────────────────────
 *
 * Cablear las DOS piernas subía el sugerido **+36.79% ($17,092,646)** en vez del −8% esperado, y
 * las razones lo dijeron todo:
 *
 * ```text
 * 70031 CHOC EST SUIZO /16      5.40 ->    86.35   x15.99   wincaja_costo_promedio
 * 18022 CAJETA ENVINADA 25KG   41.34 ->  2066.93   x50.00   wincaja_costo_promedio
 * 70043 GOMA A GRANEL 12KG     54.37 ->   652.46   x12.00   wincaja_costo_promedio
 * ```
 *
 * **Las razones SON los factores de caja, y todas de Wincaja**: ahí el `costo_promedio` viene por
 * la unidad de venta (el paquete, ADR-055) y `reorder_policy.max_stock` está en PIEZAS.
 *
 * ⚠️ **Y NO es sistemético** — la primera versión de este hueco lo decía mal. Dividir por el factor
 * EMPEORA: la razón mediana pasa de 0.9999 a **0.0600** y los pegados caen de 6,731 a 745. El
 * **67%** de Wincaja ya coincide con el catálogo; el daño lo concentra un subconjunto (granel
 * 12/25 KG, multipacks) que carga volúmenes enormes. **Contar filas ordena al revés que contar
 * pesos** (R6) — tercera vez el mismo día.
 *
 * ── ⭐ Por qué Kepler SÍ se cablé ────────────────────────────────────────────────────────────
 *
 * ```text
 * razon arbitro/catalogo: p10 0.8405 · mediana 0.9259 · p90 1.0014   (= 1/(1+IVA))
 * dentro de la banda fiscal 0.80-1.05 .... 19,340 de 20,917 = 92.46%
 * con la FIRMA de unidad cruzada ......... 0
 * ```
 *
 * Cero filas con la firma. En Kepler el cambio es **sólo la corrección de impuesto**: el sugerido
 * baja **−10.64%** ($13,117,950 → $11,722,814), y esa baja es correcta — el IVA de compra es
 * **acreditable**, no es un costo.
 *
 * El código usa un `CASE` por ERP (el patrón de ADR-059 R1 y KE.3), **no** un COALESCE: cada ERP
 * se juzga con SU evidencia. Wincaja se queda con el catálogo **por decisión de alcance**, y este
 * hueco es esa decisión escrita con su monto.
 *
 * ⭐⭐ La lección, más grande que este eje: **que un resolvedor sea CANÓNICO no lo hace
 * CONMENSURABLE con la cantidad que lo multiplica.** VA.3 (el factor de caja) se pudo cortar de un
 * saque porque un factor es **adimensional**; un costo no. KE.1/KE.3 no lo sufren con el MISMO
 * árbitro porque valúan contra `qty_stock_units`, que está en la unidad nativa — el mismo marco
 * que el costo. El reabasto normaliza a piezas.
 *
 * @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

// Mide el tamaño en filas donde el costo del arbitro y la cantidad del reabasto NO comparten
// unidad. La firma es que la razon contra el catalogo se pega al factor de caja del almacen.
const RECHECK = `
  WITH z AS (
    SELECT euc.costo_unitario::numeric cu,
           COALESCE(p.cost_with_tax, p.cost_base)::numeric cat
      FROM commercial.reorder_policy rp
      JOIN catalog.products p ON p.id = rp.product_id AND p.tenant_id = rp.tenant_id
      JOIN analytics.v_erp_unit_cost euc
        ON euc.tenant_id = rp.tenant_id AND euc.warehouse_id = rp.warehouse_id
       AND euc.product_id = rp.product_id
     WHERE rp.tenant_id = '${T}'
       AND euc.costo_source = 'wincaja_costo_promedio'
       AND euc.costo_unitario > 0
       AND COALESCE(p.cost_with_tax, p.cost_base, 0) > 0)
  SELECT (count(*) FILTER (WHERE cu / cat > 3) > 0) AS sigue_siendo_hueco,
         count(*) FILTER (WHERE cu / cat > 3) || ' de ' || count(*) ||
         ' filas Wincaja con el costo a escala de PAQUETE contra una cantidad en piezas ' ||
         '(razon > 3x). El resto (' || count(*) FILTER (WHERE abs(cu/cat - 1) <= 0.10) ||
         ') coincide con el catalogo dentro del 10%: NO es sistemico' AS detalle
    FROM z`;

exports.up = async function up(knex) {
  const r = (await knex.raw(RECHECK)).rows[0];
  if (!r || typeof r.sigue_siendo_hueco !== 'boolean') {
    throw new Error(`el recheck no cumple el contrato: ${JSON.stringify(r)}`);
  }
  console.log(`  [va4] ${r.detalle}`);
  if (r.sigue_siendo_hueco !== true) {
    throw new Error('el recheck dice que NO hay filas con la firma de unidad cruzada, pero el '
      + 'antes/despues medido dio +36.79% con razones pegadas al factor de caja. Revisar');
  }

  await knex('analytics.declared_gaps')
    .insert({
      tenant_id: T,
      clave: 'costo_arbitro_no_conmensurable_reabasto',
      titulo: 'El costo arbitrado y la cantidad del reabasto no comparten unidad',
      monto: 17092646,
      unidad: 'MXN de sugerido inflado si se cablea a ciegas',
      declarado_en: '2026-09-11',
      motivo: 'En una PARTE de la pierna Wincaja, analytics.v_erp_unit_cost trae el costo a '
        + 'escala de PAQUETE (la unidad de venta de Wincaja, ADR-055) mientras '
        + 'commercial.reorder_policy.max_stock esta en PIEZAS. Cablear el arbitro al sugerido sin '
        + 'reconciliar la unidad lo inflaba +36.79% ($17,092,646), con razones pegadas EXACTAS al '
        + 'factor de caja (x15.99, x50.00, x12.00, x20.00). '
        + '⚠️ NO es sistemico y la primera version de este hueco lo decia mal: dividir por el '
        + 'factor EMPEORA (razon mediana 0.9999 -> 0.0600, pegados 6,731 -> 745). El 67% de '
        + 'Wincaja coincide con el catalogo; el dano lo concentra un subconjunto (granel 12/25 KG, '
        + 'multipacks) que carga volumenes enormes -- contar filas ordena al reves que contar '
        + 'pesos (R6). '
        + 'La pierna KEPLER no lo sufre: razon p10 0.8405 / mediana 0.9259 / p90 1.0014 (= el '
        + 'IVA), 92.46% en banda fiscal y CERO filas con la firma de unidad cruzada -- por eso SI '
        + 'se cableo al arbitro (VA.4), y Wincaja quedo con el catalogo por decision de alcance '
        + '(Edgar 2026-09-11: la verdad absoluta se quiere en Kepler).',
      resolver_faltante: 'un costo por unidad de la MISMA cantidad que lo multiplica '
        + '(costo_unitario / display_box_factor en los almacenes Wincaja), o llevar la cantidad '
        + 'del reabasto a la unidad nativa. Las dos mueven dinero de la compra: piden su propio '
        + 'antes/despues, no se hacen a ciegas.',
      estado: 'abierto',
      recheck_sql: RECHECK,
      ultima_medicion: knex.fn.now(),
      ultimo_detalle: r.detalle,
    })
    .onConflict(['tenant_id', 'clave'])
    .merge(['titulo', 'monto', 'unidad', 'motivo', 'resolver_faltante', 'recheck_sql',
      'estado', 'ultima_medicion', 'ultimo_detalle']);

  const n = (await knex('analytics.declared_gaps').where({ tenant_id: T }).count('* as n'))[0].n;
  console.log(`  [va4] la tabla queda con ${n} huecos declarados`);
};

exports.down = async function down(knex) {
  await knex('analytics.declared_gaps')
    .where({ tenant_id: T, clave: 'costo_arbitro_no_conmensurable_reabasto' }).del();
};
