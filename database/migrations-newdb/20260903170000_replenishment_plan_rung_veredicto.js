/**
 * U.2 — el veredicto del peldaño baja al fact `analytics.replenishment_plan`.
 *
 * POR QUÉ (medido, no supuesto). `analytics.v_unit_rung_audit` es la fuente de verdad del veredicto
 * y se queda como tal: es la vista auditable donde se ve la aritmética completa (divisor usado vs.
 * divisor que implica el costo pagado). Pero cuesta **8.2 s** para las 552 filas marcadas y **25 s**
 * para el tenant entero: deriva la escalera de costo del proveedor, el factor de caja por almacén y
 * la existencia de Wincaja en una sola pasada, con seq scans de `kdpv_prov_prod` (67k),
 * `product_label_prices` (9k), `products` (×2) y un bitmap scan de `wincaja.articulos`.
 *
 * Los seis consumidores de esto son pantallas interactivas. `transferPlan` necesita el veredicto de
 * DOS almacenes por fila (destino y origen): al joinear la vista dos veces, esa página pasó de
 * **4.5 s a 29 s**. Inaceptable — y no es un hotspot que se arregle moviendo un índice: la vista es
 * ancha por diseño.
 *
 * Patrón: **el nocturno paga una vez, los lectores no pagan nada** (el mismo híbrido que ya usan las
 * vistas lentas de analytics). `import-replenishment-plan.js` joinea la vista en su pasada bulk y
 * escribe estas tres columnas; las pantallas leen una columna indexada, cero joins.
 *
 * NO es una copia de un valor inventado: el origen es verificable en la primaria (la vista) y se
 * recomputa en cada corrida junto con `display_bf`, que sale del mismo resolvedor. Materializar por
 * costo es legítimo; materializar sin origen no lo es.
 *
 * DEGRADACIÓN SEGURA: hasta que el importer corra, las columnas son NULL y todo lector las trata
 * como "sin veredicto en contra" = medible → el comportamiento es el de hoy, nunca peor.
 *
 * Idempotente (hasColumn antes de addColumn).
 */
exports.up = async function up(knex) {
  const has = await knex.schema.withSchema('analytics').hasTable('replenishment_plan');
  if (!has) return;

  const cols = {
    // 'x1_inflada' | 'x2_deflactada' | NULL. Sólo los veredictos EN CONTRA se persisten: 'ok',
    // 'sin_dato' y 'z_no_arbitrable' se guardan como NULL a propósito, porque el lector pregunta
    // "¿hay algo que me impida valuar esto?" y la respuesta por defecto tiene que ser "no".
    rung_veredicto: (t) => t.text('rung_veredicto'),
    // El divisor que implica el costo pagado (caja_cost / pagado). Es la propuesta que la bandeja
    // HITL le pone enfrente al humano — NO se aplica sola.
    rung_bf_esperado: (t) => t.decimal('rung_bf_esperado', 14, 4),
    // La existencia valuada por lo PAGADO (unidad nativa × costo unitario de compra): la cifra de
    // referencia para revisar, que NO se publica como si estuviera verificada.
    rung_arbitrado: (t) => t.decimal('rung_arbitrado', 18, 2),
  };

  for (const [name, add] of Object.entries(cols)) {
    if (!(await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', name))) {
      await knex.schema.withSchema('analytics').alterTable('replenishment_plan', add);
    }
  }

  await knex.raw(`COMMENT ON COLUMN analytics.replenishment_plan.rung_veredicto IS
    'U.2 — peldaño CONTRADICHO por el costo de compra: x1_inflada (divisor chico, existencia se lee grande) / x2_deflactada (al revés) / NULL = sin veredicto en contra = se puede valuar. Copia por COSTO de analytics.v_unit_rung_audit (8-25 s), que sigue siendo la fuente auditable. Ver docs/UNIDADES_DE_MEDIDA.md §8quater.'`);

  // El filtro natural de todo lector es "¿tiene veredicto?" — que en 552 de 53,209 filas es SÍ.
  // Índice parcial: chico, y sirve para contar los marcados sin tocar la tabla completa.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rplan_rung
                    ON analytics.replenishment_plan (tenant_id, rung_veredicto)
                 WHERE rung_veredicto IS NOT NULL`);
};

exports.down = async function down(knex) {
  // No se borran columnas de un fact en prod sin pedirlo (regla del proyecto). Se retira sólo el
  // índice, que es lo único que esta migración crea de nuevo.
  await knex.raw('DROP INDEX IF EXISTS analytics.ix_rplan_rung');
};
