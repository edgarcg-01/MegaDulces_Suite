'use strict';
/**
 * `[NP.8]` **Productos nuevos en vivo** — el índice que deja traer las entradas de HOY.
 *
 * `analytics.mv_new_products` guarda la historia CERRADA; lo de hoy (venta en tienda y entradas)
 * lo trae en cada consulta `analytics.fn_new_products_movimientos`, creada junto con la matvista
 * (mig `20261007360000`, que la usa también para su historia). La existencia ya es en vivo por sí
 * sola (`v_erp_stock_on_hand`).
 *
 * Las entradas de hoy no tenían por dónde entrar: `ix_kdm1_venta_fecha` es parcial a ventas
 * (`c2='U' AND c3='D'`) y sobre compras no había índice por fecha, así que pedir "las entradas
 * de hoy" recorría `kdm1` entero. Se crea el gemelo parcial a compras. Un índice no es una
 * copia (regla principal): no duplica el dato ni introduce rezago. CONCURRENTLY porque el carril
 * del ODS escribe en esta tabla cada minuto — y por eso esta migración va aparte y sin
 * transacción.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_compra_fecha
        ON kepler_ods.kdm1 (((c9)::date))
     WHERE c2 = 'X' AND c3 = 'A'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_compra_fecha');
};
