'use strict';
/**
 * `[RD.29]` — **El tope de inventario de cada camión.**
 *
 * Pedido de Edgar: *«saber si tiene más de 40 mil, o una meta variable de inventario, para que
 * nunca sobrepasen ese total»*. Un camión que acumula es capital parado arriba de una camioneta
 * y mercancía que no está en el anaquel de nadie.
 *
 * ── Dónde vive, y por qué acá ─────────────────────────────────────────────────────────────
 *
 * ⛔ **No se crea una tabla de umbrales.** Ya hay tres en el repo y el proyecto lleva la cuenta:
 * `CRON_JOBS` (frescura de feeds), `commercial.execution_thresholds` (una fila por tenant con
 * el umbral como columna) y `analytics.kpi_thresholds` (`[CDRP.2]`, el registro bueno). Ninguna
 * sirve acá: las dos primeras no tienen el grano y la tercera lo tiene por **(kpi, puesto,
 * periodo)** — por puesto, no por camión.
 *
 * ⭐ El tope es un **atributo del camión**, igual que su `kepler_code` o su `source_warehouse_id`,
 * que esta misma fase ya le puso a `commercial.warehouses`. Extender la tabla que ya lo describe
 * es lo que manda la regla, y deja la meta editable desde donde se administran los almacenes.
 *
 * ── El valor ──────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **$40,000 lo puso el negocio, no una medición.** Se siembra como punto de partida y queda
 * declarado como tal. Medido para que el número signifique algo: hoy los camiones traen entre
 * **$17,333 y $53,171** al costo, así que 40,000 separa a los que vale la pena mirar — no es un
 * techo inalcanzable ni uno que todos crucen.
 *
 * `NULL` significa **sin tope declarado**, y la pantalla lo dice así: no se asume un default
 * escondido ni se dibuja un verde (ADR-056).
 */

exports.up = async function up(knex) {
  const tiene = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'inventory_max_mxn');
  if (!tiene) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.decimal('inventory_max_mxn', 14, 2).nullable();
    });
  }
  await knex.raw(`
    COMMENT ON COLUMN commercial.warehouses.inventory_max_mxn IS $$[RD.29] Tope de inventario del
    camion, en pesos AL COSTO. NULL = sin tope declarado (la pantalla lo dice, no asume default).
    Semilla 40000 puesta por el negocio, no medida: los camiones traen hoy entre 17,333 y 53,171.$$`);

  // Semilla SOLO para los camiones que hoy tienen ruta (kind='truck' con codigo de Kepler), y
  // solo donde nadie puso un valor: re-correr la migracion no pisa lo que alguien haya ajustado.
  const { rowCount } = await knex('commercial.warehouses')
    .where({ kind: 'truck' })
    .whereNull('deleted_at')
    .whereNotNull('kepler_code')
    .whereNull('inventory_max_mxn')
    .update({ inventory_max_mxn: 40000, updated_at: knex.fn.now() });
  console.log(`  · [RD.29] tope de 40,000 sembrado en ${rowCount} camion(es)`);
};

exports.down = async function down(knex) {
  const tiene = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'inventory_max_mxn');
  if (tiene) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.dropColumn('inventory_max_mxn');
    });
  }
};
