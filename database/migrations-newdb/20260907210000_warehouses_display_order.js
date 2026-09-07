/**
 * El almacén `00` deja de llamarse "Cedis Oficinas", y los almacenes ganan ORDEN de despliegue.
 *
 * ── 1. El nombre mentía, la fuente no ──────────────────────────────────────────────────────
 * `commercial.warehouses` code `00` se llamaba **"Cedis Oficinas"**, que junta dos cosas que el
 * proyecto ya había separado (ERP_KEPLER §2.3): la sucursal Kepler `00` es **OFICINAS** (cero
 * líneas de mostrador U-D-10) y el **CEDIS real es BPIRAPUATO, que vive en WINCAJA**.
 *
 * Medido en prod antes de tocar: la fila `00` tiene `kepler_code = NULL` y
 * `wincaja_source_branch = '00'`, y `wincaja.branches` dice de esa rama `branch_name = 'BPIRAPUATO'`,
 * `mdb_file = '0 BPIRAPUATO MOV.MDB'`, nota *"CEDIS/bodegon Irapuato"*. O sea que desde la mig
 * 20260902170000 la EXISTENCIA de ese renglón ya sale del CEDIS verdadero, no de oficinas:
 * 201 SKUs con existencia, 183,213 unidades base, $6,481,431 a costo promedio, última venta
 * 2026-09-04 (contraste: MD-30 3,363 SKUs / $19.0M).
 *
 * O sea: la fuente estaba bien y el rótulo estaba mal — y el rótulo es lo que el operador lee en
 * la cabecera de `/almacen/existencia`. Se corrige el nombre, NO la fuente.
 *
 * Sólo escribe donde el nombre sigue siendo el viejo, así que una edición manual posterior no se
 * pisa. El `code` NO se toca: hay ~11 importers y 5 vistas que unen por él.
 *
 * ⚠️ Lo que este cambio NO arregla, y se declara: la mig 20260829130000 le puso a este almacén
 * `zone_id` = zona **OFICINAS**, que con el nombre nuevo queda incoherente. No se toca acá porque
 * `zone_id` alimenta el ALCANCE por zona (Fase ID) y moverlo cambiaría quién ve qué — es una
 * decisión de permisos, no de rótulo.
 *
 * ── 2. El orden de las columnas no era el del negocio ──────────────────────────────────────
 * `ExistenciaService.columns()` ordenaba por `w.code`, o sea alfabético: 00, 01, 02, 03, 04, 05,
 * 06, MD-30, MD-32. Eso pone el CEDIS PRIMERO y separa las dos Morelia del resto por venir de
 * Wincaja (prefijo MD-) — un artefacto de cómo se codificó la fuente, no de cómo se opera.
 *
 * El orden que pidió Edgar (2026-09-07) es el de la red real:
 *   PH · MA · MM · 8ES · LPA · YU · CAN · DAMASO · CEDIS (BPIRAPUATO)
 *
 * `DAMASO = Zamora Centro (05)` confirmado por Edgar en la misma conversación (es como se le
 * nombra en piso; `wincaja.branches` la trae como 'ZAMORA CENTRO' rama 54 → kepler_code 05).
 *
 * Va como COLUMNA en la tabla principal, no como lista en un servicio: el orden es un atributo del
 * almacén y lo tienen que poder leer todos los consumidores. `short_label` es el rótulo corto con
 * el que Edgar los nombra, para que la cabecera diga lo mismo que él dice.
 *
 * Los que no están en la lista (las 13 RUTA-*) quedan en NULL → van al final por `NULLS LAST` y
 * entre ellos por código. Un almacén nuevo aparece igual, al final, sin tocar código.
 *
 * @param { import("knex").Knex } knex
 */
const ORDEN = [
  // [code, display_order, short_label]
  ['01',    1, 'PH'],
  ['MD-30', 2, 'MA'],
  ['MD-32', 3, 'MM'],
  ['03',    4, '8ES'],
  ['02',    5, 'LPA'],
  ['04',    6, 'YU'],
  ['06',    7, 'CAN'],
  ['05',    8, 'DAMASO'],
  ['00',    9, 'CEDIS'],
];

exports.up = async function up(knex) {
  const hasOrder = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'display_order');
  const hasLabel = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'short_label');
  if (!hasOrder || !hasLabel) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      if (!hasOrder) t.smallint('display_order').nullable();
      if (!hasLabel) t.text('short_label').nullable();
    });
  }

  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.display_order IS
    'Orden de despliegue de la red (1..N). NULL = sin orden asignado, va al final (NULLS LAST) y entre ellos por code. NO es jerarquia de abasto: eso es source_warehouse_id.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.short_label IS
    'Rotulo corto con el que se nombra el almacen en piso (PH, MA, MM, 8ES, LPA, YU, CAN, DAMASO, CEDIS). NULL => el consumidor cae al code.'`);

  for (const [code, ord, label] of ORDEN) {
    const r = await knex.raw(
      `UPDATE commercial.warehouses
          SET display_order = ?, short_label = ?, updated_at = now()
        WHERE code = ? AND deleted_at IS NULL
          AND (display_order IS DISTINCT FROM ? OR short_label IS DISTINCT FROM ?)`,
      [ord, label, code, ord, label],
    );
    if (r.rowCount) console.log(`  ${code} -> #${ord} ${label}`);
  }

  // El nombre honesto del CEDIS. Sólo donde sigue el viejo.
  const ren = await knex.raw(
    `UPDATE commercial.warehouses
        SET name = 'CEDIS BPIRAPUATO', updated_at = now()
      WHERE code = '00' AND deleted_at IS NULL AND name = 'Cedis Oficinas'`,
  );
  if (ren.rowCount) console.log("  00 renombrado: 'Cedis Oficinas' -> 'CEDIS BPIRAPUATO'");

  // Auto-verificación: los 9 almacenes de la red tienen que quedar ordenados y ninguno repetido.
  const chk = (await knex.raw(`
    SELECT count(*)::int AS con_orden,
           count(DISTINCT display_order)::int AS ordenes_distintos
      FROM commercial.warehouses
     WHERE deleted_at IS NULL AND display_order IS NOT NULL`)).rows[0];
  console.log(`  con_orden=${chk.con_orden} ordenes_distintos=${chk.ordenes_distintos}`);
  if (chk.con_orden !== chk.ordenes_distintos) {
    throw new Error(`hay ordenes repetidos: ${chk.con_orden} filas con ${chk.ordenes_distintos} valores`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`UPDATE commercial.warehouses SET display_order = NULL, short_label = NULL
                   WHERE display_order IS NOT NULL OR short_label IS NOT NULL`);
  // El nombre NO se revierte: "Cedis Oficinas" era el dato incorrecto.
};
