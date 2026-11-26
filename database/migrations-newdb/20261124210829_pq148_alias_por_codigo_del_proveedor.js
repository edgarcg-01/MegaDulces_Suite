'use strict';
/**
 * `[PQ.148]` — La equivalencia del proveedor se reconoce por SU CÓDIGO, no sólo por su descripción.
 *
 * `commercial.supplier_item_aliases` (`[RE.53]`) aprende «descripción del proveedor → nuestro SKU» al
 * dar por buena una factura. La descripción cambia de una factura a otra; el código del proveedor
 * (`NoIdentificacion` del CFDI) casi no. Esta migración le agrega ese código como segunda llave.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-24; anexo P §3) ────────────────────────────
 *  · 335 equivalencias de 43 proveedores, TODAS por descripción; por código, 0.
 *  · Los conceptos de CFDI traen `NoIdentificacion` en el 93 % (sin CL005, 60 días: 14,929 de
 *    16,035); de 8,776 pares (proveedor, código), 8,602 (98 %) tienen una sola descripción.
 *  · Aprendido de la historia: un código visto 2+ veces cae en el mismo SKU en 722 de 733 (98.5 %);
 *    al azar, 27 de 733.
 *
 * El código va como texto tal cual lo timbró el proveedor (`0012` no es `12`), en mayúsculas y sin
 * espacios de sobra (`normCodigo` en `conciliar-renglones.ts`). Nullable: las 335 filas de hoy no lo
 * tienen y se completan solas la próxima vez que su factura cuadre.
 *
 * Sólo crea una columna y un índice: no toca filas. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.supplier_item_aliases';
const INDICE = 'uq_supplier_item_alias_codigo';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = await knex.schema.withSchema('commercial').hasColumn('supplier_item_aliases', 'codigo_proveedor');
  if (!hay) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN codigo_proveedor text`);
  }
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.codigo_proveedor IS
    '[PQ.148] Código del producto según el proveedor (NoIdentificacion del CFDI), normalizado: mayúsculas, sin espacios de sobra, ceros a la izquierda intactos. Llave primera del emparejamiento; la descripción queda de segunda. NULL = aprendida antes de PQ.148 o sin código confiable.'`);
  // Un (proveedor, código) apunta a UNA equivalencia viva, igual que (proveedor, descripción).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE}
      ON ${TABLA} (tenant_id, proveedor_rfc, codigo_proveedor)
      WHERE codigo_proveedor IS NOT NULL AND deleted_at IS NULL`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.${INDICE}`);
  await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN IF EXISTS codigo_proveedor`);
};
