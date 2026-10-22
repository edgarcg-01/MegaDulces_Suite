'use strict';
/**
 * `[RA-NEG.1]` — **Los renglones de COMPRA de un producto, sin barrer medio millón.**
 *
 * ── El hallazgo ──────────────────────────────────────────────────────────────────────────────
 * El panel «Costo y negociación» de `/compras/pedido` lee lo pagado en 12 meses de UN producto:
 * los renglones `X-A-20` de `kepler_ods.kdm2` con ese SKU. La VENTA tiene su índice por producto
 * (`ix_kdm2_sku_venta`, `c2='U' AND c3='D'`) y el abono también (`ix_kdm2_sku_abono`); a la COMPRA
 * le falta — es el mismo olvido que `[RA-DYN.U4]` encontró para el folio (`ix_kdm2_compra_doc`).
 *
 * Medido contra prod el 2026-10-22: sin el índice, buscar los renglones de 70056 barre los
 * **513,973 renglones `X/A`** (de 5.55 M) y tarda **300–1,680 ms** según el caché. Es la mitad
 * del tiempo del panel; el resto ya está en milisegundos.
 *
 * ── Costo ────────────────────────────────────────────────────────────────────────────────────
 * Parcial sobre `c2='X' AND c3='A'`: ~514 mil filas, el 9.3 % de la tabla. El índice de venta
 * (`ix_kdm2_sku_venta`) cubre muchas más y pesa 358 MB; éste debería quedar en decenas de MB.
 *
 * ⛔ **VENTANA NOCTURNA O DE FIN DE SEMANA**, como su gemelo: `kepler_ods.kdm2` la escribe el CDC
 * cada minuto. `CONCURRENTLY` no bloquea escritores, pero hace dos pasadas y espera a que terminen
 * las transacciones viejas. No corre dentro de una transacción (`config.transaction = false`) y si
 * falla deja el índice INVÁLIDO: por eso se verifica `indisvalid`, no que exista.
 *
 * ⛔ Este commit **no cambia ningún número**: sólo agrega un índice. Sin él, el panel funciona igual
 * de correcto, sólo más lento (y con caché de una hora).
 */

const IX = 'ix_kdm2_compra_sku';

exports.config = { transaction: false };

exports.up = async function up(knex) {
  // La expresión va IGUAL que en la consulta (`btrim(l.c8) = ?`) y que en `ix_kdm2_sku_venta`:
  // un índice sobre `c8` crudo no le serviría a un predicado con `btrim`.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IX}
        ON kepler_ods.kdm2 (btrim(c8))
     WHERE c2 = 'X' AND c3 = 'A'`);

  await knex.raw(`
    COMMENT ON INDEX kepler_ods.${IX} IS
      '[RA-NEG.1] El gemelo de ix_kdm2_sku_venta para el lado de COMPRA. Sin el, leer lo pagado de '
      'un producto barre los ~514 mil renglones X/A: 300-1,680 ms medidos el 2026-10-22.'`);

  const { rows: [ix] } = await knex.raw(`
    SELECT i.indisvalid, i.indisready
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
     WHERE n.nspname = 'kepler_ods' AND c.relname = '${IX}'`);
  if (!ix) throw new Error(`[RA-NEG.1] ${IX} no se creó`);
  if (!ix.indisvalid || !ix.indisready) {
    throw new Error(
      `[RA-NEG.1] ${IX} quedó INVÁLIDO (indisvalid=${ix.indisvalid}, indisready=${ix.indisready}). ` +
      'El planificador no lo va a usar. Hay que borrarlo y repetir en una ventana sin carga.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IX}`);
};
