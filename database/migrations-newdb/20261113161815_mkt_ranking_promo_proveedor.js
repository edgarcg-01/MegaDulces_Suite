'use strict';
/**
 * `[MKT.24]` — El PROVEEDOR de cada promoción del ranking, ASIGNADO por Mercadotecnia, para poder
 * filtrar el ranking por proveedor. El código de la promoción en Kepler no lo trae; el producto que
 * la activa sí, en poco más de la mitad: ése se DERIVA en vivo (no se guarda) y esta columna guarda
 * sólo lo que una persona decide — para el resto, o para corregir el derivado.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-13) ────────────────────────────────────────
 *  · Ficha del código (`catalog.products.supplier_id`, = `kdii.c3`): de 356 códigos de promoción,
 *    207 dicen «PROMOCIONES MKT» (un proveedor cubeta) y 123 no tienen.
 *  · Marca: «PROMOCIONES», «PRODUCTOS VARIOS», «POR CLASIFICAR». No lleva al proveedor.
 *  · Compras (`X-A-20`, `kdm1.c10`): de 114 promociones vendidas en 5 semanas, 103 entraron por
 *    compra y las 103 a nombre del MISMO acreedor (una cubeta interna); 11 sin compra.
 *  · Producto que la activa (`[MKT.15]`, ticket + nombre): de 108 promos de 5 semanas, 57 con un solo
 *    proveedor, confirmado por el nombre (VOLT → AJEMEX, Kisses → Hershey); 5 con varios; 46 sin
 *    producto identificado. Ésas son las que necesitan esta columna.
 *
 * Columna NULLABLE en una tabla con 0 filas en prod: ningún camino de inserción se rompe (regla 14).
 * La llave foránea usa el par (tenant_id, id) como `catalog.products`; si el proveedor se borra,
 * la promo queda «sin proveedor» (ON DELETE SET NULL sólo de esa columna, PG15+).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasColumn('mkt_ranking_promos', 'supplier_id'))) {
    await knex.raw(`ALTER TABLE commercial.mkt_ranking_promos ADD COLUMN supplier_id uuid`);
  }
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_ranking_promos_supplier_fk') THEN
        ALTER TABLE commercial.mkt_ranking_promos
          ADD CONSTRAINT mkt_ranking_promos_supplier_fk FOREIGN KEY (tenant_id, supplier_id)
          REFERENCES catalog.suppliers (tenant_id, id) ON DELETE SET NULL (supplier_id);
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON COLUMN commercial.mkt_ranking_promos.supplier_id IS
    '[MKT.24] Proveedor de la promoción, asignado por Mercadotecnia (Kepler sólo trae la cubeta PROMOCIONES MKT). NULL = sin asignar.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.mkt_ranking_promos DROP CONSTRAINT IF EXISTS mkt_ranking_promos_supplier_fk`);
  if (await knex.schema.withSchema('commercial').hasColumn('mkt_ranking_promos', 'supplier_id')) {
    await knex.raw(`ALTER TABLE commercial.mkt_ranking_promos DROP COLUMN supplier_id`);
  }
};
