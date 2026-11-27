'use strict';
/**
 * `[ICR.M3]` — **La CAPTURA pasa a ser la unidad real del conteo.**
 *
 * Hasta hoy el renglón del folio guardaba **un número por producto** (`count_1`, `count_2`,
 * `count_3`) y `commercial.inventory_count_scan_log` sólo guardaba **quién y cuándo**. De ahí
 * salen dos defectos medidos:
 *
 *  · **F35** — el mismo producto en **dos racks se pierde**: el segundo que lo encuentra recibía
 *    «ya tiene un primer conteo de otra persona» y esa mercancía salía como faltante. En una
 *    distribuidora de dulces, producto en anaquel **y** en bodega es lo normal.
 *  · **F34** — la bitácora existe y **no guarda ni la cantidad ni el lugar**, así que el
 *    supervisor no puede auditar nada en vivo.
 *
 * A partir de acá la identidad de una captura es **(renglón, rack, persona, vuelta)**:
 * misma persona en el mismo rack **corrige**; otro rack u otra persona **suma**. `count_N` sigue
 * existiendo, sigue viviendo en la unidad del teórico y sigue siendo lo que se compara contra
 * `expected_qty` — pero pasa a ser **derivado**: la SUMA de las capturas vivas de esa vuelta.
 *
 * ── Lo medido antes, en pg-prod, sólo lectura (2026-11-27, `system_identifier` 7688376744939610156)
 *
 *  · `commercial.inventory_count_scan_log`: **11 filas**, todas `slot='count_1'`, **ninguna**
 *    con cantidad ni rack (las columnas no existían).
 *  · **8** folios en total (⚠️ el anexo dice 7): 7 `cancelled` y **`INV-2026-00011` en
 *    `counting`**, abierto el 2026-11-27 con 6 renglones.
 *  · Renglones con conteo: **10** con `count_1`, **0** con `count_2`, **0** con `count_3`.
 *  · 6 de las 11 filas de la bitácora son del MISMO renglón (`cbb5ca19…`, `count_1 = 91`):
 *    recapturas, no mercancía distinta. Por eso el backfill **no** las convierte en capturas
 *    (inventaría 6 × 91): se sintetiza **una** captura por `(renglón, slot)` con el valor que
 *    hoy tiene `count_N`, y las 11 viejas quedan con cantidad NULL — fuera de la suma, visibles
 *    como lo que son: bitácora sin cantidad.
 *
 * ── Por qué sin tabla nueva y sin UPDATE
 *
 * Es la decisión **D7** del plan resuelta por el lado barato (§4.5 del anexo). La tabla sigue
 * siendo **append-only** (`GRANT` sólo `SELECT, INSERT`): una corrección **no pisa** la fila
 * anterior, escribe otra; la viva de cada identidad es **la más reciente**. Así la bitácora
 * conserva el rastro completo —que es lo que F34 pedía— sin pedir `UPDATE` ni `DELETE` para
 * `app_runtime`.
 *
 * ⚠️ Esta migración **sólo agrega columnas nullable, un índice y un backfill acotado a 10 filas**:
 * no cambia ni una fila de `inventory_count_items`, así que ningún `count_N` se mueve. La prueba
 * del antes/después vive en `inventory-count.captura-por-rack.spec.ts`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'inventory_count_scan_log';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable(TABLA))) {
    // La tabla la crea `20260619180000_inventory_count_scan_log.js`. Si no está, no hay nada
    // que extender y esta migración no debe inventarla: se registra y se sale.
    return;
  }

  // ⚠️ Los `hasColumn` se resuelven ANTES del `alterTable`: el callback de knex se ejecuta
  // de forma SÍNCRONA para armar el DDL, así que un callback `async` haría que el builder
  // saliera vacío y la migración «pasara» sin agregar ni una columna.
  const falta = {};
  for (const col of ['quantity', 'quantity_native', 'unit', 'unit_factor', 'aisle_id']) {
    falta[col] = !(await knex.schema.withSchema('commercial').hasColumn(TABLA, col));
  }

  if (Object.values(falta).some(Boolean)) {
    await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => {
      // La cantidad TAL COMO LA TECLEÓ la persona, en la unidad que declaró. Es el testigo de
      // lo que pasó, no lo que se suma.
      if (falta.quantity) t.decimal('quantity', 14, 3);
      // ⭐ La cantidad ya NORMALIZADA a la unidad nativa (la misma de `expected_qty`). **Ésta
      // es la que se suma.** NULL = captura sin cantidad conocida (las 11 filas viejas) →
      // fuera de la suma. Un NULL no se rellena con cero: un cero medido y un cero inventado
      // no se distinguirían.
      if (falta.quantity_native) t.decimal('quantity_native', 14, 3);
      // El testigo de la conversión, igual que en el renglón (`count_N_unit`/`count_N_factor`).
      if (falta.unit) t.string('unit', 16);
      if (falta.unit_factor) t.decimal('unit_factor', 14, 6);
      // ⭐ El RACK donde se capturó. Nullable a propósito: hoy casi ningún almacén tiene
      // pasillos dados de alta (Yurécuaro tiene **0**), y NULL es el montón «sin rack», que
      // es un rack más.
      if (falta.aisle_id) t.uuid('aisle_id');
    });
  }

  await knex.raw(
    `COMMENT ON COLUMN commercial.${TABLA}.quantity IS '[ICR.M3] Cantidad tal como la tecleó la persona, en la unidad que declaró (columna unit). Testigo, NO es lo que se suma.'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN commercial.${TABLA}.quantity_native IS '[ICR.M3] Cantidad normalizada a la unidad NATIVA (la de expected_qty). Es la que se SUMA para formar count_N. NULL = captura sin cantidad (filas anteriores a ICR.M3): queda fuera de la suma.'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN commercial.${TABLA}.unit IS '[ICR.M3] Unidad declarada por la persona (PAQ, CJA, PZA...). NULL = no declaró.'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN commercial.${TABLA}.unit_factor IS '[ICR.M3] Unidades nativas por cada una de la declarada. quantity * unit_factor = quantity_native.'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN commercial.${TABLA}.aisle_id IS '[ICR.M3] Rack donde se capturó. NULL = el montón «sin rack». Junto con (count_id, item_id, slot, applied_by) forma la IDENTIDAD de la captura: misma identidad = corrección (gana la más reciente), identidad distinta = suma.'`,
  );
  await knex.raw(
    `COMMENT ON TABLE commercial.${TABLA} IS '[ICR.M3] La CAPTURA es la unidad del conteo: (count_id, item_id, slot, aisle_id, applied_by) la identifica y gana la applied_at más reciente; count_N del renglón es la SUMA de las capturas vivas de esa vuelta. Sigue siendo el idempotency store del conteo offline (scan_uuid) y sigue siendo append-only: una corrección escribe otra fila, no pisa la anterior.'`,
  );

  // El índice que vuelve barata la recomposición: `submitCount` lee TODAS las capturas de UN
  // renglón en cada escaneo. Sin esto es un seq scan de la bitácora entera del folio.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_commercial_inv_scanlog_item
       ON commercial.${TABLA} (tenant_id, count_id, item_id)`,
  );

  // ── Backfill: que el invariante «count_N = suma de sus capturas vivas» valga desde el día 1 ──
  //
  // Sin esto, el primer escaneo que llegue a un renglón ya contado recompondría `count_N` a
  // partir de cero capturas y **borraría** lo que esa persona ya había contado. Medido: son
  // 10 renglones en toda la base, los 10 con `count_1`.
  //
  // ⚠️ `applied_at` se toma de `counted_at_N` para que el orden «la más reciente gana» respete
  // el reloj real: una captura nueva de esa misma identidad llegará después y corregirá.
  for (const n of [1, 2, 3]) {
    await knex.raw(
      `INSERT INTO commercial.${TABLA}
         (tenant_id, count_id, scan_uuid, item_id, slot, applied_by, applied_at,
          quantity, quantity_native, unit, unit_factor, aisle_id)
       SELECT i.tenant_id, i.count_id, gen_random_uuid(), i.id, 'count_${n}',
              i.counted_by_${n}, COALESCE(i.counted_at_${n}, i.updated_at, now()),
              NULL, i.count_${n}, i.count_${n}_unit, i.count_${n}_factor, i.aisle_id
         FROM commercial.inventory_count_items i
        WHERE i.count_${n} IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM commercial.${TABLA} l
                 WHERE l.tenant_id = i.tenant_id
                   AND l.count_id = i.count_id
                   AND l.item_id = i.id
                   AND l.slot = 'count_${n}'
                   AND l.quantity_native IS NOT NULL)`,
    );
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  // Las capturas sintéticas del backfill se reconocen por tener `quantity_native` y no tener
  // `quantity` (una captura real siempre guarda las dos). Se borran primero: si no, al quitar
  // las columnas quedarían filas de bitácora sin cantidad que nadie sabría de dónde salieron.
  const tiene = await knex.schema
    .withSchema('commercial')
    .hasColumn(TABLA, 'quantity_native');
  if (tiene) {
    await knex.raw(
      `DELETE FROM commercial.${TABLA}
        WHERE quantity_native IS NOT NULL AND quantity IS NULL`,
    );
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commercial_inv_scanlog_item`);
  for (const col of ['aisle_id', 'unit_factor', 'unit', 'quantity_native', 'quantity']) {
    if (await knex.schema.withSchema('commercial').hasColumn(TABLA, col)) {
      await knex.schema.withSchema('commercial').alterTable(TABLA, (t) => t.dropColumn(col));
    }
  }
};
