'use strict';
/**
 * [IC.1] La unidad del conteo, estampada en el item — y declarada cuando no se resuelve.
 *
 * El contador escribe un número. Ese número no significa nada sin su unidad, y en esta casa
 * la unidad es el problema caro: ADR-055/ADR-057 existen porque una columna de cantidad no
 * hereda su unidad de la fuente, hay que probarla. El caso canónico ya costó $866,805 de
 * sobre-pedido por dividir existencia y demanda con factores distintos.
 *
 * Hoy `inventory_count_items` guarda `expected_qty` y `count_1..3` **sin decir en qué unidad
 * están**. Mientras el teórico salía de la misma tabla que el ajuste daba igual; en cuanto el
 * teórico pasa a venir del ERP (IC.1), deja de dar igual — el ERP guarda en SU unidad base y
 * el contador cuenta lo que ve en el anaquel.
 *
 * Tres columnas, y la tercera es la que importa:
 *   · `unit_label`   — el rótulo que el ERP declara (PZA, PAQ, KG…). Informativo para el
 *                      contador: le dice qué está contando.
 *   · `unit_factor`  — unidades de la caja/presentación, cuando se puede resolver.
 *   · `unit_source`  — **de dónde salió, o NULL si no se pudo resolver.** Un NULL acá no es
 *                      "factor 1": es "no se sabe", y el consumidor tiene que tratarlo
 *                      distinto (ADR-056). Rellenar con 1 por default es exactamente el
 *                      "default plausible" que esta casa ya prohibió.
 *
 * Aditiva e idempotente. No toca ninguna fila existente: las que ya están quedan con los tres
 * campos en NULL, que es la verdad — se capturaron sin declarar unidad.
 */

exports.up = async function up(knex) {
  const tabla = 'inventory_count_items';
  const has = async (col) => knex.schema.withSchema('commercial').hasColumn(tabla, col);

  if (!(await has('unit_label'))) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      t.text('unit_label').nullable();
    });
  }
  if (!(await has('unit_factor'))) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      t.decimal('unit_factor', 14, 4).nullable();
    });
  }
  if (!(await has('unit_source'))) {
    await knex.schema.withSchema('commercial').alterTable(tabla, (t) => {
      t.text('unit_source').nullable();
    });
  }

  await knex.raw(`COMMENT ON COLUMN commercial.inventory_count_items.unit_source IS
    'IC.1 - De donde salio la unidad del renglon. NULL = NO SE PUDO RESOLVER, que NO es lo mismo que factor 1: un default plausible en una columna de unidad es el error que ADR-055/057 existen para impedir. El consumidor debe tratar el NULL como no-medido, no como uno.'`);

  await knex.raw(`COMMENT ON COLUMN commercial.inventory_count_items.unit_label IS
    'IC.1 - Rotulo de unidad que declara el ERP (PZA, PAQ, KG). Le dice al contador QUE esta contando; no se usa para convertir.'`);
};

exports.down = async function down(knex) {
  const tabla = 'inventory_count_items';
  const has = async (col) => knex.schema.withSchema('commercial').hasColumn(tabla, col);
  for (const col of ['unit_label', 'unit_factor', 'unit_source']) {
    if (await has(col)) {
      await knex.schema.withSchema('commercial').alterTable(tabla, (t) => { t.dropColumn(col); });
    }
  }
};
