'use strict';
/**
 * `[RA-FIX.1]` — **El renglón de COMPRA guarda la sucursal que necesita la mercancía.**
 *
 * ── Qué estaba roto, medido en prod el 2026-10-19 ───────────────────────────────────────────
 *
 * `/compras/pedido` captura el pedido **por sucursal** (el desglose), pero la línea no tenía
 * dónde anotar de cuál era: `source_warehouse_id` se usa para el ORIGEN de un traspaso y en las
 * de compra va NULL — **0 de 3,728**, contra **3,268 de 3,268** en las de traspaso. Así que el
 * desglose se guardaba como **N renglones del mismo SKU que sólo se distinguen por `on_hand`**:
 *
 * | | |
 * |---|---:|
 * | grupos (requisición × producto) con más de un renglón | **473** |
 * | renglones de más | **1,269** |
 * | requisiciones afectadas | **74**, todas `source_type='supplier'` |
 *
 * Caso real: `RQ-2026-00913` trae el SKU `88045` **nueve veces** (100, 68, 100, 200, 3, 5, 10,
 * 50, 10 cajas), las nueve con origen NULL. Nadie puede decir a qué sucursal iba cada una.
 *
 * ⭐ **Y de ahí cuelga el resto.** El empuje a Kepler consolida por SKU justificándose en que
 * *"el desglose ya estaba perdido"* — era cierto, y era el síntoma. Cuadrar la requisición
 * contra la OC por sucursal tampoco se podía.
 *
 * ── Por qué una columna NUEVA y no reusar `source_warehouse_id` ──────────────────────────────
 *
 * ⛔ Porque significan cosas distintas y meterlas en la misma columna es el parche que esto
 * viene a quitar: en un traspaso `source_warehouse_id` es **de dónde SALE**; acá hace falta
 * **quién la NECESITA**. En una compra consolidada el encabezado dice dónde ENTREGA el
 * proveedor (el CEDIS) y el renglón tiene que decir la sucursal destino — son dos almacenes
 * distintos en la misma fila.
 *
 * ── Qué NO hace, y se declara ────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Nace NULLABLE y sin backfill.** Los 1,269 renglones ya escritos **no se pueden** reponer:
 * la sucursal de cada uno es justo el dato que nunca se guardó, y repartirlos por `on_hand`
 * sería fabricar una liga que nadie verificó — en la columna que después va a decir "esto iba a
 * tal sucursal". Se DECLARA el hueco (ADR-056) y se llena hacia adelante.
 *
 * ⚠️ Sin esta migración aplicada, la API sigue funcionando igual: `insertRequisition` comprueba
 * la columna antes de escribirla. Lo que falta entonces es el dato nuevo, no el servicio.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const tiene = await knex.schema
    .withSchema('commercial')
    .hasColumn('purchase_requisition_lines', 'destination_warehouse_id');

  if (!tiene) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisition_lines', (t) => {
      t.uuid('destination_warehouse_id');
    });
  }

  // Misma forma que la FK del origen (`fk_purchase_requisition_lines_src_wh`): por
  // (tenant_id, id) y RESTRICT — un almacén con renglones vivos no se borra de abajo.
  await knex.raw(`ALTER TABLE commercial.purchase_requisition_lines
                    DROP CONSTRAINT IF EXISTS fk_purch_req_lines_dest_wh`);
  await knex.raw(`
    ALTER TABLE commercial.purchase_requisition_lines
      ADD CONSTRAINT fk_purch_req_lines_dest_wh
      FOREIGN KEY (tenant_id, destination_warehouse_id)
      REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT`);

  // Para "qué se le pidió a esta sucursal" sin recorrer la tabla entera. Parcial: lo que no
  // tiene destino no compite por el índice.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_purch_req_lines_dest_wh
      ON commercial.purchase_requisition_lines (tenant_id, destination_warehouse_id)
      WHERE destination_warehouse_id IS NOT NULL`);

  await knex.raw(`
    COMMENT ON COLUMN commercial.purchase_requisition_lines.destination_warehouse_id IS
      'RA-FIX.1 - la sucursal que NECESITA esta cantidad. En una compra consolidada el '
      'encabezado dice donde ENTREGA el proveedor (el CEDIS) y esta columna la sucursal '
      'destino: son dos almacenes distintos en la misma fila. NO es source_warehouse_id, '
      'que es el ORIGEN de un traspaso. NULL = renglon anterior a 2026-10-19, cuando el '
      'desglose no se guardaba; no se infiere hacia atras.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_purch_req_lines_dest_wh`);
  await knex.raw(`ALTER TABLE commercial.purchase_requisition_lines
                    DROP CONSTRAINT IF EXISTS fk_purch_req_lines_dest_wh`);
  const tiene = await knex.schema
    .withSchema('commercial')
    .hasColumn('purchase_requisition_lines', 'destination_warehouse_id');
  if (tiene) {
    await knex.schema.withSchema('commercial').alterTable('purchase_requisition_lines', (t) => {
      t.dropColumn('destination_warehouse_id');
    });
  }
};
