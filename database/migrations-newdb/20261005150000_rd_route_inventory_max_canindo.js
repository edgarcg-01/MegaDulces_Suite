'use strict';
/**
 * `[RD.29.1]` — **El tope también para las rutas de Canindo.**
 *
 * `[RD.29]` sembró el tope filtrando por `kind='truck' AND kepler_code IS NOT NULL`, y eso dejó
 * fuera a las cinco rutas de Canindo (501-505): esta fase sólo le puso `kepler_code` a los seis
 * camiones de Padre Hidalgo, porque son los únicos cuyo embarque se identifica por almacén de
 * Kepler. Las de Canindo se resuelven por otro camino y quedaron con el tope en `NULL`.
 *
 * ⛔ **Y justo ahí estaba lo que el tope existe para encontrar:** medido al aplicar, la 504 trae
 * **$59,892** y la 501 **$53,171** — las dos más cargadas de las once, las dos sin tope.
 *
 * ⭐ El filtro correcto no es una propiedad del almacén sino **estar en la vista de identidad de
 * rutas**: esa es la definición de «ruta que esta pantalla mide», y es la misma que usa el
 * ledger. Filtrar por un atributo que sólo tiene la mitad del universo fue el error.
 *
 * Idempotente y no destructivo: sólo toca las filas que siguen en `NULL`.
 */

exports.up = async function up(knex) {
  const actualizadas = await knex('commercial.warehouses as w')
    .whereNull('w.inventory_max_mxn')
    .whereNull('w.deleted_at')
    .whereIn('w.id', knex('analytics.mv_rd_route_identity').select('warehouse_id'))
    .update({ inventory_max_mxn: 40000, updated_at: knex.fn.now() });
  console.log(`  · [RD.29.1] tope sembrado en ${actualizadas} ruta(s) que faltaban`);

  const { rows } = await knex.raw(`
    SELECT count(*) FILTER (WHERE w.inventory_max_mxn IS NOT NULL)::int AS con_tope,
           count(*)::int AS total
      FROM analytics.mv_rd_route_identity i
      JOIN commercial.warehouses w ON w.id = i.warehouse_id AND w.deleted_at IS NULL`);
  const { con_tope: conTope, total } = rows[0];
  console.log(`  · [RD.29.1] cobertura: ${conTope} de ${total} rutas con tope declarado`);
  // Un freno, no un adorno: si el sembrado no cubrió a todas, la pantalla publicaría un guion
  // en rutas que sí deberían tener tope y nadie se enteraría.
  if (Number(conTope) !== Number(total)) {
    throw new Error(`[RD.29.1] quedaron ${total - conTope} rutas sin tope: revisar antes de seguir`);
  }
};

exports.down = async function down() {
  // No se revierte: quitar el tope dejaría a las rutas sin techo declarado, que es peor que
  // tenerlo. La columna la retira la migración que la creó.
};
