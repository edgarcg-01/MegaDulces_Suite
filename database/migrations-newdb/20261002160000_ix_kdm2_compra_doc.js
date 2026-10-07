'use strict';
/**
 * `[RA-DYN.U4]` — **El índice que le falta al lado de COMPRA del ODS.**
 *
 * ── El hallazgo ──────────────────────────────────────────────────────────────────────────────
 * Nadie en este repo ha medido nunca el **cumplimiento del proveedor** (fill rate):
 * `catalog.suppliers.fill_rate_override` está en **0 de 1,318**. La explicación que se daba era
 * de modelo — "no está construido". Medido contra prod el 2026-10-02, no es de modelo: **es un
 * índice que no existe.**
 *
 * La cadena SÍ está completa. `analytics.erp_goods_receipts` trae `oc_folio` y `vale_folio` en
 * **10,240 de 12,713 recepciones (80.6%)** de los últimos 12 meses, y la comparación es válida:
 * sobre 2,932 pares (OC, vale) del mismo SKU, **2,932 vienen en la misma unidad (100%)** y sólo 3
 * difieren en factor de caja. O sea el fill rate es una resta de cantidades, sin resolver unidades.
 *
 * Lo que lo hacía incalculable es el costo de leer esos renglones:
 *
 *     UNA sola búsqueda de OC en kepler_ods.kdm2 ... 58,065 páginas (~453 MB) · 139 ms
 *     × ~19,500 búsquedas (9,750 OCs × OC + vale) ... ~45 minutos
 *
 * Por eso toda consulta de 90 días o más muere por `statement_timeout`, y por eso la pregunta
 * "¿me surtiste lo que te pedí?" nunca se pudo contestar.
 *
 * ── Por qué es tan caro, exactamente ─────────────────────────────────────────────────────────
 * `analytics.erp_purchase_doc_lines` une encabezado y renglón por
 * `(sucursal, c1, c2, c3, c4, c6)` — **sin `c5`**. Y la PK de `kdm2` es
 * `(sucursal, c1, c2, c3, c4, c5, c6)`: `c5` se interpone justo entre `c4` y `c6`, así que el
 * predicado del folio **no puede usarse** para el descenso del índice y el motor barre todo el
 * prefijo `(sucursal, c1, 'X', 'A', doctype)`.
 *
 * ⭐ Y el lado de VENTA sí tiene el suyo: `ix_kdm2_venta_doc` es exactamente este índice para
 * `c2='U' AND c3='D'`. El encabezado también: `idx_kdm1_xa_doc` cubre `kdm1` para `X/A`. **Al
 * renglón de compra se le olvidó** — es el único de los cuatro que falta.
 *
 * ── Costo ────────────────────────────────────────────────────────────────────────────────────
 * Parcial sobre `c2='X' AND c3='A'`: **496,024 filas, el 10.3%** de los 4.82 M de `kdm2`
 * (1,558 MB). El índice pesa decenas de MB, no cientos.
 *
 * ⛔ **VENTANA NOCTURNA O DE FIN DE SEMANA.** `kepler_ods.kdm2` la escribe el CDC cada minuto.
 * Va `CONCURRENTLY` —que no bloquea escritores— pero hace **dos pasadas** sobre la tabla y
 * además **espera a que terminen las transacciones viejas**: con el feed activo puede quedarse
 * esperando. Aplicarlo en horario hábil es pelearse con la ingesta.
 *
 * ⚠️ `CONCURRENTLY` **no corre dentro de una transacción** → `exports.config.transaction = false`.
 * Y si falla a mitad **deja el índice en estado INVÁLIDO**: existe, el planificador no lo usa, y
 * nada avisa. Por eso la verificación de abajo no pregunta si existe, sino si es **válido**.
 *
 * ── Qué desbloquea ───────────────────────────────────────────────────────────────────────────
 * El fill rate por proveedor, que es la herramienta que hoy le falta al comprador para sentarse
 * a negociar: medido en una muestra de 400 recepciones, **2,700 renglones pedidos, 86% surtidos
 * completos y 5.1% nunca surtidos**. Esa cifra, por proveedor, es la conversación.
 *
 * ⛔ Este commit **no cambia ningún número publicado**: sólo agrega un índice.
 */

const IX = 'ix_kdm2_compra_doc';

exports.config = { transaction: false };

exports.up = async function up(knex) {
  // Las columnas van CRUDAS, no con `btrim`: el join de `erp_purchase_doc_lines` compara
  // `l.c4 = h.c4` y `l.c6 = h.c6` tal cual, y un índice sobre la expresión no le serviría.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IX}
        ON kepler_ods.kdm2 (sucursal, c1, c4, c6)
     WHERE c2 = 'X' AND c3 = 'A'`);

  await knex.raw(`
    COMMENT ON INDEX kepler_ods.${IX} IS
      '[RA-DYN.U4] El gemelo de ix_kdm2_venta_doc para el lado de COMPRA. Sin el, una sola '
      'busqueda de OC barre 58,065 paginas y el fill rate del proveedor es incalculable: '
      'medido 2026-10-02, cualquier ventana de 90 dias muere por statement_timeout.'`);

  // ── Verificación: NO alcanza con que exista ──────────────────────────────────────────────
  // Un `CREATE INDEX CONCURRENTLY` que falla deja la fila en `pg_index` con `indisvalid = false`.
  // El índice se ve en `\d`, el planificador lo ignora, y la consulta sigue tardando 45 minutos
  // sin que nada lo diga.
  const { rows: [ix] } = await knex.raw(`
    SELECT i.indisvalid, i.indisready
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'kepler_ods' AND c.relname = '${IX}'`);
  if (!ix) throw new Error(`[RA-DYN.U4] ${IX} no se creó`);
  if (!ix.indisvalid || !ix.indisready) {
    throw new Error(
      `[RA-DYN.U4] ${IX} quedó INVÁLIDO (indisvalid=${ix.indisvalid}, indisready=${ix.indisready}). ` +
      'El planificador no lo va a usar. Hay que borrarlo y repetir en una ventana sin carga.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IX}`);
};
