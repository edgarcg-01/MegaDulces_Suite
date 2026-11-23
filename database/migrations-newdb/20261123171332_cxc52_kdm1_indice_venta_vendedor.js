'use strict';
/**
 * `[CXC.52.1]` — El índice de la venta por vendedor de Cartera (`/finance/receivables/venta-vendedor`).
 *
 * Edgar eligió (2026-11-23) la venta EXACTA —lo facturado, `kdm1.c16`— sobre la de `mv_kepler_sales_daily`, que es
 * rápida pero suma antes del descuento de documento (+0.5 % en total, hasta +2 % por vendedor) y llega hasta ayer.
 * La exacta lee `kdm1` por cabecera, y con periodos largos no cabe en 500 ms.
 *
 * ── Lo medido antes (sólo lectura, pg-prod, 2026-11-23, todo en caché) ────────────────────────────────────────
 *  · 30 días: 0.29 s · 3 meses: 0.72–0.89 s · un año: ~3 s.
 *  · El plan: `Index Scan using ix_kdm1_venta_fecha` → 291,488 filas en 470 ms (filtros sobre la fila de la tabla)
 *    + ordenarlas 150 ms. 47,138 páginas tocadas, todas en caché: el costo es visitar la TABLA por cada documento.
 *  · `kdm1`: 87,430 páginas, 56.2 % marcadas «todo visible».
 *
 * Qué hace: un índice parcial (sólo venta `U-D`) sobre la fecha del documento que TRAE las columnas que la consulta
 * lee (`INCLUDE`), para que Postgres pueda contestar desde el índice sin ir a la tabla en las páginas «todo visible».
 * ⚠️ Con el 56 % visible la ganancia no está garantizada: se MIDE al aplicarla (3 meses y un año, antes y después)
 * y se anota en el tracker. Si no baja de 500 ms, lo siguiente es un agregado diario por vendedor, no otro índice.
 *
 * `c9` va también en el INCLUDE: el índice es por la EXPRESIÓN `c9::date`, y para un index-only scan Postgres
 * necesita la columna misma (la consulta la usa en el filtro). `c2`/`c3` no hacen falta: los cubre el WHERE parcial.
 *
 * ⚠️ `CONCURRENTLY`, y por eso `transaction: false`: `kdm1` la reescribe el carril cada 2 s y un `CREATE INDEX`
 * normal la bloquearía. ⛔ Fuera de horario hábil, y con la receta de la skill `entrega` §5 (crearlo con
 * `lock_timeout` amplio FUERA del aplicador; esta migración lo encuentra hecho y registra el ledger).
 * ⚠️ Un `CONCURRENTLY` interrumpido deja el índice INVALID: si falla a mitad, mirar `pg_index.indisvalid`, borrarlo
 * con `DROP INDEX CONCURRENTLY` y repetir — volver a correr la migración no basta.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_venta_vendedor
      ON kepler_ods.kdm1 (((c9)::date))
      INCLUDE (sucursal, c1, c4, c9, c12, c16, c43)
      WHERE c2 = 'U' AND c3 = 'D'
  `);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_venta_vendedor`);
};
